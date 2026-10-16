# Built-in gateway management

Before adding a new connection or provisioning a service for it, follow the
`mcp-service-setup` discussion. Management-tool availability is not authorization
to choose deployment paths, install a host package or launch a background service.
Previously authorized maintenance keeps its existing scope.

Server namespace: `mcpx`. This provider runs inside the gateway; do not register
a separate upstream server for it. Its tool schemas were checked on 2026-10-08;
discover the current catalog before assuming an operation is installed.

Inspect the live gateway before assuming that a source feature is installed.
Maintained fork images can provide management capabilities directly, without an
upstream connection back to MCPX or a separate management MCP process.

Both `/mcp` and `/mcp/lazy` advertise permitted `mcpx__management_*` tools with
their schemas. Call the selected management tool directly; no search, schema
lookup, or wrapped call is required. The lazy endpoint adds these definitions
alongside its four upstream discovery tools. Existing search/schema/wrapped-call
usage remains compatible, including for older images that expose management only
through discovery. If an already-open client still shows only the four discovery
tools, refresh its MCP connection to receive the additional definitions.

The management capabilities cover:

- `mcpx__management_list_servers`: configured servers, including disabled and
  pending-auth servers, with connection status and enabled state.
- `mcpx__management_add_server` and `mcpx__management_update_server`: a server
  name plus its stdio command/args/env or remote transport URL/headers. Update
  replaces connection configuration, retaining catalog identity. Omitted remote
  headers are cleared, including Authorization; include every setting that should
  remain. Do not assume an update merges omitted credentials from the old server.
- `mcpx__management_enable_server` and `mcpx__management_disable_server`:
  change availability without deleting configuration or clearing authentication.
- `mcpx__management_reconnect_server`: retry one failed connection immediately,
  cancelling its scheduled wait and resetting backoff while preserving credentials.
  Connected, connecting and pending-auth servers are left alone. `retried: true`
  means an attempt ran; verify connection state and a read-only upstream call.
  This action does not replay failed tool calls.
- `mcpx__management_remove_server`: delete configuration, disconnect the server,
  and clear its saved OAuth authentication. Strict removal reports transport,
  credential cleanup, and persistence failures instead of returning success.
  A failure can leave partial cleanup; inspect current state before retrying.
  Configured names retain their spelling for OAuth cleanup even though tool
  input uses normalized names.
- `mcpx__management_create_backup`: `mode: "setup"` for a saved configuration
  snapshot, or `mode: "full"` for the private local export. A setup snapshot
  follows existing local/Hub ownership and excludes OAuth token files; it can
  still contain credentials embedded in configuration. Full export uses
  `MCPX_BACKUP_DIR`, normally the host's `~/.config/mcpx/backups` through the
  Docker mount. Inspect returned inclusions and omissions rather than assuming
  every optional deployment/client source was available.
- `mcpx__management_login_server`: initiate OAuth and return the sign-in URL
  and optional device code. Present them to the user; browser sign-in and
  consent remain interactive. Verify status after the user completes the flow.
  A fresh login produces a new authorization request; use its latest link.
- `mcpx__management_logout_server`: clear saved OAuth state and cancel pending
  sign-in while keeping server configuration. This does not revoke the user's
  account at the external provider. Static env/header credentials need a
  configuration edit instead.

The gateway's existing incoming authentication applies. On a local deployment
with authentication disabled, the management tools require no separate key.
Per-consumer/client tool permissions for service `mcpx` control their visibility
and execution. Management permission grants administration of upstream servers,
including servers whose regular tools are hidden from that client. Use exact
live tool names when configuring access; the unprefixed capability names are
`management_*`. Keep an unauthenticated deployment bound to loopback; do not
publish its management capabilities to a LAN or public interface as part of
routine maintenance.

Configuration changes keep the same persistence, catalog, stdio, and Docker
policy checks as existing management paths. Tool results omit credential-bearing
configuration; never print full backup files, headers, environment values, or
OAuth token files while verifying an operation. The reserved name `mcpx` keeps
management operations from deleting or disabling their own built-in provider.

After a mutation, inspect the selected server's live state. A successful add or
update does not guarantee the server has authenticated or connected. Management
calls are not replayed from the ordinary upstream result cache, so status and
configuration operations reach the current service state.

A disabled server can still have `state: "connected"`; `enabled: false` controls
whether its ordinary tools are usable. `management_list_servers` includes such
servers for administration, whereas lazy `mcpx_list_servers` lists providers with
tools visible to the caller and can omit disabled upstreams.

For Docker, volumes, client refresh, and saved-setup UI details, read
[operations](references/operations.md). Login through this provider handles
upstream MCP OAuth; a server such as [Teams](teams-mcp.md) may instead authenticate
its backing API through its own tools.
