# Paginated tool discovery and fork maintenance

## Verified problem

Investigated on 2026-10-05. The installed MCPX 0.4.55 image uses SDK 1.26.0.
`ExtendedClient.listTools()` in `services/client-extension` calls
`originalClient.listTools()` once. The SDK returns one `tools/list` page without
following `nextCursor`. MCPX consequently caches and exposes only that page.
This is an upstream pagination failure, not a universal 50-tool limit, a
provider limitation, or an authentication failure. Page size comes from the
upstream server. A paginated catalog returning 50 tools per page reproduced the
problem: the gateway exposed the first 50 and omitted tools on later pages.

No pagination configuration was found in the installed configuration or inspected
upstream source. GitHub issue and PR searches for pagination, nextCursor,
listTools, tools/list, and Atlassian did not find a matching report. Search again
before filing; absence in these searches does not prove no report exists.
Current upstream source inspected on that date still makes the single call;
its lockfile contains SDK 1.26.0 and 1.29.0, whose inspected implementations also
return one page. Do not assume rebuilding upstream or changing a version range
fixes this. Recheck the resolved dependency and its actual behavior.

Sources:
- https://github.com/TheLunarCompany/lunar/blob/main/mcpx/packages/mcpx-server/src/services/client-extension.ts
- https://github.com/TheLunarCompany/lunar/blob/main/mcpx/package-lock.json
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/index.ts

## Fix and verification contract

Prefer a source change in the maintained fork, with a regression test covering
multiple pages and a tool beyond the first page. Consume continuation cursors
until absent, merge all definitions before gateway caching, and preserve SDK
output-schema and task metadata across pages. Cursors are opaque; do not use a
truthiness check that drops an empty-string cursor. Bound runaway pagination
with an explicit failure rather than silently returning a truncated catalog.

Verify both full tool discovery and calling a read-only tool that would have
been on a later page. Verify non-paginated servers still work. A server's native
discover/execute endpoint may be an alternative if it exposes the needed primary
tools and the gateway can relay deferred operations; test it before promising
that it replaces full catalog discovery.

Changing an upstream URL can select a different OAuth credential scope and
trigger login again. Restoring the original URL restored the authenticated
connection in this investigation. Avoid switching URLs merely to hide missing
tools without checking the resulting catalog and authentication.

## Implemented source fix

The owned fork is https://github.com/jfet97-home/lunar, with changes on `main`.
The source checkout is now `~/Developer/lunar-jfet97`, moved from
`/private/tmp/lunar-jfet97` on 2026-10-05. Use the persistent checkout and inspect
its remotes before fetching or merging. Clone the owned fork again if absent.

`services/paginated-client.ts` subclasses the SDK Client and overrides its public
`request` method only for `tools/list`. It fetches pages with `super.request`,
combines them, strips the consumed cursor, and parses through the caller's schema.
The inherited SDK `listTools` then caches all output validators and task metadata
once. `buildClient` in `target-server-connection-factory.ts` constructs this class,
including OAuth connections. Other request methods delegate directly to the SDK.

Regression coverage includes 101 tools across three pages, early-page output
validation, later-page execution, single-page metadata, empty/repeated opaque
cursors, and an explicit 1000-page failure bound. Targeted suites passed 35 tests
and server type checking passed. The upstream ESLint config imports an absent
`eslint.review-rules.js`; standard configured rules were checked with a temporary
local config omitting those unavailable custom rules. Do not present the missing
private rules as validated.

Fix commit:
https://github.com/jfet97/lunar/commit/65e5bf0819dc056f42a185463c50d7c29c142629
Upstream issue: https://github.com/TheLunarCompany/lunar/issues/84

The image built from this source was deployed and real later-page Confluence
access succeeded. The superseded local image and original container were removed.
Configuration, OAuth state, ports, and `restart: always` were preserved on the
same Compose service. The login task starts Docker Desktop; the replacement
container's restart policy starts this gateway. No second gateway startup job is
needed. Obtain current image and upstream settings from the live helper rather
than treating this incident record as a permanent deployment inventory.

## Source identity and the dashboard version

The public source inspected on 2026-10-05 has `mcpx/.version` set to
`v0.2.9-fix2`, last changed on 2025-08-21, despite much newer source commits.
The Dockerfile copies it into `/tmp/version.env`; the entrypoint exports it as
`VERSION`, and the dashboard strips the suffix. A source build can therefore show
`v0.2.9` without using old source. Compare upstream ancestry and the running
image's OCI revision label, rather than inferring release age from this badge.
The superseded official image advertised 0.4.55. Its public ARM64 OCI build
attestation records private source `TheLunarCompany/lunar-private`, revision
`165aa71d8f24012ce4fac0bed0e6046e196154bd`, branch `main`, and build completion
2026-07-12T14:03:28Z. The public fork used upstream `49a62f7b` from 2026-10-05.
The private revision was not retrievable through the public repository, so
ancestry and exact release equivalence could not be established. No public MCPX
release/stable branch was found on that date; the other branches were older
housekeeping/dependency work. Recheck available branches during later upgrades.
These are distinct source repositories and version-label mechanisms; establish
commit ancestry before asserting how many source commits or releases separate
them. Do not treat the older-looking dashboard badge as a release downgrade.

