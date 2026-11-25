/*
 * A compact, TypeScript-like summary of a tool's input JSON Schema. It is
 * informational only: MCPX never validates, authorizes or rewrites a call
 * with it, and the upstream server still applies its own full schema.
 *
 * The summary keeps structure: types, required and optional properties,
 * nested objects and arrays, enums, unions and local `$ref`s. Every keyword it
 * cannot express, every part it shows with other accepted values than the
 * schema, and every part cut by a budget, is reported in `omitted`, so a
 * partial summary never passes for the complete schema. Each rendered part
 * also records a superset of the values it accepts, so the summary can prove
 * that oneOf alternatives cannot overlap. Budgets bound nesting, schema nodes
 * visited, list entries examined, output length and repeated references, so
 * a hostile or very large schema costs a bounded amount of work.
 */

export interface CompactInputType {
  inputType: string;
  /*
   * True only when inputType accepts the same arguments as the schema. An
   * object type without an index signature does not say whether undeclared
   * properties are accepted.
   */
  complete: boolean;
  omitted?: string[];
}

const LIMITS = {
  depth: 20,
  nodes: 500,
  chars: 4_000,
  // a summary that still ends longer becomes unknown
  maxChars: 5_000,
  // entries examined in one list of properties, required names or values
  entries: 1_000,
  enumValues: 20,
  // oneOf alternatives compared in pairs
  alternatives: 64,
  literalChars: 80,
  nameChars: 128,
  commentChars: 100,
  refChars: 512,
  omitted: 16,
  labelChars: 64,
};

// kinds of JSON value, as bits
const STRING = 1;
const NUMBER = 2;
const BOOLEAN = 4;
const NULL = 8;
const OBJECT = 16;
const ARRAY = 32;
const ANY = 63;

const TYPE_KINDS: Readonly<Record<string, number>> = {
  string: STRING,
  number: NUMBER,
  integer: NUMBER,
  boolean: BOOLEAN,
  null: NULL,
  object: OBJECT,
  array: ARRAY,
};
const TYPE_COUNT = 7;

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
  // kinds of value the part may accept, a superset of the exact ones
  accepts: number;
  // kinds the part accepts although its text does not show them
  loose?: number;
  // every value the part may accept, as literal texts
  values?: ReadonlySet<string>;
  // object only: the literal values of required properties
  tags?: ReadonlyMap<string, ReadonlySet<string>>;
  // object only: what the text shows about property names
  fields?: Fields;
}

interface Fields {
  names: readonly string[];
  // the text has an index signature
  indexed: boolean;
  /*
   * Present when the object rejects or types undeclared properties: its
   * declared properties, or null when several objects do.
   */
  closed?: Readonly<Record<string, unknown>> | null;
}

const UNKNOWN: Rendered = { text: "unknown", kind: "atom", accepts: ANY };
const NULL_VALUES: ReadonlySet<string> = new Set(["null"]);

