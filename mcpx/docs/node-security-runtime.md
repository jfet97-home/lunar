# Node security runtime

Build, embedding-download and UI stages pin the official multi-platform Node
22.23.4 Alpine 3.23 image by digest. The final Docker-in-Docker image separately
installs Alpine Node and npm; its `/usr/bin/node` is explicitly replaced with the
same official Node binary. The existing npm version and service packaging remain
unchanged. Runtime assertions check the actual executable version, bundled Brotli,
the patched decoder constant and a compression round trip.

This is a deliberate custom runtime patch, not a new upstream MCPX release.
Alpine package metadata can still describe its original Node package; it does not
identify the executable used by the gateway. Future base-image changes must
review or retire the explicit copy and keep the runtime assertions. Official Node
22.23.4 includes the October 2026 security fixes with backported bundled Brotli;
the reported Brotli version alone is not sufficient to assess it.

Use the existing committed-main GHCR publication and digest-pinned deployment
workflow. Preserve gateway configuration, OAuth state, upstream settings, ports
and restart policy. After replacement, verify the actual Node executable, health,
complete tool inventory and bounded reads through retained MCPX sessions. An image
build alone does not prove upstream authentication or client-session recovery.
