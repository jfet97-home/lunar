# Code Mode

Code Mode adds the `mcpx_execute` tool. It runs a short JavaScript program inside
MCPX, so a client can chain tool calls and filter large intermediate results
without sending each one through the model. Only the program's final value
returns to the client. Code Mode works with any MCP client and model provider.

`mcpx_execute` is advertised in `tools/list` on both `/mcp` and `/mcp/lazy`, and
the initialize instructions of both endpoints describe it. Normal discovery and
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

| Function                                     | Returns                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `mcpx.listServers()`                         | The `mcpx_list_servers` result for the caller.                                        |
| `mcpx.searchTools(query, { limit, offset })` | The `mcpx_search_tools` result: names, descriptions and annotations, without schemas. |
| `mcpx.getToolSchema(name)`                   | One full tool definition, fetched on demand.                                          |
| `mcpx.callTool(name, args)`                  | `{ isError, content, structuredContent, text, data }`.                                |

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

`console.log`, `info`, `warn`, `error` and `debug` output is returned with the
result. Scripts have no filesystem, network, timers, modules, process access or
credentials.

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
      "durationMs": 120
    }
  ],
  "logs": ["..."],
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

| Variable                                                                                                                    | Default    | Effect                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `ENABLE_CODE_MODE`                                                                                                          | `true`     | Advertise and serve `mcpx_execute`.                                                                          |
| `CODE_MODE_REQUIRE_TOOL_APPROVAL`                                                                                           | `false`    | Ask for approval inside scripts for calls that are not trusted reads.                                        |
| `CODE_MODE_TRUSTED_READ_TOOLS`                                                                                              | empty      | Comma-separated tool names that run without approval. `*` matches any characters, for example `docs__get_*`. |
| `CODE_MODE_TRUSTED_ANNOTATION_SERVERS`                                                                                      | empty      | Comma-separated server names (or `*` patterns) whose `readOnlyHint` annotations MCPX trusts.                 |
| `CODE_MODE_CPU_MS`, `CODE_MODE_WALL_MS`, `CODE_MODE_MEMORY_MB`, `CODE_MODE_MAX_TOOL_CALLS`, `CODE_MODE_APPROVAL_TIMEOUT_MS` | see limits | Budget overrides.                                                                                            |

The trust lists apply only when per-call approval is enabled. List only tools
that cannot change state. A broad pattern trusts future tools with matching
names too.

## Known limits

- The runner shares the gateway container's network namespace. Network isolation
  comes from the engine, which offers scripts no network API.
- MCPX cannot interrupt an upstream call that is already running.
- Per-call auditing uses the existing `tool_used` event. Approval decisions and
  script outcomes go to the gateway log with an execution ID, not to the audit log.
