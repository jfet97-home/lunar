# Operations

## New services and startup changes

Follow `mcp-service-setup` before adding an upstream service, host package,
transport adapter, background process or startup mechanism. These command examples
operate the existing gateway; they do not authorize a new service or a different
lifecycle. Ask about the actual source repository and private runtime paths before
creating files. Docker `up -d`, launchd/systemd, login/boot jobs, schedules and
restart policies must be part of the explicitly agreed plan.

## Read-only inspection

Run `scripts/settings.sh` from the skill folder before gateway settings,
persistence, or deployment work. It reads the installed image, restart policy,
ports, volumes, operational environment, saved server configuration, application
settings, tool counts, and pending authentication. Credential fields, headers,
upstream environment values, command arguments, and URL query values are
redacted; token files are never opened.

`scripts/status.sh` is the shorter health and inventory check. Both helpers
create a temporary MCP client session on the full `/mcp` endpoint, then close
it. They do not call upstream tools, change settings, sign in, or restart
services. Their inventory is not the smaller catalog exposed by `/mcp/lazy`.
For ordinary tool discovery, use the supplied MCPX tools instead of Docker.

## Local entrypoints

- Compose file: `~/.config/mcpx/compose.yaml`.
- Docker context: `desktop-linux`.
- Compose service: `mcpx`.
- Canonical cloned fork: `~/Developer/lunar-jfet97`, branch `main`.
- MCPX source subdirectory: `~/Developer/lunar-jfet97/mcpx`.
- Local main-image builder: `~/Developer/lunar-jfet97/mcpx/scripts/build-main-image.sh`.
- UI: `http://localhost:5173/`.
- Full MCP endpoint: `http://localhost:9000/mcp`.
- Lazy MCP endpoint: `http://localhost:9000/mcp/lazy`.
- User login task: `~/Library/LaunchAgents/dev.docker.autostart.plist`.

These are bootstrap locations, not a copy of current settings. The inspection
scripts expose the actual Compose deployment and running configuration. If a
location has changed, inspect it and adjust the entrypoint or script overrides.
Do not treat older operator notes as an authoritative server inventory.

