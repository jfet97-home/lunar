# Code Mode

`mcpx_execute` runs JavaScript inside MCPX. Use it to chain tool calls and filter
their results server-side, so only the final value reaches the conversation.
It is advertised on both the full and the lazy endpoint when the gateway
enables it. Use the current tool definition; older gateways do not offer it.

## Write the script

`code` is the body of an async function. Use `await`, and `return` a
JSON-serializable value that is as small as the task allows.

```text
mcpx_execute({"code": "const hits = (await mcpx.callTool(\"<server>__search\", {\"query\": \"<terms>\"})).data; return hits.slice(0, 5).map((hit) => hit.id);"}
```

Inside the script:

- `await mcpx.listServers()`, `await mcpx.searchTools(query, { limit, offset })`
  and `await mcpx.getToolSchema(name)` return the same data as the discovery
  tools. Discover a schema before calling an unfamiliar tool.
- `await mcpx.callTool(name, args)` returns
  `{ isError, content, structuredContent, text, data }`. `data` is the structured
  result, or the text parsed as JSON when possible.
- A refusal by the gateway rejects with an error whose `code` explains it, such
  as `permission_denied`, `approval_declined` or `call_limit`. Catch it when the
  script can continue without that call.
- `console.log` output is returned. There is no filesystem, network, timer or
  module access.

Use exact tool names returned by discovery or listed by the full endpoint. Do not
call `mcpx_execute` or `mcpx_call_tool` from inside a script.

## Approvals

Each inner call keeps the caller's gateway permissions. Normally the client
applies its approval policy to `mcpx_execute` and the script runs without
additional prompts. An operator can enable per-call approval for calls other
than trusted reads. In that mode, the client asks the user to approve the exact
tool and arguments. A declined or unanswered prompt stops that call. If the
client cannot show the prompt, the script gets `approval_unsupported`.

## Read the result

The result is JSON with `ok`, `result` or `error`, `calls`, optional `logs` and
`wallMs`. Each entry in `calls` has a status such as `succeeded`, `tool_error`,
`declined`, `rejected`, `failed`, `not_started` or `in_flight`.
`outcome: "unknown"` means the call may have taken effect.

After a failure, report which calls completed. Before repeating a write, check
for its effect with a read; never rerun a whole script just to retry one failed
call. Limits cover CPU time, total time, memory, call count and result size; when
a result is too large, request less data instead of repeating the call.
