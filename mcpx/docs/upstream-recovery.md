# Upstream connection recovery

MCPX detects transport failures through periodic pings and tool calls. After the
configured failure threshold, it marks the upstream connection failed and
automatically retries. Failed initial connections are also retried.

Retry waits start at `UPSTREAM_RECONNECT_BASE_DELAY_MS` (30 seconds by default),
double after each failure, and stop increasing at **five minutes**. Attempts
continue while the server is unavailable. A successful connection resets the
backoff and restores tool discovery. The cap covers the wait between attempts;
connection timeouts and the handshake take additional time.

Every failed connection transition schedules recovery, including capability
discovery failures after OAuth completion or silent re-authentication. The old
watchdog is stopped while reconnecting. SDK request timeouts and closed
connections count as transport failures; ordinary MCP application errors do not.
Tool-call timeouts are inconclusive while recent successful pings show the server
is healthy. They never reset failed-ping history; without a recent heartbeat they
count as failures, including on servers that do not implement ping.
Unexpected recovery errors are caught and retried rather than escaping the timer.

Recovery retains saved configuration and authentication. It retries connection
handshakes and capability discovery, **not failed tool calls**. A rebooted
upstream normally needs no gateway restart or token replacement. DNS and network
reachability remain prerequisites.

An HTTP 404 on a request carrying `MCP-Session-Id` means the upstream session
has expired, commonly after a restart. MCPX immediately replaces that connection
and initializes without the old session ID, retaining the URL, headers and saved
authentication. Concurrent expiry signals share one recovery attempt. This also
applies to pings and optional notification streams; initialization errors without
a session ID and ordinary tool errors do not trigger this path.

For an optional GET returning 404, MCPX first sends a bounded ping on the same
session. A usable POST session is retained: some servers incorrectly answer an
unsupported GET with 404 rather than 405. This avoids repeated initialization on
those servers. A ping that also confirms session expiry triggers replacement;
other probe failures use the normal watchdog thresholds and reconnect backoff.

The interrupted tool call still fails and is never replayed automatically. Check
the outcome of a write before submitting it again. If initialization fails, normal
connection retries continue. Removal, logout, configuration replacement or shutdown
supersedes recovery; a late handshake cannot restore an obsolete connection.
The interrupted call waits for recovery and can surface the SDK's generic
`Connection closed` error rather than the original HTTP 404.

## Retry one server now

Call `mcpx__management_reconnect_server` with `{ "name": "your-server" }` to
cancel its pending wait, reset the backoff, and immediately attempt a failed
connection. Concurrent requests do not create parallel attempts. Connected,
connecting and pending-auth servers are left alone; pending-auth requires login.
The action never replaces configuration, deletes credentials or replays calls.
Enabling a server controls tool availability and does not force reconnection.

## Refresh stale tool schemas

Call `mcpx__management_refresh_server` with `{ "name": "your-server" }` to fetch
the current tool definitions from a connected server, including same-name input
and output schema, description and annotation changes. It uses the existing
connection, preserves configuration and credentials, leaves unrelated upstreams
alone, and never executes a tool. Discovery failures return an error and retain
the last known catalog; a connection replaced during discovery cannot publish
stale results. A pending-auth server still needs login.

An explicit same-configuration server update also refreshes tool definitions.
Description-only UI edits still avoid discovery. Disable/enable changes visibility
only; reconnect retries only failed connections. Upstream list-change notifications
continue to refresh automatically when received. A successful refresh updates both
the full and lazy catalogs and sends list-change notifications when definitions
change. A downstream client may still require its supported discovery refresh.

## Notification streams and configuration reload

Both normal and OAuth Streamable HTTP connections use a bounded notification
stream retry budget: 15 attempts, with waits growing from one to 30 seconds.
This lets supported streams survive brief outages. An optional GET returning
405 remains valid and causes no retry loop. Closing the client prevents further
network requests. Longer upstream outages are handled by full connection recovery.

`POST /admin/reload` re-reads configuration and clears all old connections,
watchdogs and retry timers, including failed servers removed from the file.
It retains credentials and cancels obsolete pending login flows. Stale in-flight
connections cannot restore removed servers. Subscriptions and the token-expiry
monitor are installed once; reload does not duplicate them. Existing downstream
sessions are closed, so clients reconnect as before.