For source changes and image builds, follow the canonical-main rule in
[the skill entrypoint](../SKILL.md#canonical-source-and-deployment) and
[the fork workflow](pagination.md#preferred-fork-and-update-workflow).
A dirty checkout is work to preserve and reconcile, not a reason to deploy a
permanent scratch-only patch. Service inventories should list the cloned fork
first and identify any temporary build checkout separately.

Helper overrides are `MCPX_DOCKER_BIN`, `MCPX_DOCKER_CONTEXT`,
`MCPX_COMPOSE_FILE`, and `MCPX_SERVICE`. The helpers use the selected service's
container ID instead of assuming a fixed container name.

## Start, stop, or restart

```sh
open -gj -a /Applications/Docker.app
docker --context desktop-linux compose -f ~/.config/mcpx/compose.yaml up -d mcpx
docker --context desktop-linux compose -f ~/.config/mcpx/compose.yaml restart mcpx
docker --context desktop-linux compose -f ~/.config/mcpx/compose.yaml stop mcpx
docker --context desktop-linux compose -f ~/.config/mcpx/compose.yaml logs --tail 100 mcpx
launchctl print gui/$(id -u)/dev.docker.autostart
```

Choose the operation requested; do not execute this whole list. The login task is
a one-shot job, so an exited job with code 0 is expected. Inspect the actual
restart policy rather than assuming the container starts automatically.
A sandbox Docker socket denial is not proof the engine is stopped.

## Upstream recovery

The fork retries failed upstream connections automatically, with waits capped at
five minutes. Closed-connection errors count as failures. Tool request timeouts
are neutral while a recent successful ping proves the server is reachable;
otherwise they count as failures. Neutral timeouts never clear failed-ping
history. OAuth capability-discovery failures also schedule recovery. Recovery preserves
credentials and does not automatically replay tool calls with unknown outcomes.

Inspect management status and the actual endpoint before changing credentials.
For a failed server, use the advertised `mcpx__management_reconnect_server` with
its name to retry immediately. Enabling tools does not reconnect the transport.
Healthy, connecting and pending-auth servers are not disturbed by retry; a
pending-auth server needs its normal login flow. Verify a real read-only call
after recovery rather than relying only on the management receipt.

`POST /admin/reload` now re-reads saved configuration without reinstalling
subscriptions or the token-expiry monitor. It clears old retry/watchdog state,
retains credentials and cancels obsolete pending login flows. It closes all
downstream sessions, so prefer the single-server action for an isolated failure.
Supported HTTP notification streams get a bounded retry budget of 15; optional
GET 405 is not an error. See the fork's `mcpx/docs/upstream-recovery.md` for details.

## Configuration and persistence

Discover mounted volumes through the helper before a replacement, backup, or
cleanup. Settings changed in the UI live in a mounted configuration volume;
OAuth client information and tokens live in a separate mounted state volume.
Docker Desktop can report the same host bind source with or without a
`/host_mnt` prefix. Normalize that prefix when comparing mounts; verify named
volume identities and destinations independently.
Standalone MCPX stores tokens as unencrypted JSON. Keep backup destinations
private and do not print or commit credential files.

The image's `init` Compose service, when present, establishes volume ownership.
It is not a second long-running application. Use it for a fresh deployment or an
investigated ownership repair, not every start.

The container's default exec directory is different from the server process's
working directory. Use absolute configuration paths or the server directory
`/lunar/packages/mcpx-server`; do not assume relative `config/mcp.json` resolves.
The settings helper uses configured paths relative to the application directory.

## User-managed backups

The user can create a full backup through Saved Setups > Export Full Backup.
Create or export a backup only when requested. The default destination is
`~/.config/mcpx/backups`; Docker needs a writable host mount for that destination
and read-only mounts for optional deployment and client configuration files.
Use the fork's `mcpx/docs/local-saved-setups-and-export.md` for export coverage
and manual restore instructions.

## Lazy tool endpoint

The built-in lazy endpoint at `/mcp/lazy` is an alternative MCPX route, not a
separate service. It exposes `mcpx_search_tools`, `mcpx_get_tool_schema`, and `mcpx_call_tool`
instead of the full upstream catalog. Newer fork images additionally expose
`mcpx_list_servers`; call it first when advertised to discover the visible MCP
servers and their existing descriptions. Use the endpoint for clients that can search for a
target, retrieve its exact schema, and then execute it through `mcpx_call_tool`. The
full `/mcp` endpoint remains available for clients that need the full catalog
and for the status helper's read-only inventory.

On images supporting direct administration, `/mcp/lazy` also advertises permitted
`mcpx__management_*` tools with their schemas. Invoke these built-ins directly;
upstream targets continue using discovery. Clients with a cached earlier catalog
need an MCP connection refresh to receive the added definitions.

Tool search uses a multilingual embedding model
(`Xenova/paraphrase-multilingual-MiniLM-L12-v2`) with keyword matching. It
returns target names, descriptions, and annotations, but not schemas. Search
returns five results by default, with a maximum of 20 per page and offset-based
pagination. MCPX stores the local embedding index in `.mcpx/tool-embeddings.json`.
If the model fails, keyword search remains available. No external embedding
service is required.

For upgrades, inspect the relevant volumes and retain the old image digest.
Check the candidate image's version, architecture, OAuth support,
and storage layout. Repository main and a published image may differ. Do not
unpin an image or promise a source-only feature without verifying the candidate.
Source: https://github.com/TheLunarCompany/lunar/tree/main/mcpx

## Clean up old images after an upgrade

Finish a verified gateway upgrade by removing obsolete MCPX images from the
selected local Docker context. Include superseded registry images and temporary
local builds. Keep the previous registry digest in the upgrade report so it can
be pulled again for rollback.

Inspect `docker image ls --digests`, `docker ps -a`, and `docker system df` first.
Keep the image configured in Compose and every image referenced by a running or
stopped container. Identify unused MCPX images by repository and source labels,
then remove their exact tags or digests with `docker image rm` without forcing.
Use explicit references to keep this maintenance scoped to MCPX.

Image cleanup does not include containers, volumes, or build cache. After removal,
check disk usage again, rerun the gateway status helper, and report which images
were removed and the observed storage change. Layers retained by build cache or
other images may limit the space reclaimed.

## Adding a remote server

Prefer the advertised built-in `mcpx__management_add_server` with the desired
name and transport configuration; see [mcpx.md](../mcpx.md). Inspect its live
status afterward. For OAuth, use `mcpx__management_login_server` and present the
returned link to the user. Complete a real read-only call after sign-in.

The UI is an alternative: choose Add Server > Custom and paste a server map:

```json
{
  "example": {
    "url": "https://example.com/mcp"
  }
}
```

The UI can infer the remote transport. Verify the saved settings with the helper.
Pending auth plus Get access is expected for OAuth. The button opens an upstream
authorization tab; user sign-in and consent may require the ordinary browser.
A catalog omission is not evidence the server is incompatible.

The Custom editor uses Monaco with Chromium EditContext. Its role=textbox may
initially be hidden, making direct fill/press-key targeting time out. Click the
visible `.monaco-editor`, select all with ControlOrMeta+A, then paste. A browser
ClipboardEvent carrying DataTransfer `text/plain` to the focused editor worked
when ordinary automation could not paste. Wait for the visible editor to update
before clicking Add; its immediate DOM snapshot can still show the old example.

## Provider configuration

The gateway exposes one MCP endpoint for native clients. Each provider harness
still needs an entry in its effective configuration. T3 supplies the shared chat
UI; it does not install all external MCPs into every provider. Custom provider
home directories can isolate native settings and credentials.

Verify a new gateway entry before deleting equivalent direct entries. Inspect
configuration selectively and redact credential fields. An MCP gateway does not
supply a missing upstream feature such as document conversion or image rendering.


Claude's user MCP entries live in `${CLAUDE_CONFIG_DIR}/.claude.json` when that
environment variable is set, otherwise `~/.claude.json`. Inspect the effective
directory used by the running provider. Codex uses
`~/.codex/config.toml`; `cx` now forwards to the default configuration after the
Nix wrapper change is activated. Do not recreate a `local` profile. Add one HTTP
entry named `mcpx` pointing to the native-client endpoint above. Keep upstream
OAuth in the gateway rather than duplicating upstream connections in each client.

Guidance skills remain provider-local. Removing a plugin's MCP connection does
not automatically preserve its guides: copy the official guidance into each
provider's skills directory and adapt its tool references to the gateway's live
names and schemas. Do not assume old examples include current required arguments.

## Refresh clients after an upgrade

After upgrading the gateway, refresh discovery in both Claude and Codex. Keep
the existing MCP entries, endpoint, and credentials; rediscover the tools and
initialization instructions through each real client.

For Claude, use the MCP menu's Reconnect action for `mcpx`. For a headless
Claude client, its stream-JSON control protocol supports `mcp_reconnect` with
`serverName: "mcpx"`, then `mcp_status` to inspect the connected server's tools.
Initialize the client without sending a user message; discovery does not need
a model turn. A successful `claude mcp get mcpx` health probe alone does not
verify tool-cache invalidation. If Claude is not running, a temporary control
client can reconnect and verify its effective configuration.
Source: https://code.claude.com/docs/en/mcp

For Codex app-server, send `config/mcpServer/reload` to the running server;
this reloads configuration and queues a refresh for loaded threads. Verify
`mcpServerStatus/list` includes the gateway's expected tool names. Discover
the managed daemon's control socket with `codex app-server daemon version`.
That socket uses WebSocket over Unix, not newline-delimited JSON; initialize
the WebSocket client before sending app-server requests. Do not restart the
daemon or interrupt unrelated work just to refresh MCP discovery.
Source: https://learn.chatgpt.com/docs/app-server

A host may run its own Codex app-server over private stdio, independently of
the managed daemon. Reloading the daemon does not refresh that separate
process. For a retained lazy session whose discovery tool definitions are
unchanged, call `mcpx_list_servers`, retrieve a newly available target's schema,
and execute a small read-only target through that same session. Successful calls
verify that the session can use the updated gateway; no process restart is needed
to load those target schemas on demand. If the retained connection fails or its
definitions remain stale, use the host's supported session refresh, or report
that the retained provider session needs restarting. Reopening a UI tab
alone may reuse the same process and tool catalog. Do not claim that a
provider-settings or model-list refresh also refreshes MCP connections.

An `authStatus: "unsupported"` from Codex can be normal for an HTTP gateway
whose incoming authentication is disabled. Verify its tools and read-only calls
rather than interpreting that status alone as a failed MCP connection.

On images advertising `mcpx_list_servers`, verify that both clients discover
all four discovery tools plus any permitted direct management definitions. Call
`mcpx__management_list_servers` directly when advertised to verify management
without search. Call `mcpx_list_servers` to check the visible server
names and existing descriptions. On older images, verify the tools actually
advertised instead. Finish with the live gateway inspection and preserve
configuration and OAuth volumes throughout.

## Client status in the UI

`Unresponsive` labels describe downstream client sessions. A short-lived probe
can leave this label when its notification stream closes without deleting its
MCP session. It does not establish that an upstream server or its OAuth is broken.
The next inbound client request clears the flag. Proper session deletion closes
the session immediately; otherwise normal idle expiry handles it.

Verify the real client with a read-only tool call before investigating credentials.
Inspection helpers can also appear as separate clients in the UI. Do not restart
the gateway solely to remove their labels.


## Removing a server during a running session

Inspect command-line override keys before removing an MCP entry. An older `cx`
wrapper supplied `mcp_servers.atlassian.oauth.client_id` with `-c`. Deleting the
server's URL left the running session with an orphan MCP table, producing
`invalid transport in mcp_servers.atlassian`. Codex's retained-session reload
hid that error behind `failed to load workspace requirements`, including in
automatic approval review. Fresh CLI checks without the old override missed it.

Retain a disabled server entry with a valid URL until the wrapper update is
activated and the client is restarted without the old override. Then remove the
compatibility entry. Validate with the actual retained override or running client;
a TOML parse and a fresh process alone do not verify this migration.

An already-running `-p local` process can recreate a local file containing UI and
hook state after it is removed. Transfer needed settings to the default config,
activate the new wrapper, and start without that profile before treating its
removal as permanent. Do not repeatedly delete files the old process is writing.
