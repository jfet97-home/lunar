---
name: use-lunar-mcpx
description: Use an existing Lunar MCPX connection to discover upstream services and tools, inspect their schemas, execute authorized calls, and diagnose connection or sign-in problems through advertised management tools. For gateway usage, not source development, Docker deployment, upgrades, or credential migration.
---

# Use Lunar MCPX

MCPX is a gateway to connected MCP services. Use the tools actually advertised by
the current client; available integrations and permissions are installation-specific.
No source checkout, Docker inspection or local maintenance script is needed for
normal tool usage. Client namespaces can add prefixes to the names below.

## Discover and call upstream tools

On the lazy endpoint, start with `mcpx_list_servers({})` when advertised. It lists
services whose tools are visible to this caller; it is not a complete connection
health report. Choose a service relevant to the user's task, then:

1. Call `mcpx_search_tools` with service and task keywords.
2. Retrieve the selected target's schema with `mcpx_get_tool_schema`.
3. Call `mcpx_call_tool` using the exact returned target name and matching arguments.

Read [discovery and execution](references/discovery.md) for payload examples, paging,
full-endpoint behavior and handling uncertain results. Search a small shortlist
rather than loading the complete catalog. Do not invent target names or arguments.

If an upstream service exposes its own discovery mechanism, use its returned
instructions and schemas to discover the specific operation before executing it.
Resolve required account, project or resource identifiers from actual results;
an empty result does not establish that the wrong account or scope is configured.

## Connection and sign-in problems

Permitted built-in `mcpx__management_*` tools are called directly when advertised.
Read [connection and authorization](references/connections.md) when a server is
missing, failed, disabled or waiting for login. A management action changes gateway
state; use it only within the user's task and authorization.

## Report the actual outcome

Gateway discovery is not proof of upstream authentication or permission to write.
Check the target's description, schema and annotations, then execute only the
requested operation. Keep secrets out of chat and do not retrieve stored credentials.
Present user-facing sign-in URLs and device codes when the provider requires them.

Distinguish a tool being found, a connection being available, authorization being
completed and the actual upstream call succeeding. For writes, uncertain transport
outcomes require reconciliation rather than blindly repeating the operation.
