# On-demand tool discovery

Connect an MCP client to `http://localhost:9000/mcp/lazy` to expose four
discovery tools and permitted built-in management tools instead of the complete
upstream catalog. The default owner sees ten management tools. This endpoint
is built into MCPX and uses the same authentication, upstream connections,
permissions, and sessions. The existing `/mcp` and `/sse` endpoints remain
available for clients that need the complete catalog.

When Code Mode is enabled, both endpoints also advertise `mcpx_execute`, which
runs a script that chains these operations server-side, and
`mcpx_execute_readonly`, which runs only inner calls that the gateway trusts as
reads. See the [Code Mode guide](code-mode.md).

## Discovery and execution

1. Call `mcpx_list_servers` with no arguments at the start of the session. It
   returns the names of MCP servers with tools visible to the caller, plus
   existing descriptions when available. Startup instructions recommend making
   this call immediately after connecting.
2. Call `mcpx_search_tools` with service/task keywords. It returns five matches by
   default, including names, short descriptions, tool annotations, and
   [read-only eligibility](#read-only-eligibility).
3. Call `mcpx_get_tool_schema` with one returned name to obtain its full definition.
   Add `"format": "compact"` for a shorter summary of its arguments; see
   [Compact schema view](#compact-schema-view).
4. Call `mcpx_call_tool` with that name and an `arguments` object matching its
   schema. Permitted built-in management tools are advertised directly under
   names such as `mcpx__management_list_servers`; call them without search,
   schema lookup, or the execution wrapper.

Server descriptions use the optional `description` field in each `mcpServers`
entry in `config/mcp.json` first, then the upstream initialization response,
then the existing MCPX catalog entry. Missing descriptions are omitted;
MCPX does not infer them from tool descriptions. Descriptions are limited to
300 characters. Listing servers reads local metadata and makes no upstream
tool calls. It omits servers with no visible tools, including blocked or
inactive integrations. A server awaiting authentication can appear when its
authentication tool is visible. Permissions are checked again on every call.

The server details panel shows the current description. Use **Edit server** >
**Description** to set a custom value, then **Save Changes**. Leaving the field
empty restores the upstream or catalog description. Custom descriptions are
persisted with the server configuration and survive container replacement.
Saving only the description preserves the upstream connection and OAuth tokens.

Search results omit argument and output schemas. `limit` is capped at 20;
`offset` and `nextOffset` allow bounded browsing. An exact tool name selects that
tool directly. Tool names returned by discovery are the same qualified names
advertised by the full endpoint.

## Compact schema view

`mcpx_get_tool_schema` takes an optional `format`. The default, `"full"`,
returns the tool definition exactly as before. `"compact"` returns a short
summary that MCPX derives on request from the visible tool's `inputSchema`, so
it works for every tool, including tools added after the session started:

```text
mcpx_get_tool_schema({"name": "jira__create_issue", "format": "compact"})
→ {"name":"jira__create_issue","format":"compact","description":"Create a Jira issue","annotations":{"destructiveHint":false},"inputType":"{ /** Project key */ project: string; type: \"Bug\" | \"Task\"; fields?: { labels?: string[]; [key: string]: unknown } }","complete":false,"omitted":["pattern"]}
```

| Field                  | Content                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `name`                 | The exact tool name. Use it unchanged in `mcpx_call_tool`.                                   |
| `format`               | Always `"compact"`. A full definition has no such field.                                     |
| `title`, `description` | Present when the tool has them, cut to 300 characters. A cut text ends with `...`.           |
| `annotations`          | The upstream hints, as in search results.                                                    |
| `inputType`            | A TypeScript-like type of the `arguments` object.                                            |
| `complete`             | `true` only when `inputType` leaves out no validation keyword of the input schema.           |
| `omitted`              | Present when `complete` is `false`: the keywords and cuts that `inputType` does not include. |

`inputType` shows property names, `?` for optional properties, types, nested
objects and arrays, enums and constants, unions (`anyOf`, `oneOf`),
intersections (`allOf`, and keywords next to a `$ref`), nullable values,
records (`additionalProperties`), tuples, and references inside the same
schema. Property descriptions appear as comments, cut to 100 characters.
`integer` shows as `number`. An object lists only its declared properties even
when its schema accepts others, and `oneOf` shows as an ordinary union.

`omitted` names each keyword that the type cannot express, such as
`minLength`, `pattern`, `format`, `minimum` or `integer`, and the reason for
each cut:

| Label                               | Meaning                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `depth limit`                       | A part nested deeper than 20 levels shows as `unknown`. Each `$ref`, `anyOf`, `oneOf` and `allOf` step counts as a level. |
| `size limit`                        | The summary reached about 4,000 characters or 500 schema nodes. Later parts show as `unknown` or `/* +N more */`.         |
| `recursive $ref`, `unresolved $ref` | A reference back into itself, or to anything outside this schema, shows as `unknown`.                                     |
| `enum`, `const`                     | Values after the first 20, longer than 80 characters, or other than a string, number, boolean or null are not shown.      |
| `long property name`                | A property name longer than 128 characters is not shown.                                                                  |
| `invalid schema`                    | A part that is not a schema shows as `unknown`.                                                                           |

At most 16 labels are listed; a final `...` means that there are more. A
reference that occurs more than once is expanded once and reused, and each
repetition counts toward the size limit.

Use the compact view to orient yourself: to compare similar tools, to see
which arguments are required, or to write a call with simple arguments. Get
the full schema when `complete` is `false` and a constraint that it leaves out
can matter, when a call fails validation, when you need `outputSchema` or other
definition fields, or when the exact JSON Schema matters.

The compact view is informational. MCPX does not validate, authorize or change
a call with it. `mcpx_call_tool`, approvals and read-only checks use the full
definition, and the upstream server validates the arguments against its own
schema. Hidden and denied tools get the same `Tool unavailable` error in both
formats, and an unknown `format` is an invalid argument. Gateways before this
feature reject `format` as an unrecognized argument.

## Read-only eligibility

Each search result carries `readOnlyEligibility`: the gateway's own decision
whether [`mcpx_execute_readonly`](code-mode.md#read-only-scripts) would run that
tool now for this caller. It applies the same rules as the read-only tool: the
operator's exact trust entries, the built-in read-only tools, the refusal of
declared writes and of gateway wrapper names. `annotations` remain the upstream
server's own hints, passed through unchanged; a `readOnlyHint` alone does not make
a tool eligible. An ineligible result gives a `reason`:

| Reason           | Meaning                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declares_write` | The definition sets `readOnlyHint: false` or `destructiveHint: true`. A trust entry does not override it.                                            |
| `not_trusted`    | The operator lists neither the exact tool nor, for a tool marked `readOnlyHint: true`, its exact server. Patterns with `*` do not count.             |
| `reserved`       | The name is a gateway wrapper such as `mcpx_call_tool`.                                                                                              |
| `unavailable`    | This gateway does not offer `mcpx_execute_readonly`, because Code Mode is disabled or its runner is missing. `readOnly: true` then returns an error. |

Pass `readOnly: true` to return only eligible tools:

```text
mcpx_search_tools({"query": "jira issue", "readOnly": true})
→ {"tools":[{"name":"jira__get_issue","description":"Get an issue","annotations":{"readOnlyHint":true},"readOnlyEligibility":{"eligible":true}}],"totalMatches":1}
```

The filter keeps the ordinary ranking and skips ineligible tools; `totalMatches`
and `nextOffset` count only eligible tools. Search without it to see why a tool
was left out. Omitting `readOnly`, or passing `false`, returns the same results
as before, with the added field. Scripts use the same option:
`mcpx.searchTools(query, { readOnly: true })`.

Eligibility describes only tools visible to the caller and grants nothing.
`mcpx_execute_readonly` checks every call again when it runs, so a change to a
definition, trust list or permission in between applies at that point.
Gateways before this feature return no `readOnlyEligibility` and reject
`readOnly` as an unrecognized argument (`invalid_request` inside a script), so
they never return unfiltered results for a filtered search. Treat a result
without the field as unknown, not eligible.

Search, schema lookup, and execution check the caller's current permitted tool
set. Cached embeddings do not grant access. Direct management calls and wrapped
upstream calls go through the ordinary gateway path, including authorization
forwarding, audit records, metrics, and correlated-call deduplication. Original
tool results are returned unchanged. Sessions cannot be reused between the
full and lazy endpoints.

## Local semantic retrieval

The Docker image includes a pinned, quantized
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` model. Semantic retrieval runs
locally on CPU through ONNX WebAssembly and combines its ranking with keyword
matches. It needs no inference API, account, or additional service. Model files
are downloaded and checked during the image build; inference uses local files.

Tool embeddings are computed when needed and persisted in
`.mcpx/tool-embeddings.json`, in the existing state volume. Changed definitions
are re-embedded. Query embeddings stay in memory. Searches use keyword ranking
if the embedding runtime is unavailable and emit a gateway warning.

## Client configuration

For Codex:

```toml
[mcp_servers.mcpx]
url = "http://localhost:9000/mcp/lazy"
startup_timeout_sec = 60
```

For Claude Code:

```json
{
  "mcpServers": {
    "mcpx": {
      "type": "http",
      "url": "http://localhost:9000/mcp/lazy"
    }
  }
}
```

Reconnect the client after changing its endpoint. A running conversation may
retain earlier tool definitions. Update workflow guides that assume upstream
tools are directly advertised: their names now belong in `mcpx_call_tool` arguments.
Client permission rules see the generic execution tool; MCPX permissions still
apply to the underlying target. The execution wrapper is conservatively marked
as potentially destructive and is not marked read-only.
