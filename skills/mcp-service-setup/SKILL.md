---
name: mcp-service-setup
description: Plan and add a new MCP integration through a question-first setup workflow, including local services, Docker, remote endpoints, transport adapters and client registration. Use when asked to add, install, connect or set up an MCP, or change its deployment architecture. Ordinary reads and previously authorized maintenance of an existing integration do not need this intake.
---

# MCP service setup

A request to add an MCP starts a setup discussion. Establish the user's limits,
placement and lifecycle choices before downloading packages, writing setup files,
registering the connection or starting a service. Installer defaults and an
upstream skill do not supply missing authorization.

## Ask one question at a time

Read the current conversation and inspect existing repository guidance and runtime
metadata without changing them; inspect secret references rather than secret
values. Reuse explicit choices already supplied by the
user; do not ask the same question again. Ask the next unresolved question, wait
for its answer, and continue until these decisions are clear:

1. **Purpose and limits:** what should the integration do, on which targets or
   accounts, and with what read, write or execution authority? Clarify optional
   analysis engines or extra capabilities before including them.
2. **Placement:** which existing Git repository and component directory own its
   source, Compose, dependency pins and documentation? Inspect the established
   layout first. For this installation, propose
   `~/Developer/custom-mcps/<service>` when it fits the user's existing convention.
   Decide private credential and state locations separately.
3. **Runtime and transport:** use an existing remote endpoint, Docker or a native
   host process? Explain any relevant capability loss, such as a Linux container
   being unable to run macOS applications. If an adapter is needed, name it,
   explain why, and include it in the choice before installing it. Do not silently
   substitute a custom bridge or a native service for the selected architecture.
4. **Access:** agree host file mounts, writable paths, network exposure, credential
   storage and the client or gateway that may use it. Use the existing MCPX gateway
   when requested; adding direct client registrations is a separate change.
5. **Lifecycle:** prepare files only, start once now, or install a persistent
   service? Starting a detached process, registering launchd/systemd, scheduling
   work, or enabling login/boot startup or a Docker restart policy needs an explicit
   choice. Permission to install does not by itself grant any of these behaviors.

If the user already gave a complete concrete scope, summarize it and proceed
within that authorization. Do not turn this workflow into repeated confirmations
for the same approved action. Discovering the exact paths, ports and credential
bindings of an already-approved existing setup is routine inspection, not a new
choice. A material change to access, ownership, runtime or lifecycle is a new
choice. Inspect inherited startup settings and do not carry an automatic restart
policy into a session-only start when the user excluded it.

## Make the setup reviewable

Before applying a new setup, present a compact plan with the exact repository and
files, packages and adapters, private runtime paths, processes, ports and mounts,
startup behavior, MCPX/client changes, and verification and cleanup locations.
Keep read-only investigation useful while awaiting answers. An installer invoked
through `npx`, `uvx` or a curl script can download or execute code even when used
for help or a claimed dry run; do not use it to bypass the setup discussion.

Apply the agreed plan after the user approves its remaining choices. Existing
authorization for an exact plan remains valid; only a material change of scope,
placement, access or lifecycle requires a new decision.

## Keep ownership and files clear

- Keep service source, Compose, build files, dependency locks and operating docs in
  the agreed Git repository. `~/.config/mcpx` holds gateway runtime configuration;
  it is not the default home for another service's source or scripts.
- Put private credentials and mutable state only in the agreed private locations
  or named volumes, outside Git and build contexts. Do not create duplicate host
  installations, fallback services, wrappers or extra runtime folders for convenience.
- Use Skillshare for global skill installation and linking. Updating a managed
  upstream skill must not replace this local setup workflow.
- Keep temporary work in the named locations from the plan and remove it after
  verification. If an approach changes, inventory and remove its own packages,
  CLI links, service registrations, logs and obsolete files; preserve unrelated
  files, credentials and existing volumes.
- Record the source and lifecycle in the component's operating documentation.
  Report what remains on the host, what runs in Docker, what starts automatically,
  and which capabilities were actually verified. Discovery alone is not readiness.

This intake covers new integrations and changes to their architecture or startup
behavior. Continue previously authorized repairs within their existing boundaries;
do not use a missing tool or failed connection as permission to install or launch
a replacement service.
