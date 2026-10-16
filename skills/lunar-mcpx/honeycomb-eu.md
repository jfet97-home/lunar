# Honeycomb EU

Configured namespace: `honeycomb-eu`. Endpoint observed on 2026-10-08:
`https://mcp.eu1.honeycomb.io/mcp`, Streamable HTTP with MCPX-managed OAuth.
Queries require a `team`; resolve its allowed values from the live schema.
Use live discovery for the current environment, dataset, and tool schema;
do not infer account membership from this guide.

## Query and trace workflow

- Use `get_workspace_context` or `get_environment` to establish accessible
  context when the user has not supplied it.
- Inspect columns with `get_dataset_columns` or `find_columns` before writing
  filters. Use `list_spans` to discover operations and `get_trace` for a known
  trace; these serve different questions from aggregate queries.
- `run_query` executes an aggregate or scoped raw-row query. Retrieve its
  structured results with `get_query_results`; inspect the returned schema
  rather than reusing historical query arguments.
- For an existing Honeycomb query URL, execution ID, or saved-query ID,
  `get_query_results` accepts exactly one of `url`, `query_run_pk`, or `query_id`.
  Descriptions may call the run identifier `run_pk`; the input field is
  `query_run_pk` in the verified schema.
  The saved-query ID resolves to its most recent run; it is not a new execution.

Keep time window, environment, dataset, and deployed build ID explicit when
investigating production. A successful trace or green CI does not establish a
production rollout or its behavior outside the queried window.

For detailed investigation, boards, or instrumentation, use the
[Honeycomb skill](/Users/andreasimonecosta/.agents/skills/honeycomb/SKILL.md). Board, marker, trigger, and recipient
mutations are separate from reading telemetry and require the corresponding
user request.

## Authentication

Use MCPX's login tool for pending OAuth and let the user finish consent. EU
and other regional endpoints are distinct; do not switch the URL as a login
workaround. Verify a bounded workspace or dataset read after reconnecting.
