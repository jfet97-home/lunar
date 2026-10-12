# Discovery and execution

The lazy MCPX interface exposes `mcpx_list_servers`, `mcpx_search_tools`,
`mcpx_get_tool_schema` and `mcpx_call_tool`, plus permitted built-in management tools.
Use the current client definitions; older installations or cached sessions may
advertise a different catalog.

## Payloads

These examples show MCP tool names and JSON arguments, not shell commands.

```text
mcpx_list_servers({})
mcpx_search_tools({"query": "<service> <task>", "limit": 5})
mcpx_get_tool_schema({"name": "<exact name returned by search>"})
mcpx_call_tool({"name": "<same exact name>", "arguments": {}})
```

Replace the final arguments object with the input required by the selected schema.
An empty object is valid only for a target that accepts it. Client tool prefixes
belong to the advertised callable tool; names inside discovery payloads are the
exact gateway target strings returned by search.

Search returns names, descriptions and annotations, not complete input schemas.
The default limit is five and the maximum is twenty. If relevant results are missing,
refine the service/task query or use `offset` with a returned `nextOffset`. Keep
paging bounded to the user's task. Schema retrieval precedes execution.

Server listing uses visible tool metadata. Disabled, blocked or inactive services
can be absent; a service awaiting authentication can appear if its login tool is
visible. Permissions are checked again when tools are called.

## Full endpoint and management tools

On a full-catalog connection, use directly advertised upstream tools with their
supplied definitions; a discovery wrapper is not mandatory. Do not change the
client's endpoint just to perform an ordinary task.

Built-in `mcpx__management_*` tools are directly callable when advertised on either
interface. They do not need to be searched for or wrapped in `mcpx_call_tool`.
Use their current schemas; having management access does not imply authorization
to change unrelated connections.

## Results and retries

The wrapper returns the upstream tool result without converting it into a new
success contract. Inspect `isError`, returned text and structured result fields.
Search success, schema retrieval or an HTTP-level success is not proof that the
requested business operation completed.

The execution wrapper is conservatively marked potentially destructive. Assess the
selected target and the user's request rather than assuming all calls are reads.
Read-only calls may be retried when appropriate. For an uncertain write, look for
the existing result through a read, provider operation ID or supported idempotency
mechanism before any retry. A reconnect does not retry the upstream operation.

If a known tool is not advertised, inspect the current server/permission state
instead of guessing a hidden name. Client sessions may retain stale definitions;
report the discrepancy without reconfiguring or restarting clients implicitly.
