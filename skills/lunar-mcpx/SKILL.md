---
name: lunar-mcpx
description: Develop and maintain Andrea's local Lunar MCPX installation and plan new MCP integrations, including source builds, Docker deployment, gateway configuration, OAuth recovery, persistence and upgrades. New integrations require the mcp-service-setup discussion first. Use use-lunar-mcpx for ordinary tool discovery and upstream calls.
---

# Lunar MCPX

This skill covers the local installation and source maintenance. For ordinary
discovery, schema lookup, upstream calls and management-tool sign-in, use
[use-lunar-mcpx](../use-lunar-mcpx/SKILL.md), linked from the product checkout.

## New integrations start with questions

For a new MCP, a replacement runtime or changed startup behavior, first follow
[MCP service setup](../mcp-service-setup/SKILL.md). Ask one
unresolved question at a time about limits, placement, runtime, access and lifecycle.
Wait for the answers before installing packages, writing setup files, registering
servers or starting processes. A request to install does not authorize a host
package, adapter, background service, login task or automatic restart policy.
Reuse already explicit choices and authorization for the agreed plan.

## Canonical source and deployment

The gateway fork lives at `~/Developer/lunar-jfet97` on `main`, unless another
checkout is requested. Custom upstream services normally belong in the existing
`~/Developer/custom-mcps/<service>` repository layout; confirm their placement
through the setup discussion. Keep their source and Compose in Git, with private
credentials/state separately located. Do not use `~/.config/mcpx` as their source
directory or create a native fallback while deciding how to deploy them.
Read project guidance and preserve local work. Integrate completed fixes into
`main`; build from clean, committed source and pin published deployment digests.
See [fork maintenance](references/pagination.md) for builds, upstream updates,
missing tools and cleanup after integration.

## Inspect the installation

Before configuration, Docker or deployment work, run the read-only inspector:

```sh
bash ~/.agents/skills/lunar-mcpx/scripts/settings.sh
```

Use `scripts/status.sh` for a shorter check. Read
[operations](references/operations.md) for local entrypoints and lifecycle changes.

## Local integration references

Load only the relevant account, routing or recovery guide. Recheck live state
and permissions; these names describe configured integrations:

- [mcpx.md](mcpx.md): management, OAuth and backups.
- [honeycomb-eu.md](honeycomb-eu.md): EU telemetry.
- [sentry.md](sentry.md): Sentry discovery.
- [atlassian-rovo.md](atlassian-rovo.md): Atlassian cloud IDs.
- [atlassian-media.md](atlassian-media.md): whiteboard exports.
- [teams-mcp.md](teams-mcp.md): Graph login and messaging.
- [raspfet-telegram-t3.md](raspfet-telegram-t3.md): bot delivery and routing.
- [omegent.md](omegent.md): remote T3 OAuth and orchestration.

Read [lazy tools](references/lazy-tools.md) when diagnosing endpoint/catalog behavior.

## Preserve state and verify the result

Preserve configuration and OAuth volumes; never use `down -v`. Back up only when
requested and operate on the affected service rather than restarting Docker Desktop.
Do not print credentials or private exports.

Verify recovery with a bounded upstream read. For upgrades, follow the operations
guide's artifact, client-refresh and image-cleanup procedures. Report installation,
upstream access and retained-session refresh separately; a fresh probe does not
prove an existing T3 session refreshed.
