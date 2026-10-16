# Connection and authorization

A missing integration is a setup question, not permission to provision a service.
For a new connection or changed deployment architecture, follow
`mcp-service-setup` before any package, configuration or process changes. Establish
the repository, runtime, access and startup choices with the user; reuse explicit
answers instead of re-asking them during an approved setup.

Use management tools advertised by the current client. The names below are gateway
names; the client may add a namespace prefix. Inspect their supplied schemas first.

| Tool | Usage |
|---|---|
| `mcpx__management_list_servers` | Read configured names, transports, enabled state, connection state and whether OAuth is active. |
| `mcpx__management_login_server` | Start a provider sign-in for one configured server. |
| `mcpx__management_reconnect_server` | Retry one failed connection while preserving its configuration and credentials. |
| `mcpx__management_refresh_server` | Fetch current tool schemas from one connected server without replacing its connection or credentials. |
| `mcpx__management_enable_server` | Make an intentionally disabled integration available when requested. |
| `mcpx__management_disable_server` | Disable an integration while retaining its configuration and authentication when requested. |

The listing takes `{}`. The named operations take `{"name": "<configured server>"}`;
use the actual returned server name. Listing does not expose stored tokens, headers
or environment credentials, and there is no need to inspect those for ordinary usage.

## Sign-in

When the user's task requires an unavailable authenticated integration, inspect its
state. If OAuth sign-in is appropriate and authorized, call login for that server.
Its result contains `authorizationUrl` and may include `userCode`. Present these
to the user to complete the provider's browser or device-code flow.

Login starts the flow; it does not itself prove consent or working upstream access.
After the user completes it, inspect connection state and perform a bounded,
read-only upstream call relevant to the task when permitted. Keep the authentication
state, granted scope and successful call as separate facts in the report.

Do not ask for tokens in chat, retrieve stored credentials or copy credentials
between environments. If a provider needs a secret rather than OAuth, use the
available private secret-entry mechanism or report that setup is required.

## Failed or missing connections

For a failed configured server, an authorized reconnect is narrower than replacing
configuration, logging out or restarting the gateway. Reconnect does nothing for
connected, connecting or pending-auth servers and never retries a failed tool call.

For stale upstream schemas, call `mcpx__management_refresh_server` for the affected
connected server. It updates the gateway catalog and notifies downstream clients
when definitions change. Replacing a server configuration with the same values also
refreshes its tools. Neither action needs removal, logout or a gateway restart.
Description-only edits from the UI keep their existing lightweight behavior.

An absent discovery result can reflect permissions, a disabled integration, failed
connectivity, pending authentication or stale client definitions. Use the available
evidence to distinguish them; do not infer a specific failure from absence alone.

Adding or replacing a connection, logout, removal and backups are separate owner
actions. Logout clears MCPX's saved OAuth state, not the provider's browser session;
removal also deletes saved configuration. Neither is a routine sign-in retry.
These usage instructions do not authorize changing deployment, Docker state or
credential storage to fix a connection.
