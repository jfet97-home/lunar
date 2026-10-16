# Sentry

Configured namespace: `sentry`. Endpoint observed on 2026-10-08:
`https://mcp.sentry.dev/mcp`, Streamable HTTP with MCPX-managed OAuth.
Resolve current organization/project/region from supplied context or live tools.

## Two discovery layers

MCPX exposes Sentry's direct searches and its own deferred-tool discovery.
A missing top-level tool is not evidence that Sentry lacks the operation:

1. Find `sentry__search_sentry_tools` through MCPX and inspect its schema.
2. Search there for a long-tail operation, such as issue details, attachments,
   releases, DSNs, or project management. Results contain the executable schema
   with current session constraints applied.
3. Invoke `sentry__execute_sentry_tool` through MCPX, passing the inner tool's
   returned name and arguments. The inner name is not another MCPX target.

Use the structured discovery result; do not parse Markdown as a tool schema.
Do not assume organization, project, or region parameters omitted by the returned
schema should be added manually.

## Choose the right data

- `search_issues`: grouped issues, status, ownership, and affected-user metadata.
- `search_errors`: individual exception/crash events.
- `search_logs`: log lines and their aggregates.
- `search_traces`: spans, request performance, throughput, and latency.
- `search_metrics`, `search_profiles`, `search_replays`: their respective data.

Use bounded time/project/environment filters and distinguish a found event from
an explanation of its cause. `update_issue` changes status or assignment;
`analyze_issue_with_seer` starts an analysis. Do not invoke these as part of
mere discovery. For pending authentication, use MCPX login and verify a small
read after interactive consent.
