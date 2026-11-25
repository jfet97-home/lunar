import { compactInputType } from "./compact-schema.js";

// the renderer stops near its 4,000-character budget
const MAX_INPUT_TYPE_CHARS = 4_500;

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
          },
          rest: {
            type: "array",
            items: [{ type: "string" }],
            additionalItems: { type: "boolean" },
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
