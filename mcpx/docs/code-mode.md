# Code Mode

Code Mode adds the `mcpx_execute` tool. It runs a short JavaScript program inside
MCPX, so a client can chain tool calls and filter large intermediate results
without sending each one through the model. Only the program's final value
returns to the client. Code Mode works with any MCP client and model provider.

A second tool, `mcpx_execute_readonly`, runs the same kind of program but
refuses every inner call that the gateway does not trust as a read. See
[Read-only scripts](#read-only-scripts).

Both tools are advertised in `tools/list` on both `/mcp` and `/mcp/lazy`, and
the initialize instructions of both endpoints describe them. Normal discovery and
direct tool calls are unchanged. The catalog a script can use is the live
gateway catalog for the caller: every connected tool that the caller may see,
including tools and servers added after the session started.

## Script interface

`code` is the body of an async function. Use `await` and `return` a
JSON-serializable value:

```js
const page = await mcpx.callTool("docs__search", { query: "rate limits" });
const ids = page.data.results
  .filter((hit) => hit.score > 0.8)
  .map((hit) => hit.id);
const pages = await Promise.all(
  ids.map((id) => mcpx.callTool("docs__get_page", { id })),
);
return pages.map((result) => result.text.slice(0, 500));
```

| Function                                               | Returns                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `mcpx.listServers()`                                   | The `mcpx_list_servers` result for the caller.                                                               |
| `mcpx.searchTools(query, { limit, offset, readOnly })` | The `mcpx_search_tools` result: names, descriptions, annotations and read-only eligibility, without schemas. |
| `mcpx.getToolSchema(name)`                             | One full tool definition, fetched on demand.                                                                 |
| `mcpx.callTool(name, args)`                            | `{ isError, content, structuredContent, text, data }`.                                                       |
| `mcpx.describe(value)`                                 | A bounded description of the value's shape, without its values. Runs in the script.                          |

`text` joins the result's text blocks. `data` is `structuredContent` when the tool
returns it, otherwise the text parsed as JSON, otherwise `undefined`. A tool-level
failure resolves with `isError: true`. A gateway refusal rejects with an `Error`
whose `name` is `McpxError` and whose `code` gives the reason:

| Code                                                                                                                           | Meaning                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `not_available`, `permission_denied`, `server_inactive`                                                                        | The caller cannot use this tool now.                                       |
| `approval_unsupported`, `approval_declined`, `approval_cancelled`, `approval_timeout`, `approval_failed`, `approval_too_large` | The call needed approval and did not run.                                  |
| `target_changed`, `session_closed`, `identity_changed`                                                                         | The tool, its server or auth, or the caller changed; the call did not run. |
| `call_failed`                                                                                                                  | The call failed with an unknown outcome. MCPX did not retry it.            |
| `result_too_large`                                                                                                             | The call completed, but its result exceeded the limit and was withheld.    |
| `call_limit`, `discovery_limit`, `too_many_pending_requests`                                                                   | A budget was exhausted.                                                    |
| `recursion_blocked`                                                                                                            | The name is a gateway wrapper such as `mcpx_execute` or `mcpx_call_tool`.  |
| `read_only_blocked`                                                                                                            | `mcpx_execute_readonly` refused a tool that is not a trusted read.         |

`console.log`, `info`, `warn`, `error` and `debug` output is returned with the
result. Scripts have no filesystem, network, timers, modules, process access or
credentials.

### Inspect a shape

`mcpx.describe(value)` helps a script learn the structure of a large result
before it filters it, without returning the data itself. It works on any value,
such as `.data`, `.content` or a discovery or schema result:

```js
const page = await mcpx.callTool("tracker__search", { query: "label:bug" });
return mcpx.describe(page.data);
```

For a page of 50 issues, the script returns:

```json
{
  "type": "object",
  "keys": {
    "total": "number",
    "issues": {
      "type": "array",
      "length": 50,
      "items": [
        {
          "type": "object",
          "keys": {
            "key": "string",
            "assignee": "null",
            "labels": { "type": "array", "length": 1, "items": ["string"] }
          }
        }
      ],
      "sampled": 3
    },
    "next": "string"
  }
}
```

- A leaf is a type name: `string`, `number`, `boolean`, `null`, `undefined`,
  `bigint`, `symbol` or `function`. Values, string lengths and numbers are never
  included.
- An object lists its own enumerable keys with their shapes. Only own keys
  count, so a `Date`, a `Map` or a class instance looks like any other object
  with those keys; no class name or tag is read from the value.
- An array reports its own `length` and the distinct shapes of its first three
  elements in `items`; `sampled` says how many elements were examined when that
  is fewer than `length`. Other elements are not read.
- Every property is read through its own property descriptor, so getters never
  run: `accessor` marks a getter. `circular` marks a reference to an enclosing
  value, and `unreadable` a value whose inspection threw, such as a revoked
  proxy, or an array whose own `length` is not a valid length.
- Limits bound the values inspected and the output: six levels (deeper
  containers get `depthLimited: true`), 24 keys examined per object
  (`moreKeys` gives the number not listed), key names cut to 64 characters,
  and 200 described entries in total. When the total is reached, the remaining
  keys and elements are left out and counted in `moreKeys` or `sampled`. Two
  long names that cut to the same 64 characters are listed once; the second
  still uses the per-object budget.

Key names are reported as they are. When an object is used as a map, its keys
are data, for example email addresses or identifiers. `describe` does not call
the gateway and runs on the script's own CPU and memory budget. Listing an
inspected object's own keys is one engine step, so an object with a very large
number of keys costs time and memory in proportion to that number even though
only 24 are examined. A proxy's traps run while it is inspected, because a
proxy has no other way to report its keys or descriptors.

## Result and call report

`mcpx_execute` returns one JSON text block:

```json
{
  "ok": true,
  "result": ["..."],
  "calls": [
    {
      "index": 1,
      "tool": "docs__search",
      "status": "succeeded",
      "approval": "trusted_read",
      "resultBytes": 182344,
      "durationMs": 120
    }
  ],
  "logs": ["..."],
  "bytes": {
    "toolResults": { "received": 182344, "sent": 182344 },
    "discovery": { "received": 5021, "sent": 5021 },
    "result": 64,
    "logs": 12
  },
  "wallMs": 410
}
```

When the script fails, `ok` is `false`, `isError` is set and `error.code` is one
of `script_error`, `cpu_limit`, `memory_limit`, `stack_limit`, `deadlock`,
`result_too_large`, `wall_timeout`, `cancelled`, `runner_failed`, `busy`,
`invalid_arguments` or `unavailable`. The `calls` list still reports every inner
call. Statuses are `succeeded`, `tool_error`, `failed`, `rejected`, `declined`,
`not_started` and `in_flight`. `outcome: "unknown"` marks a call that may or may
not have taken effect.

MCPX never retries an inner call or a whole script on its own. After a failure,
use the call report, and a read where needed, before repeating anything.

### Byte counts

`bytes` and `resultBytes` are UTF-8 byte counts, measured while MCPX serializes
each value. They are bytes, not model tokens.

| Field                                  | What it measures                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls[].resultBytes`                  | One tool reply as MCPX builds it for the script: the JSON of `isError`, `content` and `structuredContent`. Present only when a reply arrived.                                                       |
| `bytes.toolResults.received`           | The sum of `resultBytes`, including replies withheld for size.                                                                                                                                      |
| `bytes.toolResults.sent`               | The part of `received` that MCPX sent to the script's runner process. A withheld reply (`resultWithheld: true`), or one that was ready only after the script had stopped, is received but not sent. |
| `bytes.discovery.received` and `.sent` | The same for `listServers`, `searchTools` and `getToolSchema` replies: the JSON text that the direct discovery tool returns. A schema over the reply limit is received but not sent.                |
| `bytes.result`                         | The JSON of the value the script returned to the client. Absent when the script failed.                                                                                                             |
| `bytes.logs`                           | The returned log lines.                                                                                                                                                                             |

Each reply is counted once, at one boundary. The `text` and `data` fields that
`mcpx.callTool` derives inside the script are copies of `content` and
`structuredContent` and are not counted again. A tool that returns both
`content` and `structuredContent` sends both, so both count. The counts
exclude the reply envelope between MCPX and the script, upstream `_meta`,
transport framing, the MCP framing of the outer result, refusals and error
replies, and the `calls`, `bytes` and other report fields. A call that never
replied, such as one that failed, was refused or was still in flight when the
script stopped, has no `resultBytes`; MCPX does not estimate data it did not
receive. `sent` is counted when MCPX passes the reply to the runner process. A
sent reply can still go unused: the script may not await it, or may finish
before the runner reads it.

To estimate what filtering saved, compare `bytes.toolResults.received` plus
`bytes.discovery.received` (roughly what direct calls would have sent to the
client) with `bytes.result` plus `bytes.logs` (what the script returned). The
returned text block also carries the report; measure it on the client if you
need its full size.

## Read-only scripts

`mcpx_execute_readonly` uses the same sandbox, discovery, permissions, caller
identity, authorization pass-through, audit, budgets and live target binding
as `mcpx_execute`. Before each inner call, MCPX runs it only when it is a
trusted read under the operator's policy:

- a built-in MCPX tool that MCPX itself defines as read-only;
- a tool whose exact name the operator lists in `CODE_MODE_TRUSTED_READ_TOOLS`;
- a tool marked `readOnlyHint: true` on a server whose exact name the operator
  lists in `CODE_MODE_TRUSTED_ANNOTATION_SERVERS`.

Entries with `*` do not count here. A pattern also matches tools and servers
added later, such as a new write tool without annotations, so it cannot be part
of a read-only promise. The same entries keep their pattern meaning for
per-call approval in `mcpx_execute`.

Every other call is refused before it runs, with `read_only_blocked`. That
includes tools with unknown side effects, tools that only a pattern matches,
and tools whose upstream claims `readOnlyHint: true` on a server the operator
does not trust. A tool whose definition declares a write (`readOnlyHint: false`
or `destructiveHint: true`) is refused even when its exact name is listed. Gateway wrappers such as `mcpx_execute`, `mcpx_call_tool` and
`mcpx_execute_readonly` itself are refused with `recursion_blocked`, and neither
tool can be reached through `mcpx_call_tool`. MCPX evaluates every call against
the definition it would dispatch, so a definition that changes between calls is
judged again.

These rules apply whatever `CODE_MODE_REQUIRE_TOOL_APPROVAL` says, and the
read-only tool never asks for approval inside the script. With no trust lists
configured, only built-in read-only tools run. The result carries
`readOnly: true`; each allowed call reports `approval: "trusted_read"` and each
refusal `status: "rejected"` with `errorCode: "read_only_blocked"`.

To find the tools that this tool runs before calling them, search with
`readOnly: true`. Each search result carries `readOnlyEligibility`, the same
decision for that tool, with a reason when it is not eligible:

```js
const reads = await mcpx.searchTools("jira issue", { readOnly: true });
const issue = reads.tools.find((tool) => tool.name === "jira__get_issue");
if (!issue) return (await mcpx.searchTools("jira__get_issue")).tools;
return (await mcpx.callTool(issue.name, { key: "PROJ-1" })).data;
```

The search is advice: the call is still classified when it runs. See
[read-only eligibility](lazy-tools.md#read-only-eligibility) for the reasons,
paging and older gateways.

The tool is annotated `readOnlyHint: true` and `destructiveHint: false`, so a
client can give it a separate approval rule, such as auto-approving it while it
still asks for `mcpx_execute`. MCPX cannot make a client auto-approve anything.
The read-only guarantee is only as accurate as the trust lists: list only tools
that cannot change state, and do not list upstream tools that call other tools
on the caller's behalf.

## Permissions, audit and approval

Each inner call uses the same gateway path as a direct `tools/call` from the same
session. MCPX checks tool visibility and permissions for the caller again on
every call, forwards the caller's authorization in the same way, uses the
existing upstream OAuth connections, and records the normal per-call
`tool_used` audit event, metrics and usage. Scripts cannot choose the identity,
headers, metadata or approval state of a call.

By default, the client applies its normal policy to `mcpx_execute` and MCPX
adds no approval prompts inside the script. An unattended client can run
allowed tools, including writes, without waiting for a person. The client's
policy sees one `mcpx_execute` call. Use MCPX permissions to restrict which
individual tools the script can call.

An operator can enable `CODE_MODE_REQUIRE_TOOL_APPROVAL=true` to require
separate approval inside scripts. In that mode, trusted reads skip the prompt:

- built-in MCPX tools that MCPX itself defines as read-only;
- tool names that the operator lists in `CODE_MODE_TRUSTED_READ_TOOLS`;
- tools marked `readOnlyHint: true` (and not destructive) on servers that the
  operator lists in `CODE_MODE_TRUSTED_ANNOTATION_SERVERS`.

Every other call, including any tool with unknown side effects, needs the user's
approval before it runs. An upstream `readOnlyHint` alone, the model's claims,
an approval of `mcpx_execute` itself, and client or provider hooks do not count.

MCPX asks through MCP form elicitation, as a request related to the running
`mcpx_execute` call. The prompt shows the tool, its server and the exact JSON
arguments, and asks for an explicit yes. Prompts appear one at a time. Each
approval covers one call with those arguments. The same call made again asks
again. Arguments longer than the
display limit are refused rather than shown partially. MCPX binds the approval
to the resolved tool, its definition, its server configuration, its upstream auth
generation and the caller. If any of them changed while the prompt was open,
the call does not run (`target_changed`).

In per-call approval mode, clients without form elicitation get
`approval_unsupported` for calls that need
approval; nothing runs. Use the tool directly in that case, so that the client's
own tool-approval flow applies. A gateway restart restores sessions without the
client's capabilities, so such a session also fails closed until the client
reconnects.

On 25 November 2026, Claude Code 2.1.332 and the Codex CLI 0.172.0 both declared
`elicitation: { form, url }` when they connected. Whether a host application shows
the prompt to its user depends on that application. A host that cannot ask the user
returns a refusal or cancellation, and the call does not run.

## Isolation and limits

Every execution starts a fresh Node process for the runner. The process has an
empty environment and runs under Node's permission model: no child processes,
workers, native addons, WASI or filesystem writes, and file reads only for the
runner and its engine packages. Host code generation from strings is disabled.
The script itself runs in a QuickJS WebAssembly context
([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)), which
has no host bindings except a string broker: requests leave as JSON text, and the
gateway validates and answers each one. MCPX kills the process when the script
ends, fails, times out or is cancelled.

| Limit                                            | Default                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| CPU time inside the script                       | 5 s (`CODE_MODE_CPU_MS`)                                      |
| Wall time, including approvals                   | 300 s (`CODE_MODE_WALL_MS`)                                   |
| Script memory                                    | 64 MiB (`CODE_MODE_MEMORY_MB`), plus a 64 MiB runner heap     |
| Script stack                                     | 256 KiB                                                       |
| Tool calls                                       | 50 (`CODE_MODE_MAX_TOOL_CALLS`)                               |
| Discovery requests                               | 100                                                           |
| Concurrent inner requests                        | 4, with at most 64 queued                                     |
| Concurrent executions per gateway                | 4                                                             |
| Code size                                        | 64 KiB                                                        |
| Request size from the script                     | 256 KiB                                                       |
| Tool or discovery result delivered to the script | 1 MiB                                                         |
| Final result                                     | 256 KiB                                                       |
| Console output                                   | 32 KiB                                                        |
| Approval wait per call                           | 120 s (`CODE_MODE_APPROVAL_TIMEOUT_MS`), within the wall time |

When the caller cancels, or a limit stops the script, MCPX schedules no new
calls and answers no queued ones. A call that an upstream is already processing
is not interrupted. It is reported as `in_flight` with an unknown outcome.

## Configuration

| Variable                                                                                                                    | Default    | Effect                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `ENABLE_CODE_MODE`                                                                                                          | `true`     | Advertise and serve `mcpx_execute` and `mcpx_execute_readonly`.                                     |
| `CODE_MODE_REQUIRE_TOOL_APPROVAL`                                                                                           | `false`    | Ask for approval inside scripts for calls that are not trusted reads.                               |
| `CODE_MODE_TRUSTED_READ_TOOLS`                                                                                              | empty      | Comma-separated tool names trusted as reads. `*` matches any characters, for example `docs__get_*`. |
| `CODE_MODE_TRUSTED_ANNOTATION_SERVERS`                                                                                      | empty      | Comma-separated server names (or `*` patterns) whose `readOnlyHint` annotations MCPX trusts.        |
| `CODE_MODE_CPU_MS`, `CODE_MODE_WALL_MS`, `CODE_MODE_MEMORY_MB`, `CODE_MODE_MAX_TOOL_CALLS`, `CODE_MODE_APPROVAL_TIMEOUT_MS` | see limits | Budget overrides.                                                                                   |

The trust lists apply when per-call approval is enabled and to
`mcpx_execute_readonly` in every mode, which counts only their exact entries.
List only tools that cannot change state. In per-call approval mode, a broad
pattern trusts future tools with matching names too.

## Known limits

- The runner shares the gateway container's network namespace. Network isolation
  comes from the engine, which offers scripts no network API.
- MCPX cannot interrupt an upstream call that is already running.
- Per-call auditing uses the existing `tool_used` event. Approval decisions,
  read-only refusals, byte counts and script outcomes go to the gateway log with
  an execution ID, not to the audit log.
- `mcpx_execute_readonly` relies on the operator's trust lists. MCPX cannot
  verify that a listed upstream tool really has no side effects.
