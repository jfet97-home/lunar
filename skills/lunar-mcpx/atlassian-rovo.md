# Atlassian Rovo

Configured namespace: `atlassian-rovo`. Endpoint observed on 2026-10-08:
`https://mcp.atlassian.com/v2/mcp`, Streamable HTTP with MCPX-managed OAuth.
The gateway's paginated discovery supports a large catalog; find just the
operations needed rather than loading all schemas.

## Sites, search, and content

- Resolve `cloudId` with `getAccessibleAtlassianResources` when not already
  supplied for the target site. It is the site's identifier, not a project key,
  issue ID, or user account ID.
- Use the advertised `search` tool for general Jira/Confluence discovery;
  its current description notes Rovo-credit use. When the user supplies JQL or
  CQL, use the corresponding structured Jira or Confluence search instead.
- Read the actual issue or content after a search hit. Search snippets alone
  do not establish requirements, state, or an entire document's contents.
- Reuse an existing issue/comment when updating a closeout. Resolve the target
  and current content before editing; avoid duplicate work or stale versions.

Schemas and supported content formats change. Retrieve the selected schema and,
where appropriate, the content format guide before writing or exporting.
Commenting, transitions, sharing, permission changes, and content edits are
mutations; searching does not authorize them.

## Missing tools and whiteboards

After successful login, missing later-page tools may indicate gateway catalog
pagination or client caching. Read
[pagination](references/pagination.md) before changing endpoints or credentials.

Whiteboard metadata may expose embedded Atlassian file IDs rather than ordinary
public image URLs. Use [atlassian-media.md](atlassian-media.md) for those bytes.
For a faithful SVG/PNG flowchart export, use the
[Atlassian flowchart export skill](/Users/andreasimonecosta/.agents/skills/atlassian-flowchart-export/SKILL.md).
