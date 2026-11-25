import ts from "typescript";
import { compactInputType } from "./compact-schema.js";

// the renderer stops near its 4,000-character budget
const MAX_INPUT_TYPE_CHARS = 4_500;
// no summary is longer, whatever the schema
const HARD_MAX_CHARS = 5_000;

// an array that counts how many of its entries the renderer reads
function counted<T>(entries: T[]): { list: T[]; reads: () => number } {
  let reads = 0;
  const list = new Proxy(entries, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads: () => reads };
}

function expectTypeSyntax(inputType: string): void {
  const { diagnostics = [] } = ts.transpileModule(`type T = ${inputType};`, {
    reportDiagnostics: true,
  });
  expect(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
  ).toEqual([]);
}

describe("compact input type", () => {
  it("renders requiredness, types, descriptions and enums of a simple schema", () => {
    expect(
      compactInputType({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          id: { type: "string", description: "Page id" },
          mode: {
            type: "string",
            enum: ["raw", "html"],
            default: "raw",
            title: "Mode",
          },
          verbose: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      }),
    ).toEqual({
      inputType:
        '{ /** Page id */ id: string; mode?: "raw" | "html"; verbose?: boolean }',
      complete: true,
    });
  });

  it.each([
    [{ type: "object" }],
    [{ type: "object", properties: {}, additionalProperties: false }],
    [{ type: "object", properties: {}, required: [], "x-vendor": 1 }],
  ])("renders a tool without arguments as {}: %j", (schema) => {
    expect(compactInputType(schema)).toEqual({
      inputType: "{}",
      complete: true,
    });
  });

  it("renders nested objects, arrays, tuples, records, nullables, literals and unions", () => {
    expect(
      compactInputType({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                op: { enum: ["eq", "ne", 1, true, null] },
              },
              required: ["field"],
            },
          },
          pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            items: false,
            minItems: 2,
          },
          rest: {
            type: "array",
            items: [{ type: "string" }],
            additionalItems: { type: "boolean" },
            minItems: 1,
          },
          labels: { type: "object", additionalProperties: { type: "string" } },
          meta: { type: "object", additionalProperties: true },
          "content-type": { type: ["string", "null"] },
          legacy: { type: "string", nullable: true },
          kind: { const: "page" },
          choice: {
            anyOf: [
              { type: "string" },
              {
                type: "array",
                items: { anyOf: [{ type: "string" }, { type: "number" }] },
              },
            ],
          },
          anything: {},
          nothing: false,
        },
        required: ["tags", "kind", "token"],
      }),
    ).toEqual({
      inputType:
        "{ tags: string[]; " +
        'filters?: { field: string; op?: "eq" | "ne" | 1 | true | null }[]; ' +
        "pair?: [string, number]; " +
        "rest?: [string, ...boolean[]]; " +
        "labels?: { [key: string]: string }; " +
        "meta?: { [key: string]: unknown }; " +
        '"content-type"?: string | null; ' +
        "legacy?: string | null; " +
        'kind: "page"; ' +
        "choice?: string | Array<string | number>; " +
        "anything?: unknown; " +
        "nothing?: never; " +
        "token: unknown }",
      complete: true,
    });
  });

  it("keeps keywords next to a $ref instead of dropping them", () => {
    const result = compactInputType({
      $defs: {
        Person: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      type: "object",
      properties: {
        owner: {
          $ref: "#/$defs/Person",
          properties: { team: { type: "string" } },
          required: ["team"],
        },
        reviewer: { $ref: "#/$defs/Person", nullable: true },
        alias: { $ref: "#/$defs/Person", maxLength: 3 },
      },
    });
    expect(result).toEqual({
      inputType:
        "{ owner?: { id: string } & { team: string }; " +
        "reviewer?: { id: string } | null; " +
        "alias?: { id: string } }",
      complete: false,
      omitted: ["maxLength"],
    });
  });

  it("flags oneOf alternatives that can overlap and keeps exclusive ones complete", () => {
    const string = { type: "string" };
    for (const oneOf of [
      [string, string],
      [
        { type: "object", properties: { a: string } },
        { type: "object", properties: { b: string } },
      ],
      [{ type: "integer" }, { type: "number" }],
    ]) {
      expect(compactInputType({ oneOf }).omitted).toContain("oneOf");
    }
    // a value that matches true and another alternative is rejected
    expect(compactInputType({ oneOf: [string, true] })).toEqual({
      inputType: "unknown",
      complete: false,
      omitted: ["oneOf"],
    });

    expect(
      compactInputType({
        oneOf: [string, { type: "number" }, { type: "null" }],
      }),
    ).toEqual({ inputType: "string | number | null", complete: true });
    expect(
      compactInputType({
        oneOf: [{ const: "a" }, { const: "b" }, { enum: [1, 2] }],
      }),
    ).toEqual({ inputType: '"a" | "b" | 1 | 2', complete: true });
    expect(
      compactInputType({
        $defs: {
          Base: {
            type: "object",
            properties: { id: string },
            required: ["id"],
          },
        },
        oneOf: ["a", "b"].map((kind) => ({
          allOf: [
            { $ref: "#/$defs/Base" },
            { properties: { kind: { const: kind } }, required: ["kind"] },
          ],
        })),
      }),
    ).toEqual({
      inputType:
        '{ id: string } & { kind: "a" } | { id: string } & { kind: "b" }',
      complete: true,
    });
    // the sibling type rules out the values that typeless alternatives share
    expect(
      compactInputType({
        type: "object",
        oneOf: ["a", "b"].map((kind) => ({
          properties: { kind: { const: kind } },
          required: ["kind"],
        })),
      }),
    ).toEqual({
      inputType: '({ kind: "a" } | { kind: "b" }) & {}',
      complete: true,
    });
  });

  it("renders tuple lengths from minItems, maxItems and the items after them", () => {
    const string = { type: "string" };
    const number = { type: "number" };
    const tuple = (schema: Record<string, unknown>) =>
      compactInputType({ type: "array", ...schema });
    for (const [schema, inputType] of [
      [{ prefixItems: [string] }, "[string?, ...unknown[]]"],
      [{ prefixItems: [string, number], items: false }, "[string?, number?]"],
      [
        { prefixItems: [string, number], items: false, minItems: 1 },
        "[string, number?]",
      ],
      [
        { prefixItems: [string, number], minItems: 2, maxItems: 2 },
        "[string, number]",
      ],
      [
        { items: [string, number], minItems: 2, maxItems: 2 },
        "[string, number]",
      ],
      [
        { prefixItems: [string, number, { type: "boolean" }], maxItems: 2 },
        "[string?, number?]",
      ],
      [
        {
          prefixItems: [string, { anyOf: [string, number] }],
          items: { type: "boolean" },
          minItems: 1,
        },
        "[string, (string | number)?, ...boolean[]]",
      ],
    ] as const) {
      expect(tuple(schema)).toEqual({ inputType, complete: true });
    }
    // bounds that a tuple type cannot show are reported
    expect(tuple({ prefixItems: [string], minItems: 2 })).toEqual({
      inputType: "[string?, ...unknown[]]",
      complete: false,
      omitted: ["minItems"],
    });
    expect(tuple({ prefixItems: [string], maxItems: 3 })).toEqual({
      inputType: "[string?, ...unknown[]]",
      complete: false,
      omitted: ["maxItems"],
    });
    expect(tuple({ items: string, minItems: 1 })).toEqual({
      inputType: "string[]",
      complete: false,
      omitted: ["minItems"],
    });
  });

  it("applies the sibling type to literals and empty intersections", () => {
    for (const [schema, inputType] of [
      [{ type: "number", enum: ["x", 1] }, "1"],
      [{ type: "integer", enum: [1, 1.5, "a"] }, "1"],
      [{ type: ["string", "null"], enum: ["a", null, 2] }, '"a" | null'],
      [{ type: "string", const: 1 }, "never"],
      [{ type: "string", allOf: [{ type: "number" }] }, "never"],
      [{ allOf: [{ enum: ["a"] }, { enum: ["b"] }] }, "never"],
    ] as const) {
      expect(compactInputType(schema)).toEqual({ inputType, complete: true });
    }
    expect(compactInputType({ const: "a", enum: ["b"] })).toEqual({
      inputType: '"a"',
      complete: false,
      omitted: ["enum"],
    });
    expect(compactInputType({ type: "date", enum: ["a"] })).toEqual({
      inputType: '"a"',
      complete: false,
      omitted: ["type"],
    });
  });

  it("flags a closed object combined with properties that it rejects", () => {
    const string = { type: "string" };
    const $defs = {
      Person: {
        type: "object",
        properties: { id: string },
        required: ["id"],
        additionalProperties: false,
      },
    };
    for (const owner of [
      { $ref: "#/$defs/Person", properties: { team: string } },
      { $ref: "#/$defs/Person", required: ["team"] },
      {
        allOf: [
          { $ref: "#/$defs/Person" },
          { type: "object", additionalProperties: { type: "number" } },
        ],
      },
    ]) {
      expect(
        compactInputType({ $defs, type: "object", properties: { owner } })
          .omitted,
      ).toEqual(["additionalProperties"]);
    }

    expect(
      compactInputType({
        type: "object",
        properties: {
          either: {
            type: "object",
            properties: { id: string, url: string },
            additionalProperties: false,
            anyOf: [{ required: ["id"] }, { required: ["url"] }],
          },
          // an undeclared required name takes the additionalProperties type
          closed: {
            type: "object",
            properties: { a: string },
            required: ["token"],
            additionalProperties: false,
          },
          counts: {
            type: "object",
            required: ["total"],
            additionalProperties: { type: "number" },
          },
        },
      }),
    ).toEqual({
      inputType:
        "{ either?: ({ id: unknown } | { url: unknown }) & { id?: string; url?: string }; " +
        "closed?: { a?: string; token: never }; " +
        "counts?: { total: number; [key: string]: number } }",
      complete: true,
    });
  });

  it("flags object and array keywords without a type that leave other values open", () => {
    expect(
      compactInputType({
        type: "object",
        properties: {
          a: { properties: { b: { type: "string" } } },
          c: { items: { type: "string" } },
        },
      }),
    ).toEqual({
      inputType: "{ a?: { b?: string }; c?: string[] }",
      complete: false,
      omitted: ["missing type"],
    });
    // a sibling type limits the values to objects
    expect(
      compactInputType({
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ required: ["a"] }],
      }),
    ).toEqual({ inputType: "{ a: unknown } & { a?: string }", complete: true });
  });

  it("leaves references inside a nested $id unresolved", () => {
    expect(
      compactInputType({
        $defs: { Name: { type: "string" } },
        type: "object",
        properties: {
          inner: {
            $id: "https://example.com/inner",
            type: "object",
            properties: { name: { $ref: "#/$defs/Name" } },
          },
          outer: { $ref: "#/$defs/Name" },
        },
      }),
    ).toEqual({
      inputType: "{ inner?: { name?: unknown }; outer?: string }",
      complete: false,
      omitted: ["$id", "unresolved $ref"],
    });
  });

  it("summarizes a real-world schema and lists every constraint it leaves out", () => {
    const result = compactInputType({
      $defs: {
        Priority: { enum: ["low", "high"], title: "Priority", type: "string" },
        Assignee: {
          type: "object",
          title: "Assignee",
          properties: {
            accountId: { type: "string", pattern: "^[0-9a-f]+$" },
            email: { type: "string", format: "email" },
          },
          required: ["accountId"],
        },
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
      type: "object",
      properties: {
        project: {
          type: "string",
          minLength: 1,
          description: "Project key,\n such as  OPS */ or DEV",
        },
        priority: { $ref: "#/$defs/Priority", default: "low" },
        assignee: {
          anyOf: [{ $ref: "#/$defs/Assignee" }, { type: "null" }],
          default: null,
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        tree: { $ref: "#/$defs/Node" },
        owner: { allOf: [{ $ref: "#/$defs/Assignee" }], description: "Owner" },
        payload: {
          oneOf: [
            {
              type: "object",
              properties: { kind: { const: "a" }, a: { type: "string" } },
              required: ["kind"],
            },
            {
              type: "object",
              properties: { kind: { const: "b" } },
              required: ["kind"],
            },
          ],
        },
        extras: {
          type: "object",
          patternProperties: { "^x-": { type: "string" } },
        },
        external: { $ref: "https://example.com/schema.json" },
      },
      required: ["project"],
      if: { properties: { priority: { const: "high" } } },
      then: { required: ["assignee"] },
    });
    const assignee = "{ accountId: string; email?: string }";
    expect(result).toEqual({
      inputType:
        "{ /** Project key, such as OPS * / or DEV */ project: string; " +
        'priority?: "low" | "high"; ' +
        `assignee?: ${assignee} | null; ` +
        "limit?: number; " +
        "tree?: { name?: string; children?: unknown[] }; " +
        `/** Owner */ owner?: ${assignee}; ` +
        'payload?: { kind: "a"; a?: string } | { kind: "b" }; ' +
        "extras?: {}; " +
        "external?: unknown }",
      complete: false,
      omitted: [
        "if",
        "then",
        "minLength",
        "pattern",
        "format",
        "minimum",
        "maximum",
        "integer",
        "recursive $ref",
        "patternProperties",
        "unresolved $ref",
      ],
    });
  });

  it("marks unsupported and invalid shapes instead of guessing", () => {
    const result = compactInputType({
      $id: "https://example.com/root",
      type: "object",
      properties: {
        bad: "string",
        date: { type: "date" },
        nested: { $id: "inner", type: "string" },
        negated: { not: { type: "string" } },
        loop: { $ref: "#" },
        proto: { $ref: "#/__proto__" },
        constructor: { $ref: "#/constructor" },
        encoded: { $ref: "#/properties/%ZZ" },
        longRef: { $ref: `#/${"a".repeat(600)}` },
        object: { const: { a: 1 } },
        empty: { anyOf: [] },
      },
    });
    expect(result).toEqual({
      inputType:
        "{ bad?: unknown; date?: unknown; nested?: string; negated?: unknown; " +
        "loop?: unknown; proto?: unknown; constructor?: unknown; " +
        "encoded?: unknown; longRef?: unknown; object?: unknown; empty?: unknown }",
      complete: false,
      omitted: [
        "invalid schema",
        "type",
        "$id",
        "not",
        "recursive $ref",
        "unresolved $ref",
        "const",
        "anyOf",
      ],
    });
  });

  it("counts nested output once, so a nested schema fills its whole budget", () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let level = 0; level < 4; level += 1) {
      nested = {
        type: "object",
        properties: {
          child: nested,
          ...Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `field${index}`,
              { type: "string", description: `Field ${index}` },
            ]),
          ),
        },
      };
    }
    const result = compactInputType(nested);
    expect(result.omitted).toEqual(["size limit"]);
    expect(result.inputType.length).toBeGreaterThan(3_600);
    expect(result.inputType.length).toBeLessThanOrEqual(MAX_INPUT_TYPE_CHARS);

    // the same structure within budget is rendered completely
    const small = compactInputType({
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: { c: { type: "array", items: { type: "string" } } },
            },
          },
        },
      },
    });
    expect(small).toEqual({
      inputType: "{ a?: { b?: { c?: string[] } } }",
      complete: true,
    });
  });

  it("bounds repeated references that double at each level", () => {
    const levels = 40;
    const $defs: Record<string, unknown> = {
      [`l${levels}`]: { type: "string" },
    };
    for (let level = 0; level < levels; level += 1) {
      const next = { $ref: `#/$defs/l${level + 1}` };
      $defs[`l${level}`] = {
        type: "object",
        properties: { a: next, b: next },
        required: ["a", "b"],
      };
    }
    const startedAt = Date.now();
    const result = compactInputType({
      $defs,
      type: "object",
      properties: { root: { $ref: "#/$defs/l0" } },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.complete).toBe(false);
    expect(result.omitted).toEqual(
      expect.arrayContaining(["depth limit", "size limit"]),
    );
    expect(result.inputType.length).toBeLessThanOrEqual(MAX_INPUT_TYPE_CHARS);
  });

  it("bounds a reference that composes many copies of a large definition", () => {
    const big = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          `field${index}`,
          { type: "string" },
        ]),
      ),
    };
    const result = compactInputType({
      $defs: { big },
      type: "object",
      properties: {
        all: {
          allOf: Array.from({ length: 200 }, () => ({ $ref: "#/$defs/big" })),
        },
        any: {
          anyOf: Array.from({ length: 200 }, (_, index) => ({
            allOf: [{ $ref: "#/$defs/big" }, { const: index }],
          })),
        },
      },
    });
    expect(result.complete).toBe(false);
    expect(result.omitted).toContain("size limit");
    expect(result.inputType.length).toBeLessThanOrEqual(MAX_INPUT_TYPE_CHARS);
  });

  it("bounds depth, enums, properties, names, descriptions and labels", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let level = 0; level < 1_000; level += 1) {
      deep = { type: "object", properties: { n: deep } };
    }
    const deepResult = compactInputType(deep);
    expect(deepResult.omitted).toEqual(["depth limit"]);
    expect(deepResult.inputType.length).toBeLessThan(300);

    const enumResult = compactInputType({
      type: "object",
      properties: {
        zone: {
          enum: [
            "x".repeat(81),
            ...Array.from({ length: 10_000 }, (_, i) => `v${i}`),
          ],
        },
      },
    });
    expect(enumResult).toEqual({
      inputType: `{ zone?: ${Array.from({ length: 20 }, (_, i) => `"v${i}"`).join(" | ")} /* +9981 more */ }`,
      complete: false,
      omitted: ["enum"],
    });

    const wide = compactInputType({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 10_000 }, (_, index) => [
          `p${index}`,
          { type: "string", description: "d".repeat(1_000_000) },
        ]),
      ),
    });
    expect(wide.complete).toBe(false);
    expect(wide.omitted).toEqual(["size limit"]);
    expect(wide.inputType).toMatch(/\/\* \+\d+ more \*\/ }$/);
    expect(wide.inputType.length).toBeLessThanOrEqual(MAX_INPUT_TYPE_CHARS);
    // each description is cut to 100 characters and marked
    expect(wide.inputType).toContain(`/** ${"d".repeat(97)}... */ p0?: string`);

    const named = compactInputType({
      type: "object",
      properties: { ["n".repeat(1_000)]: { type: "string" }, ok: {} },
      required: ["m".repeat(1_000)],
    });
    expect(named).toEqual({
      inputType: "{ ok?: unknown; /* +2 more */ }",
      complete: false,
      omitted: ["long property name"],
    });

    const keywords = compactInputType({
      type: "object",
      ["k".repeat(1_000)]: true,
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`custom${index}`, true]),
      ),
    });
    expect(keywords.omitted).toHaveLength(17);
    expect(keywords.omitted?.[0]).toBe(`${"k".repeat(64)}...`);
    expect(keywords.omitted?.at(-1)).toBe("...");
  });

  it("bounds the work on long lists by its limits, not by their length", () => {
    const wide = 60_000;
    const inProperty = (schema: unknown) =>
      compactInputType({ type: "object", properties: { v: schema } });

    // boolean members are schema nodes too
    for (const [member, inputType] of [
      [false, "never"],
      [true, "unknown"],
      [{ type: "string" }, "string"],
    ] as const) {
      const members = counted(Array(wide).fill(member));
      expect(inProperty({ allOf: members.list })).toEqual({
        inputType: `{ v?: ${inputType} }`,
        complete: false,
        omitted: ["size limit"],
      });
      expect(members.reads()).toBeLessThanOrEqual(500);
    }

    const lists: [(list: unknown[]) => unknown, unknown, string, number][] = [
      [(list) => ({ anyOf: list }), { type: "string" }, "size limit", 500],
      [(list) => ({ type: list }), "string", "type", 0],
      [(list) => ({ enum: list }), { a: 1 }, "enum", 1_000],
      [(list) => ({ type: "number", enum: list }), "x", "enum", 1_000],
      [(list) => ({ type: "object", required: list }), "a", "size limit", 0],
    ];
    for (const [schema, entry, label, limit] of lists) {
      const entries = counted(Array(wide).fill(entry));
      expect(inProperty(schema(entries.list))).toEqual({
        inputType: "{ v?: unknown }",
        complete: false,
        omitted: [label],
      });
      expect(entries.reads()).toBeLessThanOrEqual(limit);
    }

    const elements = counted(Array(wide).fill({ type: "string" }));
    const tuple = inProperty({ type: "array", prefixItems: elements.list });
    expect(tuple.omitted).toEqual(["size limit"]);
    expect(tuple.inputType).toMatch(/string\?, \.\.\.unknown\[\]\] }$/);
    expect(tuple.inputType.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
    expect(elements.reads()).toBeLessThanOrEqual(500);

    const longNames = compactInputType({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: wide }, (_, index) => [
          `${"n".repeat(128)}${index}`,
          { type: "string" },
        ]),
      ),
    });
    expect(longNames).toEqual({
      inputType: `{ /* +${wide} more */ }`,
      complete: false,
      omitted: ["long property name", "size limit"],
    });

    const startedAt = Date.now();
    const keywords = compactInputType({
      type: "object",
      ...Object.fromEntries(
        Array.from({ length: wide }, (_, index) => [
          `${index}${"k".repeat(1_000)}`,
          true,
        ]),
      ),
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(keywords.omitted).toHaveLength(17);
    expect(keywords.omitted?.at(-1)).toBe("...");
  });

  it("keeps cut output well-formed and within a hard limit", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `field${index}`,
        { type: "string" },
      ]),
    );
    // the budget runs out before the first tuple element
    const cut = compactInputType({
      type: "array",
      allOf: [{ type: "array", items: { type: "object", properties: fields } }],
      prefixItems: [{ type: "string" }, { type: "string" }],
      items: { type: "number" },
    });
    expect(cut.omitted).toEqual(["size limit"]);
    expect(cut.inputType).toMatch(
      / \/\* \+\d+ more \*\/ }\[\] & \[\.\.\.unknown\[\]\]$/,
    );
    expectTypeSyntax(cut.inputType);

    // each level adds closing text after the budget runs out
    const nest = (levels: number): Record<string, unknown> => {
      let schema: Record<string, unknown> = { type: "string" };
      for (let level = 0; level < levels; level += 1) {
        schema = {
          type: ["object", "array", "null", "string", "number", "boolean"],
          nullable: true,
          anyOf: [{ type: "object" }, { type: "array" }],
          properties: {
            ["x".repeat(127) + "-"]: {
              ...schema,
              description: "d".repeat(300),
            },
            ...Object.fromEntries(
              Array.from({ length: 30 }, (_, index) => [
                `s${index}`,
                { type: "string", description: "e".repeat(300) },
              ]),
            ),
          },
        };
      }
      return schema;
    };
    expect(compactInputType(nest(30))).toEqual({
      inputType: "unknown",
      complete: false,
      omitted: ["size limit"],
    });
    for (const levels of [2, 5, 8]) {
      const { inputType, omitted } = compactInputType(nest(levels));
      expect(omitted).toContain("size limit");
      expect(inputType.length).toBeGreaterThan(3_600);
      expect(inputType.length).toBeLessThanOrEqual(HARD_MAX_CHARS);
      expectTypeSyntax(inputType);
    }
  });

  it("renders a schema that is missing or not an object conservatively", () => {
    expect(compactInputType(undefined)).toEqual({
      inputType: "unknown",
      complete: false,
      omitted: ["invalid schema"],
    });
    expect(compactInputType(true)).toEqual({
      inputType: "unknown",
      complete: true,
    });
  });
});
