# Private T3 Telegram bot

Configured main-bot namespace: `raspfet-telegram-t3`. Endpoint verified on 2026-10-13:
`http://192.168.1.47:8082/mcp`, with the existing bearer authorization header.
MCPX connects directly to the Pi over the home LAN. The owner explicitly chose
HTTP and accepted unencrypted tokens and MCP traffic on that trusted network.
Preserve this choice; do not reintroduce TLS, hostname resolution or a tunnel
without a new decision. The public Telegram webhook retains HTTPS at
`https://hooks.raspfet.dev/t3/telegram/main` and its separate webhook secret.

The bridge publishes MCP on `192.168.1.47:8082`; loopback `127.0.0.1:8082` is
retained for diagnostics. SDK DNS-rebinding protection permits the exact LAN
Host/Origin and local diagnostic addresses. Every MCP request requires the
bearer token. There is no client-IP allowlist; possession of the token grants
access, rather than identifying a particular physical Mac.
The Pi now serves multiple bots at this same endpoint. Each MCPX connection must use
one bot's server-issued MCP bearer; credentials select the bot before tool execution.
Tool arguments cannot switch bots. Each bot has one configured owner/private chat.
Mac and Lima VM gateways consume this Pi service; it is not deployed inside Lima.

This MCP connection uses no DNS, Traefik, TLS or SSH tunnel. The previous
HTTPS MCP listener on 8443 and the temporary Mac `extra_hosts` mapping are
retired. The public hostname continues to serve the incoming webhook only.
The former Mac port 18766 tunnel and LaunchAgent remain retired.

Canonical Pi source/Compose: `/home/raspfet97/homelab/telegram-t3-bridge/`.
Mac gateway Compose: `/Users/andreasimonecosta/.config/mcpx/compose.yaml`.
Preserve existing private authorization and service data when updating the
connection. Diagnose direct LAN reachability and MCPX state, then perform a
read-only bot identity call. Never print or re-enter tokens merely to diagnose
an outage. Enabling an integration changes tool availability, not reconnection.
For `connection-failed`, use `mcpx__management_reconnect_server` when advertised;
confirm the result with management status and a read-only `get_bot_info` call.

The three bot credentials have separate purposes: the legacy main BotFather token is in
`/home/raspfet97/homelab/telegram-t3-bridge/secrets/main.bot-token`; explicit UI/CLI
replacement writes the private container override `/data/bot-registry/main.bot-token`.
The main MCP bearer
token is in `/home/raspfet97/homelab/telegram-t3-bridge/secrets/main.mcp-access-token`.
The incoming webhook secret is `TELEGRAM_WEBHOOK_SECRET` in the shared ignored
`/home/raspfet97/homelab/telegram-t3-bridge/.env`. Only the webhook secret was
consolidated there. Never substitute a BotFather token for that variable.

## Adding a bot or replacing its token

Read the canonical Pi bridge README for the UI/API and CLI procedure, or use
[raspfet-ops](/Users/andreasimonecosta/.agents/skills/raspfet-ops/SKILL.md) for service maintenance. A valid BotFather token
is sufficient bot authentication in both UI and stdin flows: no Telegram confirmation.
Enrollment access additionally requires the private admission key, which is separate
from every bot's MCP credential. The listener is Pi host-loopback-only on 8083;
an optional SSH forward exposes its UI on Mac port 18083, not the MCP connection.

Installed Mac client: `~/.local/share/raspfet-telegram/enroll_client.py`.
Admission key: `~/.config/raspfet-telegram/enrollment-admin.key`; only its hash is stored
on the Pi. Use the hidden token prompt, `--token-file` or `--token-stdin`, never token
argv/chat. `enroll --replace-token` accepts a new token for the same bot, preserving
the owner, MCP credential, webhook secret and history without restarting the service.
Keep the same private credential output; retain request receipts after uncertain results.

For a new bot, install the returned MCP bearer in a separate MCPX connection to
`http://192.168.1.47:8082/mcp`; do not place its BotFather token in the gateway.
Verify identity with `get_bot_info`. Secondary bots do not forward incoming work to
T3 unless that routing is separately enabled. Main `manage.py status`/`register` still
read the legacy token; use client status and MCP identity after UI/CLI replacement.

