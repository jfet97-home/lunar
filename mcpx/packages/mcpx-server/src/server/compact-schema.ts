/*
 * A compact, TypeScript-like summary of a tool's input JSON Schema. It is
 * informational only: MCPX never validates, authorizes or rewrites a call
 * with it, and the upstream server still applies its own full schema.
 *
 * The summary keeps structure: types, required and optional properties,
 * nested objects and arrays, enums, unions and local `$ref`s. Every keyword it
 * cannot express, and every part cut by a budget, is reported in `omitted`,
 * so a partial summary never passes for the complete schema. Budgets bound
 * nesting, schema nodes visited, output length and repeated references, so a
 * hostile or very large schema costs a bounded amount of work.
 */

export interface CompactInputType {
  inputType: string;
  // true only when inputType leaves out no validation keyword of the schema
  complete: boolean;
  omitted?: string[];
}

const LIMITS = {
  depth: 20,
  nodes: 500,
  chars: 4_000,
  enumValues: 20,
  literalChars: 80,
  nameChars: 128,
  commentChars: 100,
  refChars: 512,
  omitted: 16,
  labelChars: 64,
};

// keywords the summary represents
const RENDERED = new Set([
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "enum",
  "const",
  "type",
  "nullable",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "additionalItems",
]);

// keywords that only annotate a schema; leaving them out loses no constraint
const ANNOTATIONS = new Set([
  "$schema",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "$vocabulary",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

type Kind = "atom" | "union" | "intersection";

interface Rendered {
  text: string;
  kind: Kind;
}

const UNKNOWN: Rendered = { text: "unknown", kind: "atom" };

export function compactInputType(schema: unknown): CompactInputType {
  const renderer = new Renderer(schema);
  const inputType = renderer.render(schema, 0).text;
  const omitted = renderer.omittedLabels();
  return omitted.length === 0
    ? { inputType, complete: true }
    : { inputType, complete: false, omitted };
}

class Renderer {
  private nodes = 0;
  private chars = 0;
  private readonly omitted = new Set<string>();
  private moreOmitted = false;
  // reference targets on the current path, so a cycle ends in `unknown`
  private readonly expanding = new Set<object>();
  // a repeated reference reuses its first rendering and pays for its length
  private readonly expanded = new Map<object, Rendered>();

  constructor(private readonly root: unknown) {
    if (isRecord(root)) this.expanding.add(root);
  }

  omittedLabels(): string[] {
    return this.moreOmitted ? [...this.omitted, "..."] : [...this.omitted];
  }

  render(schema: unknown, depth: number): Rendered {
    if (schema === true) return this.atom("unknown");
    if (schema === false) return this.atom("never");
    if (!isRecord(schema)) {
      this.omit("invalid schema");
      return UNKNOWN;
    }
    if (depth > LIMITS.depth) {
      this.omit("depth limit");
      return UNKNOWN;
    }
    if (this.nodes >= LIMITS.nodes || this.exhausted()) {
      this.omit("size limit");
      return UNKNOWN;
    }
    this.nodes += 1;
    this.checkKeywords(schema);

    const parts: Rendered[] = [];
    if (schema["$ref"] !== undefined) {
      parts.push(this.renderRef(schema["$ref"], depth));
    }
    if (schema["allOf"] !== undefined) {
      const members = schema["allOf"];
      if (Array.isArray(members) && members.length > 0) {
        for (const member of members) {
          parts.push(this.render(member, depth + 1));
        }
      } else {
        this.omit("allOf");
      }
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      if (schema[keyword] !== undefined) {
        parts.push(this.renderUnion(schema[keyword], depth, keyword));
      }
    }
    const own = this.renderOwn(schema, depth);
    if (own) parts.push(own);

    const result = this.intersect(parts);
    if (
      schema["nullable"] === true &&
      result.text !== "unknown" &&
      result.text !== "never"
    ) {
      return this.union([result, this.atom("null")]);
    }
    return result;
  }

  private renderRef(ref: unknown, depth: number): Rendered {
    const target =
      typeof ref === "string" && ref.length <= LIMITS.refChars
        ? resolvePointer(this.root, ref)
        : undefined;
    if (target === undefined) {
      this.omit("unresolved $ref");
      return UNKNOWN;
    }
    if (!isRecord(target)) return this.render(target, depth + 1);
    if (this.expanding.has(target)) {
      this.omit("recursive $ref");
      return UNKNOWN;
    }
    const previous = this.expanded.get(target);
    if (previous) {
      if (this.chars + previous.text.length > LIMITS.chars) {
        this.omit("size limit");
        return UNKNOWN;
      }
      this.chars += previous.text.length;
      return previous;
    }
    this.expanding.add(target);
    try {
      const rendered = this.render(target, depth + 1);
      this.expanded.set(target, rendered);
      return rendered;
    } finally {
      this.expanding.delete(target);
    }
  }

  private renderUnion(
    members: unknown,
    depth: number,
    keyword: "anyOf" | "oneOf",
  ): Rendered {
    if (!Array.isArray(members) || members.length === 0) {
      this.omit(keyword);
      return UNKNOWN;
    }
    const rendered: Rendered[] = [];
    for (const member of members) {
      const type = this.render(member, depth + 1);
      // unknown absorbs the union, so the other members add nothing
      if (type.text === "unknown") return UNKNOWN;
      rendered.push(type);
    }
    return this.union(rendered);
  }

  private renderOwn(
    schema: Record<string, unknown>,
    depth: number,
  ): Rendered | undefined {
    if (schema["const"] !== undefined) {
      return this.renderLiterals([schema["const"]], "const");
    }
    if (schema["enum"] !== undefined) {
      const values = schema["enum"];
      if (Array.isArray(values)) return this.renderLiterals(values, "enum");
      this.omit("enum");
      return UNKNOWN;
    }
    const type = schema["type"];
    if (type !== undefined) {
      const names = Array.isArray(type) ? type : [type];
      if (names.length === 0) {
        this.omit("type");
        return UNKNOWN;
      }
      return this.union(
        names.map((name) => this.renderTyped(name, schema, depth)),
      );
    }
    if (
      schema["properties"] !== undefined ||
      schema["additionalProperties"] !== undefined ||
      schema["required"] !== undefined
    ) {
      return this.renderObject(schema, depth);
    }
    if (schema["items"] !== undefined || schema["prefixItems"] !== undefined) {
      return this.renderArray(schema, depth);
    }
    return undefined;
  }

  private renderTyped(
    name: unknown,
    schema: Record<string, unknown>,
    depth: number,
  ): Rendered {
    switch (name) {
      case "string":
      case "number":
      case "boolean":
      case "null":
        return this.atom(name);
      case "integer":
        this.omit("integer");
        return this.atom("number");
      case "object":
        return this.renderObject(schema, depth);
      case "array":
        return this.renderArray(schema, depth);
      default:
        this.omit("type");
        return UNKNOWN;
    }
  }

  private renderLiterals(
    values: unknown[],
    keyword: "enum" | "const",
  ): Rendered {
    if (values.length === 0) return this.atom("never");
    const shown: string[] = [];
    let hidden = 0;
    for (const [index, value] of values.entries()) {
      if (shown.length >= LIMITS.enumValues || this.exhausted()) {
        hidden += values.length - index;
        break;
      }
      const literal = literalText(value);
      if (literal === undefined) hidden += 1;
      else shown.push(this.emit(literal));
    }
    if (hidden > 0) this.omit(keyword);
    if (shown.length === 0) return UNKNOWN;
    const text =
      this.join(shown, " | ") +
      (hidden > 0 ? this.emit(` /* +${hidden} more */`) : "");
    return { text, kind: shown.length > 1 || hidden > 0 ? "union" : "atom" };
  }

  private renderObject(
    schema: Record<string, unknown>,
    depth: number,
  ): Rendered {
    const properties = schema["properties"];
    if (properties !== undefined && !isRecord(properties)) {
      this.omit("properties");
    }
    const props = isRecord(properties) ? properties : {};
    const requiredList = schema["required"];
    if (requiredList !== undefined && !Array.isArray(requiredList)) {
      this.omit("required");
    }
    const required = new Set(
      Array.isArray(requiredList)
        ? requiredList.filter((name) => typeof name === "string")
        : [],
    );
    const members: string[] = [];
    let hidden = 0;
    const names = Object.keys(props);
    for (const [index, name] of names.entries()) {
      if (this.exhausted()) {
        hidden += names.length - index;
        this.omit("size limit");
        break;
      }
      if (name.length > LIMITS.nameChars) {
        hidden += 1;
        this.omit("long property name");
        continue;
      }
      const child = props[name];
      const prefix = this.emit(
        `${commentOf(child)}${propertyKey(name)}${required.has(name) ? "" : "?"}: `,
      );
      members.push(prefix + this.render(child, depth + 1).text);
    }
    // a required name without its own property schema accepts any value
    for (const name of required) {
      if (Object.prototype.hasOwnProperty.call(props, name)) continue;
      if (this.exhausted() || name.length > LIMITS.nameChars) {
        hidden += 1;
        this.omit(this.exhausted() ? "size limit" : "long property name");
        continue;
      }
      members.push(this.emit(`${propertyKey(name)}: unknown`));
    }
    const extra = schema["additionalProperties"];
    if (extra === true) {
      members.push(this.emit("[key: string]: unknown"));
    } else if (isRecord(extra)) {
      members.push(
        this.emit("[key: string]: ") + this.render(extra, depth + 1).text,
      );
    } else if (extra !== undefined && extra !== false) {
      this.omit("additionalProperties");
    }
    if (hidden > 0) members.push(this.emit(`/* +${hidden} more */`));
    if (members.length === 0) return this.atom("{}");
    return {
      text: this.emit("{ ") + this.join(members, "; ") + this.emit(" }"),
      kind: "atom",
    };
  }

  private renderArray(
    schema: Record<string, unknown>,
    depth: number,
  ): Rendered {
    const items = schema["items"];
    const prefixItems = schema["prefixItems"];
    const tuple = Array.isArray(prefixItems)
      ? prefixItems
      : Array.isArray(items)
        ? items
        : undefined;
    if (prefixItems !== undefined && !Array.isArray(prefixItems)) {
      this.omit("prefixItems");
    }
    if (!tuple) {
      if (items === undefined) return this.atom("unknown[]");
      return this.arrayOf(this.render(items, depth + 1));
    }
    const members: string[] = [];
    for (const [index, member] of tuple.entries()) {
      if (this.exhausted()) {
        this.omit("size limit");
        members.push(this.emit(`/* +${tuple.length - index} more */`));
        break;
      }
      members.push(this.render(member, depth + 1).text);
    }
    // 2020-12 puts the rest in items; draft-07 in additionalItems
    const rest = tuple === prefixItems ? items : schema["additionalItems"];
    if (rest !== undefined && rest !== false) {
      const restType = this.render(rest, depth + 1);
      members.push(this.emit("...") + this.arrayOf(restType).text);
    }
    return {
      text: this.emit("[") + this.join(members, ", ") + this.emit("]"),
      kind: "atom",
    };
  }

  private arrayOf(item: Rendered): Rendered {
    return item.kind === "atom"
      ? { text: item.text + this.emit("[]"), kind: "atom" }
      : {
          text: this.emit("Array<") + item.text + this.emit(">"),
          kind: "atom",
        };
  }

  private intersect(parts: Rendered[]): Rendered {
    // unknown adds nothing to an intersection; a lossy part was reported
    const useful = dedupe(parts.filter((part) => part.text !== "unknown"));
    const [first] = useful;
    if (!first) return UNKNOWN;
    if (useful.length === 1) return first;
    const texts = useful.map((part) =>
      part.kind === "union"
        ? this.emit("(") + part.text + this.emit(")")
        : part.text,
    );
    return { text: this.join(texts, " & "), kind: "intersection" };
  }

  private union(members: Rendered[]): Rendered {
    if (members.some((member) => member.text === "unknown")) return UNKNOWN;
    const distinct = dedupe(members);
    const [first] = distinct;
    if (!first) return UNKNOWN;
    if (distinct.length === 1) return first;
    return {
      text: this.join(
        distinct.map((member) => member.text),
        " | ",
      ),
      kind: "union",
    };
  }

  private checkKeywords(schema: Record<string, unknown>): void {
    for (const key of Object.keys(schema)) {
      if (RENDERED.has(key) || ANNOTATIONS.has(key) || key.startsWith("x-")) {
        continue;
      }
      // a nested $id changes how its own references resolve
      if (key === "$id" && schema === this.root) continue;
      this.omit(key);
    }
  }

  private omit(label: string): void {
    const shown =
      label.length > LIMITS.labelChars
        ? `${label.slice(0, LIMITS.labelChars)}...`
        : label;
    if (this.omitted.has(shown)) return;
    if (this.omitted.size >= LIMITS.omitted) {
      this.moreOmitted = true;
      return;
    }
    this.omitted.add(shown);
  }

  private exhausted(): boolean {
    return this.chars >= LIMITS.chars;
  }

  private emit(text: string): string {
    this.chars += text.length;
    return text;
  }

  // a leaf; composite text was already counted piece by piece
  private atom(text: string): Rendered {
    return { text: this.emit(text), kind: "atom" };
  }

  private join(texts: string[], separator: string): string {
    this.chars += separator.length * Math.max(texts.length - 1, 0);
    return texts.join(separator);
  }
}

// a local JSON Pointer such as #/$defs/Item; other references stay unresolved
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const encoded of ref.slice(2).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    segment = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function literalText(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "string" && value.length <= LIMITS.literalChars) {
    return JSON.stringify(value);
  }
  return undefined;
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function commentOf(schema: unknown): string {
  if (!isRecord(schema)) return "";
  const description = schema["description"];
  if (typeof description !== "string") return "";
  const text = description
    .slice(0, LIMITS.commentChars * 2)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\*\//g, "* /");
  if (text === "") return "";
  const cut =
    text.length > LIMITS.commentChars ||
    description.length > LIMITS.commentChars * 2
      ? `${text.slice(0, LIMITS.commentChars - 3)}...`
      : text;
  return `/** ${cut} */ `;
}

function dedupe(parts: Rendered[]): Rendered[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (seen.has(part.text)) return false;
    seen.add(part.text);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