export function compactInputType(schema: unknown): CompactInputType {
  const renderer = new Renderer(schema);
  const inputType = renderer.renderRoot();
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
  // nested $id resources on the current path; references inside them stay unresolved
  private scopes = 0;
  // reference targets on the current path, so a cycle ends in `unknown`
  private readonly expanding = new Set<object>();
  // a repeated reference reuses its first rendering and pays for its length
  private readonly expanded = new Map<object, Rendered>();

  constructor(private readonly root: unknown) {
    if (isRecord(root)) this.expanding.add(root);
  }

  renderRoot(): string {
    const { text } = this.commit(this.render(this.root, 0));
    if (text.length <= LIMITS.maxChars) return text;
    this.omit("size limit");
    return "unknown";
  }

  omittedLabels(): string[] {
    return this.moreOmitted ? [...this.omitted, "..."] : [...this.omitted];
  }

  render(schema: unknown, depth: number): Rendered {
    if (depth > LIMITS.depth) {
      this.omit("depth limit");
      return UNKNOWN;
    }
    if (this.overBudget()) {
      this.omit("size limit");
      return UNKNOWN;
    }
    // every schema costs a node, a boolean one too
    this.nodes += 1;
    if (schema === true) return this.atom("unknown", ANY);
    if (schema === false) return this.atom("never", 0);
    if (!isRecord(schema)) {
      this.omit("invalid schema");
      return UNKNOWN;
    }
    this.checkKeywords(schema);
    const scoped = schema !== this.root && schema["$id"] !== undefined;
    if (scoped) this.scopes += 1;
    try {
      return this.renderSchema(schema, depth);
    } finally {
      if (scoped) this.scopes -= 1;
    }
  }

  private renderSchema(
    schema: Record<string, unknown>,
    depth: number,
  ): Rendered {
    const parts: Rendered[] = [];
    if (schema["$ref"] !== undefined) {
      parts.push(this.renderRef(schema["$ref"], depth));
    }
    if (schema["allOf"] !== undefined) {
      const members = schema["allOf"];
      if (Array.isArray(members) && members.length > 0) {
        for (const member of members) {
          if (this.overBudget()) {
            this.omit("size limit");
            break;
          }
          parts.push(this.render(member, depth + 1));
        }
      } else {
        this.omit("allOf");
      }
    }
    // the sibling type rejects values of other kinds before any alternative
    const context =
      typeKinds(schema["type"]) | (schema["nullable"] === true ? NULL : 0);
    for (const keyword of ["anyOf", "oneOf"] as const) {
      if (schema[keyword] !== undefined) {
        parts.push(this.renderUnion(schema[keyword], depth, keyword, context));
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
      return this.union([result, this.atom("null", NULL, NULL_VALUES)]);
    }
    return result;
  }

  private renderRef(ref: unknown, depth: number): Rendered {
    const target =
      this.scopes === 0 &&
      typeof ref === "string" &&
      ref.length <= LIMITS.refChars
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
    context: number,
  ): Rendered {
    if (!Array.isArray(members) || members.length === 0) {
      this.omit(keyword);
      return UNKNOWN;
    }
    const rendered: Rendered[] = [];
    for (const member of members) {
      if (this.overBudget()) {
        this.omit("size limit");
        return UNKNOWN;
      }
      const type = this.render(member, depth + 1);
      if (type.text === "unknown") {
        // unknown absorbs anyOf, but oneOf rejects what another alternative matches
        if (keyword === "oneOf" && members.length > 1) this.omit("oneOf");
        return UNKNOWN;
      }
      rendered.push(type);
    }
    // a union does not show that a value matching two alternatives fails
    if (keyword === "oneOf" && !exclusive(rendered, context)) {
      this.omit("oneOf");
    }
    return this.union(rendered);
  }

  private renderOwn(
    schema: Record<string, unknown>,
    depth: number,
  ): Rendered | undefined {
    const type = schema["type"];
    const names =
      type === undefined ? undefined : Array.isArray(type) ? type : [type];
    // a type list names each of the seven types at most once
    if (names && (names.length === 0 || names.length > TYPE_COUNT)) {
      this.omit("type");
      return UNKNOWN;
    }
    if (schema["const"] !== undefined || schema["enum"] !== undefined) {
      return this.renderLiterals(schema, names);
    }
    if (names) {
      return this.union(
        [...new Set(names)].map((name) =>
          this.renderTyped(name, schema, depth),
        ),
      );
    }
    if (
      schema["properties"] !== undefined ||
      schema["additionalProperties"] !== undefined ||
      schema["required"] !== undefined
    ) {
      return this.renderObject(schema, depth, false);
    }
    if (schema["items"] !== undefined || schema["prefixItems"] !== undefined) {
      return this.renderArray(schema, depth, false);
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
        return this.atom(name, TYPE_KINDS[name] ?? ANY);
      case "null":
        return this.atom(name, NULL, NULL_VALUES);
      case "integer":
        this.omit("integer");
        return this.atom("number", NUMBER);
      case "object":
        return this.renderObject(schema, depth, true);
      case "array":
        return this.renderArray(schema, depth, true);
      default:
        this.omit("type");
        return UNKNOWN;
    }
  }

  private renderLiterals(
    schema: Record<string, unknown>,
    names: unknown[] | undefined,
  ): Rendered {
    const constant = schema["const"];
    const keyword = constant === undefined ? "enum" : "const";
    // the summary shows a const without the enum next to it
    if (constant !== undefined && schema["enum"] !== undefined) {
      this.omit("enum");
    }
    const values = constant === undefined ? schema["enum"] : [constant];
    if (!Array.isArray(values)) {
      this.omit("enum");
      return UNKNOWN;
    }
    // the sibling type rejects a literal of another type
    const typed = names?.every(
      (name) => typeof name === "string" && hasOwn(TYPE_KINDS, name),
    );
    if (names && !typed) this.omit("type");
    if (values.length === 0) return this.atom("never", 0);
    const shown: string[] = [];
    let accepts = 0;
    let hidden = 0;
    for (let index = 0; index < values.length; index += 1) {
      if (
        shown.length >= LIMITS.enumValues ||
        index >= LIMITS.entries ||
        this.exhausted()
      ) {
        hidden += values.length - index;
        break;
      }
      const value: unknown = values[index];
      if (typed && !names?.some((name) => typeAccepts(name, value))) continue;
      const literal = literalText(value);
      if (literal === undefined) {
        hidden += 1;
        continue;
      }
      shown.push(this.emit(literal));
      accepts |= kindOf(value);
    }
    if (hidden > 0) this.omit(keyword);
    if (shown.length === 0) {
      return hidden > 0 ? UNKNOWN : this.atom("never", 0);
    }
    const text =
      this.join(shown, " | ") +
      (hidden > 0 ? this.emit(` /* +${hidden} more */`) : "");
    const kind = shown.length > 1 || hidden > 0 ? "union" : "atom";
    return hidden > 0
      ? { text, kind, accepts: typeKinds(schema["type"]) }
      : { text, kind, accepts, values: new Set(shown) };
  }

  private renderObject(
    schema: Record<string, unknown>,
    depth: number,
    typed: boolean,
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
    const listed: unknown[] = Array.isArray(requiredList) ? requiredList : [];
    // a longer list cannot be matched against the properties within budget
    if (listed.length > LIMITS.entries) {
      this.omit("size limit");
      return UNKNOWN;
    }
    const required = new Set<string>();
    for (const name of listed) {
      if (typeof name === "string") required.add(name);
      else this.omit("required");
    }
    const members: string[] = [];
    const names: string[] = [];
    const tags = new Map<string, ReadonlySet<string>>();
    let hidden = 0;
    const keys = Object.keys(props);
    for (const [index, name] of keys.entries()) {
      if (index >= LIMITS.entries || this.overBudget()) {
        hidden += keys.length - index;
        this.omit("size limit");
        break;
      }
      if (name.length > LIMITS.nameChars) {
        hidden += 1;
        this.omit("long property name");
        continue;
      }
      const child = props[name];
      const isRequired = required.has(name);
      const prefix = this.emit(
        `${commentOf(child)}${propertyKey(name)}${isRequired ? "" : "?"}: `,
      );
      const value = this.commit(this.render(child, depth + 1));
      members.push(prefix + value.text);
      names.push(name);
      if (isRequired && value.values) tags.set(name, value.values);
    }
    // an undeclared property takes the type that additionalProperties gives it
    const extra = schema["additionalProperties"];
    let extraType: Rendered | undefined;
    const undeclared = (): string => {
      if (extra === false) return this.emit("never");
      if (!isRecord(extra)) return this.emit("unknown");
      if (extraType) return this.emit(extraType.text);
      extraType = this.commit(this.render(extra, depth + 1));
      return extraType.text;
    };
    for (const name of required) {
      if (hasOwn(props, name)) continue;
      if (this.overBudget() || name.length > LIMITS.nameChars) {
        hidden += 1;
        this.omit(this.overBudget() ? "size limit" : "long property name");
        continue;
      }
      members.push(this.emit(`${propertyKey(name)}: `) + undeclared());
      names.push(name);
    }
    const indexed = extra === true || isRecord(extra);
    if (indexed && this.overBudget()) {
      hidden += 1;
      this.omit("size limit");
    } else if (indexed) {
      members.push(this.emit("[key: string]: ") + undeclared());
    } else if (extra !== undefined && extra !== false) {
      this.omit("additionalProperties");
    }
    if (hidden > 0) members.push(this.emit(`/* +${hidden} more */`));
    const text =
      members.length === 0
        ? this.emit("{}")
        : this.emit("{ ") + this.join(members, "; ") + this.emit(" }");
    const closed = extra === false || isRecord(extra);
    return {
      text,
      kind: "atom",
      ...(typed ? { accepts: OBJECT } : { accepts: ANY, loose: ANY & ~OBJECT }),
      ...(tags.size > 0 ? { tags } : {}),
      fields: { names, indexed, ...(closed ? { closed: props } : {}) },
    };
  }

  private renderArray(
    schema: Record<string, unknown>,
    depth: number,
    typed: boolean,
  ): Rendered {
    const kinds = typed
      ? { accepts: ARRAY }
      : { accepts: ANY, loose: ANY & ~ARRAY };
    const items = schema["items"];
    const prefixItems = schema["prefixItems"];
    if (prefixItems !== undefined && !Array.isArray(prefixItems)) {
      this.omit("prefixItems");
    }
    const tuple = tupleOf(schema);
    if (!tuple) {
      const item =
        items === undefined
          ? this.atom("unknown", ANY)
          : this.commit(this.render(items, depth + 1));
      return { ...this.arrayOf(item), ...kinds };
    }
    const rest = restOf(schema, tuple);
    // without bounds the type can show, any element may be missing or follow
    const { min, max } = tupleLength(schema) ?? {
      min: 0,
      max: rest === false ? tuple.length : Infinity,
    };
    const length = Math.min(tuple.length, max);
    const members: string[] = [];
    let cut = false;
    for (let index = 0; index < length; index += 1) {
      if (this.overBudget()) {
        this.omit("size limit");
        cut = true;
        break;
      }
      const member = this.commit(this.render(tuple[index], depth + 1));
      members.push(index < min ? member.text : this.optional(member));
    }
    // the elements after a cut show as unknown
    if (cut || max > length) {
      const restType =
        cut || rest === undefined
          ? this.atom("unknown", ANY)
          : this.commit(this.render(rest, depth + 1));
      members.push(this.emit("...") + this.arrayOf(restType).text);
    }
    return {
      text: this.emit("[") + this.join(members, ", ") + this.emit("]"),
      kind: "atom",
      ...kinds,
    };
  }

  // an element that the array may end before
  private optional(member: Rendered): string {
    return member.kind === "atom"
      ? member.text + this.emit("?")
      : this.emit("(") + member.text + this.emit(")?");
  }

  private arrayOf(item: Rendered): Rendered {
    const text =
      item.kind === "atom"
        ? item.text + this.emit("[]")
        : this.emit("Array<") + item.text + this.emit(">");
    return { text, kind: "atom", accepts: ARRAY };
  }

  private intersect(parts: Rendered[]): Rendered {
    // unknown adds nothing to an intersection; a lossy part was reported
    const useful = parts.filter((part) => part.text !== "unknown");
    const [first] = useful;
    if (!first) return UNKNOWN;
    if (useful.length === 1) return first;
    this.checkClosed(useful);
    let accepts = ANY;
    let loose = 0;
    let values: ReadonlySet<string> | undefined;
    let tags: Map<string, ReadonlySet<string>> | undefined;
    for (const part of useful) {
      accepts &= part.accepts;
      loose |= part.loose ?? 0;
      if (part.values) {
        values = values ? common(values, part.values) : part.values;
      }
      if (!part.tags) continue;
      tags ??= new Map();
      for (const [name, tag] of part.tags) {
        const known = tags.get(name);
        tags.set(name, known ? common(known, tag) : tag);
      }
    }
    // no value has two kinds at once or equals two distinct literals
    if (accepts === 0 || values?.size === 0) return this.atom("never", 0);
    const distinct = dedupe(useful);
    const text =
      distinct.length === 1
        ? first.text
        : this.join(
            distinct.map((part) =>
              part.kind === "union"
                ? this.emit("(") + part.text + this.emit(")")
                : part.text,
            ),
            " & ",
          );
    const fields = mergeFields(useful);
    return {
      text,
      kind: distinct.length === 1 ? first.kind : "intersection",
      accepts,
      ...((loose & accepts) !== 0 ? { loose: loose & accepts } : {}),
      ...(values ? { values } : {}),
      ...(tags ? { tags } : {}),
      ...(fields ? { fields } : {}),
    };
  }

  private union(members: Rendered[]): Rendered {
    if (members.some((member) => member.text === "unknown")) return UNKNOWN;
    const distinct = dedupe(members);
    const [first] = distinct;
    if (!first) return UNKNOWN;
    if (distinct.length === 1) return first;
    let accepts = 0;
    let loose = 0;
    let values: Set<string> | undefined = new Set();
    for (const member of distinct) {
      accepts |= member.accepts;
      loose |= member.loose ?? 0;
      if (!member.values) {
        values = undefined;
      } else if (values) {
        for (const value of member.values) values.add(value);
      }
    }
    const fields = mergeFields(distinct);
    return {
      text: this.join(
        distinct.map((member) => member.text),
        " | ",
      ),
      kind: "union",
      accepts,
      ...(loose !== 0 ? { loose } : {}),
      ...(values ? { values } : {}),
      ...(fields ? { fields } : {}),
    };
  }

  // a closed object rejects the properties that another part adds
  private checkClosed(parts: readonly Rendered[]): void {
    for (const part of parts) {
      const closed = part.fields?.closed;
      if (closed === undefined) continue;
      for (const other of parts) {
        if (other === part || !other.fields) continue;
        const { names, indexed } = other.fields;
        if (
          indexed ||
          names.some((name) => closed === null || !hasOwn(closed, name))
        ) {
          this.omit("additionalProperties");
          return;
        }
      }
    }
  }

  // a value position shows the text alone, so kinds it does not show are lost
  private commit(rendered: Rendered): Rendered {
    if (rendered.loose) this.omit("missing type");
    return rendered;
  }

  private checkKeywords(schema: Record<string, unknown>): void {
    let tupleBounds: boolean | undefined;
    for (const key of Object.keys(schema)) {
      // a full list of labels takes no more
      if (this.moreOmitted) return;
      if (RENDERED.has(key) || ANNOTATIONS.has(key) || key.startsWith("x-")) {
        continue;
      }
      // a nested $id changes how its own references resolve
      if (key === "$id" && schema === this.root) continue;
      // a tuple type shows the length bounds that fit it
      if (key === "minItems" || key === "maxItems") {
        tupleBounds ??= tupleLength(schema) !== undefined;
        if (tupleBounds) continue;
      }
      this.omit(key);
    }
  }

  private omit(label: string): void {
    if (this.moreOmitted) return;
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

  // no budget left for another schema node or its output
  private overBudget(): boolean {
    return this.nodes >= LIMITS.nodes || this.exhausted();
  }

  private emit(text: string): string {
    this.chars += text.length;
    return text;
  }

  // a leaf; composite text was already counted piece by piece
  private atom(
    text: string,
    accepts: number,
    values?: ReadonlySet<string>,
  ): Rendered {
    return {
      text: this.emit(text),
      kind: "atom",
      accepts,
      ...(values ? { values } : {}),
    };
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

// the element schemas of a tuple: prefixItems, or an items list in older drafts
function tupleOf(schema: Record<string, unknown>): unknown[] | undefined {
  const prefixItems = schema["prefixItems"];
  const items = schema["items"];
  if (Array.isArray(prefixItems)) return prefixItems;
  return Array.isArray(items) ? items : undefined;
}

// the schema of the items after a tuple
function restOf(schema: Record<string, unknown>, tuple: unknown[]): unknown {
  return tuple === schema["prefixItems"]
    ? schema["items"]
    : schema["additionalItems"];
}

/*
 * The lengths a tuple type can show: elements before minItems are required
 * and the others optional, and a maxItems up to the tuple length cuts the
 * tuple or removes its rest. Other bounds are reported as omitted.
 */
function tupleLength(
  schema: Record<string, unknown>,
): { min: number; max: number } | undefined {
  const tuple = tupleOf(schema);
  if (!tuple) return undefined;
  const open = restOf(schema, tuple) !== false;
  const min = schema["minItems"] ?? 0;
  const max = schema["maxItems"] ?? (open ? Infinity : tuple.length);
  if (!isCount(min) || typeof max !== "number") return undefined;
  if (max !== Infinity && !isCount(max)) return undefined;
  if (open && max !== Infinity && max > tuple.length) return undefined;
  const length = Math.min(max, tuple.length);
  // more required elements than the tuple can show
  if (min > length) return undefined;
  return { min, max: open ? max : length };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// whether no value of the context kinds can match two alternatives
function exclusive(
  alternatives: readonly Rendered[],
  context: number,
): boolean {
  if (alternatives.length > LIMITS.alternatives) return false;
  return alternatives.every((a, index) =>
    alternatives.slice(index + 1).every((b) => disjoint(a, b, context)),
  );
}

function disjoint(a: Rendered, b: Rendered, context: number): boolean {
  const shared = a.accepts & b.accepts & context;
  if (shared === 0) return true;
  if (a.values && b.values) return !overlaps(a.values, b.values);
  // objects differ in the literal values of a required property
  if (shared !== OBJECT || !a.tags || !b.tags) return false;
  for (const [name, values] of a.tags) {
    const other = b.tags.get(name);
    if (other && !overlaps(values, other)) return true;
  }
  return false;
}

function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function common(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...a].filter((value) => b.has(value)));
}

// what a union or intersection of parts shows about property names
function mergeFields(parts: readonly Rendered[]): Fields | undefined {
  const objects = parts.flatMap((part) => (part.fields ? [part.fields] : []));
  if (objects.length === 0) return undefined;
  const closed = objects.filter((fields) => fields.closed !== undefined);
  const [only] = closed;
  return {
    names: objects.flatMap((fields) => fields.names),
    indexed: objects.some((fields) => fields.indexed),
    ...(only ? { closed: closed.length === 1 ? only.closed : null } : {}),
  };
}

// the kinds of value a type keyword accepts; any kind when absent or invalid
function typeKinds(type: unknown): number {
  if (type === undefined) return ANY;
  const names = Array.isArray(type) ? type : [type];
  if (names.length === 0 || names.length > TYPE_COUNT) return ANY;
  let kinds = 0;
  for (const name of names) {
    const bits =
      typeof name === "string" && hasOwn(TYPE_KINDS, name)
        ? TYPE_KINDS[name]
        : undefined;
    if (bits === undefined) return ANY;
    kinds |= bits;
  }
  return kinds;
}

function typeAccepts(name: unknown, value: unknown): boolean {
  if (name === "integer") return Number.isInteger(value);
  return typeof name === "string" && TYPE_KINDS[name] === kindOf(value);
}

function kindOf(value: unknown): number {
  if (value === null) return NULL;
  if (Array.isArray(value)) return ARRAY;
  if (typeof value === "string") return STRING;
  if (typeof value === "number") return NUMBER;
  if (typeof value === "boolean") return BOOLEAN;
  return typeof value === "object" ? OBJECT : 0;
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

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
