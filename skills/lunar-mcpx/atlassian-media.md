# Atlassian media

Configured namespace: `atlassian-media`. Endpoint observed on 2026-10-08:
`http://atlassian-media:9005/mcp`, a local Streamable HTTP sidecar.
Its backing Atlassian credentials are separate from Rovo's MCP OAuth;
`oauth: false` in MCPX does not mean the backing API is unauthenticated.

## Source and deployment

Canonical source: `~/Developer/custom-mcps/atlassian-media` on the public
`jfet97-home/custom-mcps` monorepo's `main`, shared with Teams. The former
`~/Developer/atlassian-media-mcp` folder has been moved. Installed Compose remains
`~/.config/atlassian-media/compose.yaml`, with its build context updated.
Credentials remain in the running sidecar's environment. `npm run deploy` reads
those values privately when rebuilding; preserve them and never print them.

## Image retrieval

1. Use `media_status` for safe connection, site-expiry, and cache metadata.
2. Obtain the numeric Confluence content ID and embedded Atlassian file IDs
   from the actual whiteboard/content metadata.
3. Use `download_whiteboard_images` for the selected IDs, then
   `read_image_chunk` for bounded base64 chunks from downloaded files.

Inspect each schema for chunk bounds and identifiers. Assemble bytes in the
requested output environment; a path returned by a container is not necessarily
readable on the Mac. Keep the source content and original images when converting
or exporting.

For serialized SVG repair, large-canvas trimming, and readable exports, use the
[Atlassian flowchart export skill](/Users/andreasimonecosta/.agents/skills/atlassian-flowchart-export/SKILL.md).
For deployment changes, inspect the gateway/sidecar Compose mounts and credential
sources without printing their values. A gateway export does not automatically
include credentials supplied only to the sidecar's environment.
