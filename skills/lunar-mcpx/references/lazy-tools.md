# Lazy tool endpoint

Use `http://localhost:9000/mcp/lazy` when a client should discover individual
MCPX targets on demand. The endpoint is built into MCPX and exposes these core tools:
`mcpx_search_tools`, `mcpx_get_tool_schema`, and `mcpx_call_tool`.

Newer fork images also expose `mcpx_list_servers`. If it is advertised, call it
with no arguments at the start of the session. It returns server names with
tools visible to the caller and existing descriptions from upstream handshake
metadata or the MCPX catalog. Missing descriptions are omitted, and each
description is limited to 300 characters. Listing makes no upstream tool calls.
Older installed images may still expose only the three core tools; inspect the
live endpoint rather than assuming a source change has been deployed.

Search with the upstream service and task, or with an exact gateway target name.
Search returns target names, descriptions, and annotations, not input schemas. It
defaults to five results, allows at most 20 per page, and supports an offset.
Avoid enumerating the complete catalog. Retrieve the input schema for one chosen
target with `mcpx_get_tool_schema(name)`, then execute it with
`mcpx_call_tool({name, arguments})`. The call runs through MCPX's normal upstream
authorization, authentication, and audit path.

MCPX performs multilingual semantic search with the local
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` model and keyword matching. The
embedding index is stored at `.mcpx/tool-embeddings.json`; keyword search remains
available if model initialization fails. No separate model
service or vector database is needed.

The full `http://localhost:9000/mcp` endpoint remains available for clients that
need its complete catalog and direct target calls. The Lunar MCPX status helper
uses that full endpoint for a read-only tool inventory.

Images with built-in management capabilities include a `mcpx` entry when its
tools are visible to the caller. Newer images also advertise the permitted
`mcpx__management_*` tools directly alongside the four discovery tools. Their
schemas arrive in `tools/list`, and management calls can use their names directly
without search or a wrapper. Only upstream targets require the on-demand
search/schema/call flow. Older images can require discovery for management too;
refresh cached client definitions after upgrading. Management executes inside
the gateway. Read [mcpx.md](../mcpx.md) for
server configuration, backup, and login/logout behavior.
