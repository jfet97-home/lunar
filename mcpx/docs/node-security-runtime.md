# Node security runtime

Build, embedding-download and UI stages pin the official multi-platform Node
22.23.4 Alpine 3.23 image by digest. The final Docker-in-Docker image copies Node
and npm from that same official image into `/usr/local`, following upstream's
runtime installation. npm retains version 11.6.4. Runtime assertions check the
actual executable version, bundled Brotli, the patched decoder constant and a
compression round trip.

The fork retains digest pinning and runtime assertions beyond upstream's Node
security update. Future base-image changes must review the explicit copy and keep
the runtime assertions. Official Node
22.23.4 includes the October 2026 security fixes with backported bundled Brotli;
the reported Brotli version alone is not sufficient to assess it.

Use the existing committed-main GHCR publication and digest-pinned deployment
workflow. Preserve gateway configuration, OAuth state, upstream settings, ports
and restart policy. After replacement, verify the actual Node executable, health,
complete tool inventory and bounded reads through retained MCPX sessions. An image
build alone does not prove upstream authentication or client-session recovery.

## Upstream integration — 22 October 2026

Upstream main `56778528cf6361e4384c9f29364f8b16ab7a4edb` integrates cleanly,
including abort-aware timeout/provider handling and updated Alpine certificate
and Expat pins. It still uses the old Node build/runtime sources, so the fork's
Node security patch remains necessary. The 50 newly incorporated upstream commits
change eight files relative to the prior common base. Changed TypeScript files
pass configured lint/autofix and type checks; 24 focused timeout/provider tests
and all 409 fork regression tests pass. Dockerfile checks also pass. Deployment
must use the merged commit's successfully published GHCR image and immutable digest.

## Upstream integration — 24 October 2026

The fork is rebased onto upstream main
`a23bab575f2564de4cdfab609e5a08dd45f40600`. Its six new commits change only the
Dockerfile and OAuth integration-test image in the public tree. Upstream now uses
Node 22.23.4 in build, UI and runtime stages and in the OAuth mock. The fork keeps
its pinned official image digest, embedding-model stage and runtime assertions,
while adopting upstream's Node/npm installation instead of replacing an Alpine
Node package. Commit titles about identity-provider changes introduce no public
application-code delta in this range.
