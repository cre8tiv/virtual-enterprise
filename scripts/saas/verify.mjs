#!/usr/bin/env node
// Check that each SaaS service's vaulted API credential works, with one cheap read-only call per service.
// Reads canonical/saas/services.yaml for vault names and registry keys. Prints one status line per service:
//   ok        credential works (detail names the account it reached)
//   missing   registry value or vault credential not recorded yet
//   FAILED    the call failed (detail has the HTTP status or error)
// QuickBooks: Intuit may rotate the refresh token on use; the newest one is saved back to the vault.
//
// Usage: node scripts/saas/verify.mjs [service ...]   (default: every service in the catalog)
// Exit code: 0 when no service FAILED.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { getRegistryValue } from '../lib/registry.mjs';
import { vault } from '../m365/graph.mjs';

const CATALOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'canonical', 'saas', 'services.yaml');
const { services } = parse(readFileSync(CATALOG, 'utf8'));
const wanted = process.argv.slice(2);

class Missing extends Error {}

/** @param {any} service @param {number} [i] @returns {{username: string, password: string}} */
function credential(service, i = 0) {
  const name = service.credentials[i].vault;
  const password = vault(['get', 'Service & API', name])?.trim();
  const username = vault(['get', 'Service & API', name, '--field', 'username'])?.trim();
  if (!password) throw new Missing(`vault "${name}"`);
  return { username, password };
}

/** @param {any} service @returns {string} the service's first registry value */
function registry(service) {
  const key = Object.keys(service.registry)[0];
  const value = getRegistryValue(key);
  if (!value) throw new Missing(`registry "${key}"`);
  return value.replace(/\/$/, '');
}

/** @param {string} url @param {RequestInit} [init] @returns {Promise<any>} parsed JSON; throws on HTTP errors */
async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${text.slice(0, 80).replace(/\s+/g, ' ')}...)`); // e.g. a hibernating PDI
  }
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

const checks = {
  async salesforce(s) {
    const org = registry(s);
    const { username: id, password: secret } = credential(s);
    const token = await getJson(`${org}/services/oauth2/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    });
    const versions = await getJson(`${org}/services/data/`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const latest = versions.at(-1).url;
    const limits = await getJson(`${org}${latest}/limits`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    return `API v${versions.at(-1).version}, daily API requests remaining ${limits.DailyApiRequests?.Remaining}`;
  },

  async hubspot(s) {
    const { password: token } = credential(s);
    const info = await getJson('https://api.hubapi.com/account-info/v3/details', { headers: { Authorization: `Bearer ${token}` } });
    await getJson('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { Authorization: `Bearer ${token}` } });
    return `account ${info.portalId} (${info.accountType})`;
  },

  async quickbooks(s) {
    const realm = registry(s);
    const app = credential(s, 0);
    const refresh = credential(s, 1);
    const token = await getJson('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { Authorization: basic(app.username, app.password), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh.password }),
    });
    if (token.refresh_token && token.refresh_token !== refresh.password) {
      vault(['upsert', 'Service & API', s.credentials[1].vault, '--password', token.refresh_token, '--rotate']);
    }
    const info = await getJson(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realm}/companyinfo/${realm}?minorversion=75`,
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    return `sandbox company "${info.CompanyInfo.CompanyName}"`;
  },

  async servicenow(s) {
    const instance = registry(s);
    const { username, password } = credential(s);
    const res = await getJson(`${instance}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=user_name`,
      { headers: { Authorization: basic(username, password) } });
    return `Table API reachable (${res.result.length} row read)`;
  },

  async jira(s) {
    const site = registry(s);
    const { username, password } = credential(s);
    const me = await getJson(`${site}/rest/api/3/myself`, { headers: { Authorization: basic(username, password) } });
    return `signed in as ${me.emailAddress || me.displayName}`;
  },

  async github(s) {
    const orgName = registry(s);
    const { password: token } = credential(s);
    const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const org = await getJson(`https://api.github.com/orgs/${orgName}`, { headers });
    return `org ${org.login} (${org.plan?.name ?? 'plan hidden'})`;
  },
};

let failed = 0;
for (const s of services) {
  if (wanted.length && !wanted.includes(s.key)) continue;
  const check = checks[s.key];
  if (!check) {
    console.log(`  ${s.key.padEnd(12)} no check defined`);
    continue;
  }
  try {
    console.log(`  ${s.key.padEnd(12)} ok       ${await check(s)}`);
  } catch (err) {
    if (err instanceof Missing) {
      console.log(`  ${s.key.padEnd(12)} missing  ${err.message}`);
    } else {
      failed++;
      console.log(`  ${s.key.padEnd(12)} FAILED   ${err.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