## Reliable delivery

- `send_message` supports text and replies with a stable `delivery_key`.
  Reuse the key for the same intended delivery, not for different messages.
- Before retrying a send whose result is uncertain, inspect
  `get_delivery_status` or `recent_deliveries`. Distinguish `sent`, `sending`,
  `unknown`, and `not_found`; do not treat `unknown` as a failed delivery.
- Photos/documents accept URL/file-ID or bounded base64 input; inspect their
  schemas for current size limits. Edit/copy/forward/delete operate on actual
  message IDs, and forwarding sends another message.
- `start_typing` maintains typing periodically under a label. Renew for long
  work and call `stop_typing` during cleanup with the same label; it must not
  stop a newer operation's typing.

## Incoming images

Native questionnaires use `send_input_message` and `edit_input_message` plus the
authenticated inbox/snapshot/retirement tools. One physical card navigates questions
and review, then submits the complete native batch. Edits register their presentation
before Telegram delivery and may pin an exact `focus_id`; it is distinct from the
currently displayed question. Known non-delivery uses the original key; unknown
operations stay reconciliation-only. See the supervisor's native-input knowledge page.

`get_incoming_photo(message_id)` returns MCP ImageContent plus safe metadata for an
owner-sent photo in an authenticated retained incoming receipt. Call after typing and
validation for photo updates; inspect the image rather than guessing from its caption.
No URL, arbitrary file ID or bot credentials are exposed. The Pi enforces strict integer
owner/private IDs, journal provenance/retention and an 8 MiB download bound. Retrieved
image bytes are not persisted by the service; audits contain hashes and size metadata.
The incoming bridge derives text from the exact photo caption or `[Photo attached]`,
retaining original photo sizes and raw journal bytes. A bare photo with unclear intent
requires clarification, not an invented task. Preserve an explicit test-only instruction;
verification of a saved image does not authorize acting on its caption.

## Routing and acknowledgements

Incoming Telegram work already reaches a configured T3 conversation through
the bridge and scheduled webhook. The agent interprets the prompt there;
webhook body fields do not automatically reroute or interrupt a thread.

For authorized recap forwarding, verify the real bot message, intended
destination, and previous-delivery state. Forward only the user's original
reply using stable route identity. Teams discussions and bridge/configuration
replies stay local rather than being forwarded automatically.

Use `set_message_reaction` with 🕊 only after confirmed forwarding; retrying a
reaction is not a reason to forward again. Routine acknowledgements need not
send another text message.

For LAN/Pi operations, use the [raspfet-ops skill](/Users/andreasimonecosta/.agents/skills/raspfet-ops/SKILL.md).
For completion recaps and delivery state, use
[t3-supervisor](/Users/andreasimonecosta/.agents/skills/t3-supervisor/SKILL.md). Inspect those services separately;
a successful MCP call does not prove every part of the bridge or supervisor.

Native questionnaire text-entry callbacks show immediate Reply instructions after the
Pi commits the focus/event. Reply by swiping or long-pressing the registered card, then
type and send; ordinary unquoted text is not a native answer. The alert identifies the
selected question for guidance only, while opaque registered identities control routing.

Direct text replies to an authenticated registered question view require no help-button
tap. The last optional control, How to type my answer?, only provides Reply instructions.
Navigation to another question clears its displayed focus; historical quoted views and
contributions keep their original ownership. Review has no implicit question target.
Unrecoverable legacy focus remains rejected; stale-answer and Clear barriers still apply.


Only the explicitly configured Telegram conversation receives interactive questionnaires.
Other ordinary chats send plain input-needed notifications through generic MCPX send/edit;
no input handle or keyboard is added, and replies remain normal Telegram chat messages.
A submitted questionnaire cleans up its owner reply attempts and its card. Cancellation,
archival or replacement without accepted/resolved proof retains unsubmitted text. The
supervisor's private reply cleanup ledger preserves original keys and uncertainty. Exact
Telegram deleteMessage400 classifications expose only fixed missing/impossible enums,
never raw error descriptions. Expired/impossible cleanup is reported through a counter.