## Public core and Enterprise

On 2026-02-02, a Lunar contributor said the open source project remains active
and free, and promised not to move core features behind a paywall:
[maintainer reply](https://github.com/TheLunarCompany/lunar/issues/57#issuecomment-3835107931).

The documented open source core includes MCP aggregation, OAuth, local/remote
servers, tool groups, and customization. Enterprise adds SSO, centralized
administration, private catalogs, Vault integration, advanced auditing, and risk
controls on the same core foundation:
[feature comparison](https://www.lunar.dev/post/the-best-open-source-mcp-gateways-in-2026),
[pricing FAQ](https://www.lunar.dev/pricing).

No public/private synchronization schedule or guarantee matching public `main`
to each official Docker release was found in the sources reviewed on 2026-10-05.
Edition differences do not establish the exact differences between a source
build and an official image. The public core supports this shared MCP/OAuth
setup; closeness to private source remains an inference, not a parity guarantee.

## Preferred fork and update workflow

The canonical fork checkout is `~/Developer/lunar-jfet97` on `main`; MCPX lives
under its `mcpx/` subdirectory. Keep custom changes on this `main`. Configure
`origin` as `jfet97-home/lunar` and `upstream` as `TheLunarCompany/lunar`. Use another
branch or checkout only when explicitly requested. If temporary isolation is
requested, bring the completed changes back to canonical `main` before building
or deploying the gateway; do not leave a live fix only in a scratch worktree.

For an update, fetch upstream and integrate its exact `main` commit into the
fork's `main`, using rebase when requested and otherwise the repository's merge
policy. Preserve local edits and fork features, resolve conflicts, and run the
affected regressions, lint and type checks. Verify upstream ancestry and a clean
working tree. Push when the current task authorizes publication; for an authorized
rebase of published history, use an explicit force-with-lease against the inspected
remote tip, never an unconditional force push.

For a local main-image build, run:

```sh
cd ~/Developer/lunar-jfet97
bash mcpx/scripts/build-main-image.sh
```

The script requires clean, committed `main`, builds the combined `mcpx` target
from the repository root including `ai-gateway-shared/public`, and records the
commit in the tag and OCI revision label. For normal deployment, wait for that
main commit's successful GHCR publication and pin its verified registry digest.
The upstream Dockerfile currently runs dependency-install commands
rather than only a frozen install; review dependency reproducibility before
calling a build fully reproducible.

Preserve configuration and OAuth volumes when replacing the container. Retain
the previous image digest, perform health and later-page tool checks after the
update, and roll back the image if they fail. If the old local image was removed,
pull the recorded digest again before rollback. Do not automatically replace a
working deployment whenever upstream changes. Remove the fork's pagination
change only after an upstream replacement passes the regression test.

Finish consolidation with the requested changes committed on canonical `main`,
the authorized push completed, and the running image's revision matching that
main commit. After verification, remove temporary scratch worktrees and obsolete
upload-only overlays/images; preserve unrelated work and service data. If any
step remains incomplete, report it instead of presenting deployment as source
integration. Always identify the canonical clone separately from build artifacts.

An upstream issue is worthwhile with the affected image and SDK versions,
a two-page reproducer, missing continuation handling, and observed versus
expected tool lists. An upstream PR can later reduce the fork's maintenance
burden. The initial report is issue #84; check its status and related PRs before creating
a new report.


## GHCR builds and controlled deployment

The fork's `.github/workflows/publish-mcpx.yml` runs on relevant pushes to `main`
and on manual dispatch. It runs the pagination regression on a native ARM64
runner, builds the combined upstream Docker target, and publishes the public
package `ghcr.io/jfet97-home/mcpx` with a full commit tag and a moving `main` tag.
The repository transferred to `jfet97-home` on 10 October 2026. Local deployment
now uses the organization package; inspect the running revision and Compose pin
rather than assuming an older personal-namespace image is still installed.
OCI source/revision labels identify the repository and commit. GitHub Actions
uses its own `GITHUB_TOKEN` with `packages: write`; registry credentials are not
committed. Local Docker can authenticate using the existing GitHub CLI account:

```sh
gh auth token | docker --context desktop-linux login ghcr.io --username jfet97 --password-stdin
```

Wait for the requested commit's successful workflow before pulling. Read its
published digest from the workflow summary and pin that digest in the Compose
image anchor. A source push builds an image; it does not automatically upgrade
the local digest-pinned gateway.

```sh
gh run list --repo jfet97-home/lunar --workflow publish-mcpx.yml --limit 5
docker --context desktop-linux pull ghcr.io/jfet97-home/mcpx@sha256:REPLACE_WITH_VERIFIED_DIGEST
docker --context desktop-linux compose -f ~/.config/mcpx/compose.yaml config --quiet
docker --context desktop-linux compose -f ~/.config/mcpx/compose.yaml up -d --no-deps --pull never mcpx
```

Replace the digest placeholder before running. Preserve mounted configuration
and OAuth state and retain the previous image digest for rollback. For
user-requested backups, see [operations.md](operations.md#user-managed-backups).
After installation, follow
[the client refresh procedure](operations.md#refresh-clients-after-an-upgrade)
for both Claude and Codex and verify the resulting tool inventories.
