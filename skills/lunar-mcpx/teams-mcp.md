# Microsoft Teams

Configured namespace: `teams-mcp`. Endpoint observed on 2026-10-08:
`http://teams-mcp:9006/mcp`, a local Streamable HTTP service backed by Microsoft
Graph. MCPX reports no upstream MCP OAuth; Graph sign-in happens inside Teams.

## Authentication and persistence

Use the service's `login` tool. If it returns a device code and URL, let the user
complete sign-in, then call `complete_login`. The latter can wait up to 15
minutes; avoid an unbounded synchronous call when the user has not finished.
Verify an appropriate small Graph read afterward. Discovered tools and configured
scopes do not prove delegated permissions or tenant admin consent were granted.

Local entrypoints, verified on 2026-10-10:

- Source: `~/Developer/custom-mcps/teams`, on monorepo `main`.
- Public repository: `jfet97-home/custom-mcps`; shared with Atlassian Media.
- Private settings: `~/.config/teams-mcp/service.env` (never publish).
- Compose: `~/.config/teams-mcp/compose.yaml`.
- Auth mount: `/home/mcp/.teams-mcp`, persisted in the Compose `auth` volume.

Inspect the actual volume name/mounts before replacing the container and preserve
the MSAL cache. Recreate the service when an authorized environment change must
take effect; restarting alone does not reload Compose environment configuration.
Do not expose token-cache or environment-file contents.

## Reading and recency

- Chats: `list_chats` then `list_chat_messages`. Chat-list order and
  `lastUpdatedDateTime` do not prove recent message activity. For latest chats,
  fetch the latest message per returned chat and sort by `createdDateTime`, then
  read the relevant conversations. `limit: 50` worked in the prior workflow;
  `100` failed. A single bounded page is not an exhaustive chat inventory.
- Channels: `list_teams` → `list_channels` → `list_channel_messages`.
  Read channel replies separately with `list_thread_replies`; the tool returns
  one page of replies and does not signal later replies were omitted.
- `get_user` matches name/email prefixes, not arbitrary middle fragments.
  `search_messages` returns snippets and links without message IDs; locate a
  hit in the appropriate message list before replying or reacting.

## Sending and attachments

`create_chat` sends a message and creates/reuses a one-to-one chat; it is not a
read-only lookup. `create_group_chat` creates a new group each time. Send content
as plain text: newlines/URLs are handled, Markdown/HTML are literal. Each mention
must also appear exactly as `@Name` in the content.

Use `send_chat_message` with `reply_to` for a quoted chat reply and
`reply_to_channel_message` for a channel thread. Read the actual target first.
Do not blindly retry an uncertain send.

`download_attachment` handles inline hosted images, not SharePoint/OneDrive file
attachments. Images inside a channel reply require `parent_message_id`; its
returned temp path is inside the server container. Team-level tags work in
standard channels; for shared-channel tags, reuse IDs from an existing human
mention rather than assuming a team tag is valid there.
