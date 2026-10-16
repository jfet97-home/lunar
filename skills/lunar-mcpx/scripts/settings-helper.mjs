import fs from 'node:fs';
import path from 'node:path';

const secretName = /token|secret|password|passwd|authorization|credential|api.?key|access.?key|private.?key|client.?id|auth.?key/i;

/**
 * Redacts credentials while preserving operational settings.
 * @param {unknown} value
 * @param {string} [field]
 * @returns {unknown}
 */
export function redact(value, field = '') {
    field = field.toLowerCase();
    if (secretName.test(field) || field === 'command') return '[REDACTED]';
    if (Array.isArray(value)) {
        if (field === 'args') return value.map(() => '[REDACTED]');
        return value.map(item => redact(item));
    }
    if (value && typeof value === 'object') {
        if (['headers', 'env', 'environment', 'envvalues', 'staticoauth'].includes(field)) {
            return Object.fromEntries(Object.keys(value).map(key => [key, '[REDACTED]']));
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
    }
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            return `${url.origin}${url.pathname}`;
        } catch {
            return '[INVALID URL]';
        }
    }
    return value;
}

export function readSavedSettings() {
    const applicationDir = '/lunar/packages/mcpx-server';
    const paths = {
        servers: path.resolve(applicationDir, process.env.SERVERS_CONFIG_PATH ?? 'config/mcp.json'),
        application: path.resolve(applicationDir, process.env.APP_CONFIG_PATH ?? 'config/app.yaml')
    };
    const config = fs.existsSync(paths.servers)
        ? JSON.parse(fs.readFileSync(paths.servers, 'utf8'))
        : { mcpServers: {} };
    return { config, paths };
}

/**
 * Parses embedded configuration before redacting its fields.
 * @param {unknown} value
 * @param {(text: string) => unknown} parseYaml
 * @returns {unknown}
 */
export function redactApplicationConfig(value, parseYaml) {
    if (value && typeof value === 'object' && 'yaml' in value && typeof value.yaml === 'string') {
        return redact({ ...value, yaml: parseYaml(value.yaml) });
    }
    return redact(value);
}
