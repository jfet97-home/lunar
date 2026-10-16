#!/usr/bin/env bash
set -euo pipefail

mcpx_docker_bin="${MCPX_DOCKER_BIN:-$(command -v docker)}"
mcpx_compose_file="${MCPX_COMPOSE_FILE:-$HOME/.config/mcpx/compose.yaml}"
mcpx_context="${MCPX_DOCKER_CONTEXT:-desktop-linux}"
mcpx_service="${MCPX_SERVICE:-mcpx}"

if ! "$mcpx_docker_bin" --context "$mcpx_context" info --format '{{.ServerVersion}}' >/dev/null; then
    printf '%s\n' 'Docker is unavailable. Distinguish a sandbox socket denial from a stopped engine.' >&2
    exit 1
fi

"$mcpx_docker_bin" --context "$mcpx_context" compose -f "$mcpx_compose_file" config --quiet
"$mcpx_docker_bin" --context "$mcpx_context" compose -f "$mcpx_compose_file" ps
mcpx_container_id="$("$mcpx_docker_bin" --context "$mcpx_context" compose -f "$mcpx_compose_file" ps -q "$mcpx_service")"
if [[ -z "$mcpx_container_id" ]]; then
    printf '%s\n' 'The MCPX service is not running.' >&2
    exit 1
fi
"$mcpx_docker_bin" --context "$mcpx_context" inspect "$mcpx_container_id" --format '{{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}} source={{index .Config.Labels "org.opencontainers.image.source"}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} ports={{json .NetworkSettings.Ports}}{{range .Mounts}}{{printf "\n"}}{{.Name}} -> {{.Destination}}{{end}}'

mcpx_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mcpx_helper_source="$(base64 < "$mcpx_script_dir/settings-helper.mjs" | tr -d '\n')"
"$mcpx_docker_bin" --context "$mcpx_context" compose -f "$mcpx_compose_file" exec -T -e "MCPX_SETTINGS_HELPER_SOURCE=$mcpx_helper_source" -e "MCPX_BRIEF=${MCPX_BRIEF:-0}" "$mcpx_service" node --input-type=module - <<'JS'
import fs from 'node:fs';
import { parse } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { readSavedSettings, redact, redactApplicationConfig } = await import('data:text/javascript;base64,' + process.env.MCPX_SETTINGS_HELPER_SOURCE);
const operationalKeys = [
    'MCPX_PORT', 'MCPX_SERVER_URL', 'UI_PORT', 'UI_URL',
    'APP_CONFIG_PATH', 'SERVERS_CONFIG_PATH', 'READ_TARGET_SERVERS_FROM_FILE',
    'DIND_ENABLED', 'ENABLE_STDIO_MCP_SERVERS', 'LUNAR_TELEMETRY',
    'ENABLE_METRICS', 'ENABLE_AUDIT_LOG', 'ENABLE_CONTROL_PLANE_REST',
    'ENABLE_CONTROL_PLANE_STREAMING', 'ENFORCE_HUB_CONNECTION'
];
const operationalEnvironment = Object.fromEntries(operationalKeys
    .filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
const brief = process.env.MCPX_BRIEF === '1';
if (!brief) console.log(JSON.stringify({ operationalEnvironment: redact(operationalEnvironment), incomingAuthKeyConfigured: Boolean(process.env.AUTH_KEY) }, null, 2));
const { config, paths } = readSavedSettings();
if (!brief) console.log(JSON.stringify({ settingsPaths: paths, savedServers: redact(config) }, null, 2));
const port = process.env.MCPX_PORT ?? '9000';
const savedAppConfig = fs.existsSync(paths.application) ? parse(fs.readFileSync(paths.application, 'utf8')) : {};
const headerName = savedAppConfig?.auth?.header ?? 'x-lunar-api-key';
const headers = process.env.AUTH_KEY ? { [headerName]: process.env.AUTH_KEY } : {};
const health = await fetch(`http://127.0.0.1:${port}/healthcheck`, { signal: AbortSignal.timeout(10000) });
console.log(JSON.stringify({ healthHttpStatus: health.status }));
if (!health.ok) throw new Error('MCPX health check failed');
const response = await fetch(`http://127.0.0.1:${port}/app-config`, { headers, signal: AbortSignal.timeout(10000) });
if (!brief && response.ok) {
    console.log(JSON.stringify({ liveAppConfig: redactApplicationConfig(await response.json(), parse) }, null, 2));
} else if (!response.ok) {
    console.log(JSON.stringify({ liveAppConfigUnavailable: response.status }));
}
const servers = Object.entries(config.mcpServers ?? config).map(([name, cfg]) => {
    let endpoint;
    if (cfg.url) {
        const url = new URL(cfg.url);
        endpoint = `${url.origin}${url.pathname}`;
    }
    return { name, type: cfg.type, endpoint };
});
console.log(JSON.stringify({ configuredServers: servers }, null, 2));

const client = new Client({ name: 'mcpx-status', version: '1.0.0' });
try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
    const { tools } = await client.listTools({}, { timeout: 15000 });
    const counts = {};
    for (const tool of tools) {
        const name = tool.name.split('__')[0];
        counts[name] = (counts[name] ?? 0) + 1;
    }
    console.log(JSON.stringify({
        toolsByServer: counts,
        pendingAuthentication: tools.filter(t => /request_authentication_link/.test(t.name)).map(t => t.name)
    }, null, 2));
} finally {
    await client.close();
}
JS
