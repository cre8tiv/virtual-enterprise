// Microsoft Graph client for the M365 sandbox, authenticated as the ve-provisioning app
// (client credentials). Tenant-guarded: the token must belong to the tenant in local/registry.md.
//
// Credentials: vault "Service & API" / "Entra app: ve-provisioning"
//   username = application (client) ID, password = client secret

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegistryValue } from '../lib/registry.mjs';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const APP_RESOURCE = 'Entra app: ve-provisioning';
const VAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vault', 'vault.mjs');

/**
 * Run the vault adapter.
 * @param {string[]} vaultArgs
 * @returns {string | null} stdout, or null when the resource doesn't exist yet
 */
export function vault(vaultArgs) {
  try {
    return execFileSync(process.execPath, [VAULT, ...vaultArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // Only a missing resource means "not stored yet"; a missing folder is a setup error.
    if (/Resource ".*" not found/.test(String(err.stderr))) return null;
    throw new Error(`vault ${vaultArgs[0]} failed: ${String(err.stderr).trim()}`);
  }
}

/** @param {string} s @returns {string} OData string literal */
export function odata(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = '';

/**
 * Call Graph with retries for throttling (429/503) and, when `retry404`, for eventual consistency of new objects.
 * @param {string} method @param {string} path relative to GRAPH, or an absolute nextLink
 * @param {any} [body] @param {{retry404?: boolean}} [opts]
 * @returns {Promise<any>} parsed JSON, or null for 204
 */
export async function graph(method, path, body, opts = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ConsistencyLevel: 'eventual' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    const retryable = res.status === 429 || res.status === 503 || (opts.retry404 && res.status === 404);
    if (retryable && attempt < 6) {
      await sleep(Number(res.headers.get('Retry-After')) * 1000 || 2000 * (attempt + 1));
      continue;
    }
    const error = new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    error.status = res.status;
    throw error;
  }
}

/** @param {string} path @returns {Promise<any[]>} items from every page */
export async function graphAll(path) {
  const items = [];
  for (let next = path; next; ) {
    const page = await graph('GET', next);
    items.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return items;
}

/**
 * Authenticate as ve-provisioning against the registry's tenant and return tenant facts.
 * @returns {Promise<{ tenant: string, clientId: string, displayName: string, verifiedDomains: {name: string, isDefault: boolean}[], roles: string[] }>}
 *   roles: the application permissions granted to the token (e.g. "User.ReadWrite.All")
 */
export async function connect() {
  const tenant = getRegistryValue('M365 tenant ID');
  if (!tenant) throw new Error('local/registry.md has no "M365 tenant ID"');
  const clientId = vault(['get', 'Service & API', APP_RESOURCE, '--field', 'username']);
  const secret = vault(['get', 'Service & API', APP_RESOURCE]);
  if (!clientId || !secret) throw new Error(`Vault resource "${APP_RESOURCE}" not found in "Service & API"`);

  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId.trim(),
      client_secret: secret.trim(),
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${json.error_description || res.status}`);
  const claims = JSON.parse(Buffer.from(json.access_token.split('.')[1], 'base64url').toString());
  if (claims.tid !== tenant) throw new Error(`Token tenant ${claims.tid} does not match registry tenant ${tenant}`);
  token = json.access_token;

  const [org] = (await graph('GET', '/organization?$select=displayName,verifiedDomains')).value;
  return {
    tenant,
    clientId: clientId.trim(),
    displayName: org.displayName,
    verifiedDomains: org.verifiedDomains,
    roles: claims.roles || [],
  };
}
