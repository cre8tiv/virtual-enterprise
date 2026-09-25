#!/usr/bin/env node
// Provision the org model into the Okta Integrator Free Plan org: catalog groups, the persona subset
// (personas.yaml idp_subsets.okta; the plan allows 10 active users), profiles, memberships, passwords, and a
// Custom OTP factor carrying the persona's vault TOTP seed. Idempotent: prints a plan and changes nothing
// unless --apply is given.
//
// Usage: node scripts/okta/provision.mjs [--apply] [--prune] [--rotate <upn|all>]
//   --prune   also remove personas from catalog groups they no longer belong to
//   --rotate  set a new password (vault "Personas" / "okta: <upn>")
//
// Inputs:
//   local/registry.md: Domain, Company name, Okta org URL, Okta custom OTP factor profile
//   vault "Service & API" / "Okta API token" (SSWS token of an org admin)

import { randomBytes } from 'node:crypto';
import { getRegistryValue } from '../lib/registry.mjs';
import { loadOrg } from '../lib/org.mjs';
import { seedResource } from '../lib/totp.mjs';
import { vault } from '../m365/graph.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PRUNE = args.includes('--prune');
const ROTATE = args.includes('--rotate') ? args[args.indexOf('--rotate') + 1] : undefined;
const MAX_ACTIVE_USERS = 10;

const domain = getRegistryValue('Domain');
const orgUrl = getRegistryValue('Okta org URL')?.replace(/\/$/, '');
const factorProfileId = getRegistryValue('Okta custom OTP factor profile');
if (!domain || !orgUrl) throw new Error('local/registry.md needs Domain and "Okta org URL"');
const token = vault(['get', 'Service & API', 'Okta API token'])?.trim();
if (!token) throw new Error('Vault resource "Okta API token" not found in "Service & API"');

const org = loadOrg(domain);
const subset = org.subsets.okta ?? org.personas.map((p) => p.key);
if (subset.length > MAX_ACTIVE_USERS) throw new Error(`idp_subsets.okta has ${subset.length} personas; the plan allows ${MAX_ACTIVE_USERS}`);
const personas = org.personas.filter((p) => subset.includes(p.key));
const byKey = new Map(org.personas.map((p) => [p.key, p]));
const groups = org.groups.filter((g) => g.provision_to.includes('okta'));
const company = getRegistryValue('Company name') || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} method @param {string} path @param {any} [body]
 * @returns {Promise<{status: number, body: any, next?: string}>}
 */
async function okta(method, path, body) {
  const url = path.startsWith('http') ? path : `${orgUrl}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `SSWS ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      await sleep(Math.max(1000, reset - Date.now()));
      continue;
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok && res.status !== 404) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1];
    return { status: res.status, body: parsed, next };
  }
}

/** @param {string} path @returns {Promise<any[]>} every page */
async function oktaAll(path) {
  const items = [];
  for (let next = path; next; ) {
    const res = await okta('GET', next);
    items.push(...res.body);
    next = res.next;
  }
  return items;
}

const newPassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;

let changes = 0;
/** @param {string} line @param {() => Promise<void>} action */
const step = async (line, action) => {
  changes++;
  console.log(`  ${APPLY ? '+' : '~'} ${line}`);
  if (APPLY) await action();
};

console.log(`Okta: ${orgUrl}  Personas: ${personas.length}/${org.personas.length}  Mode: ${APPLY ? 'apply' : 'plan'}`);

// 1. Groups (OKTA_GROUP type only)
const groupId = new Map((await oktaAll('/api/v1/groups?filter=type eq "OKTA_GROUP"&limit=200')).map((g) => [g.profile.name, g.id]));
for (const g of groups) {
  if (groupId.has(g.name)) continue;
  await step(`create group ${g.name}`, async () => {
    const res = await okta('POST', '/api/v1/groups', { profile: { name: g.name, description: g.description || `${g.type} group` } });
    groupId.set(g.name, res.body.id);
  });
}

// 2. Users
const userId = new Map();
for (const p of personas) {
  const manager = p.manager ? byKey.get(p.manager) : null;
  const profile = {
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.upn,
    login: p.upn,
    title: p.title,
    department: p.department,
    division: p.region.toUpperCase(),
    costCenter: p.costCenter,
    employeeNumber: p.id,
    city: p.city,
    countryCode: p.country,
    organization: company,
    manager: manager?.displayName,
    managerId: manager?.id,
  };
  const found = await okta('GET', `/api/v1/users/${encodeURIComponent(p.upn)}`);
  const vaultName = `okta: ${p.upn}`;
  let password = vault(['get', 'Personas', vaultName])?.trim();

  if (found.status === 404) {
    await step(`create and activate user ${p.upn} (${p.key})`, async () => {
      if (!password) {
        password = newPassword();
        vault(['upsert', 'Personas', vaultName, '--username', p.upn, '--uri', orgUrl, '--password', password]);
      }
      const res = await okta('POST', '/api/v1/users?activate=true', { profile, credentials: { password: { value: password } } });
      userId.set(p.key, res.body.id);
    });
    continue;
  }

  const user = found.body;
  userId.set(p.key, user.id);
  const drift = Object.keys(profile).filter((k) => profile[k] !== undefined && user.profile[k] !== profile[k]);
  if (drift.length) {
    await step(`update ${p.upn}: ${drift.join(', ')}`, () => okta('POST', `/api/v1/users/${user.id}`, { profile: { ...user.profile, ...profile } }));
  }
  if (!password || ROTATE === 'all' || ROTATE === p.upn) {
    await step(`${password ? 'rotate' : 'set and vault'} password for ${p.upn}`, async () => {
      password = newPassword();
      vault(['upsert', 'Personas', vaultName, '--username', p.upn, '--uri', orgUrl, '--password', password, '--rotate']);
      await okta('POST', `/api/v1/users/${user.id}`, { credentials: { password: { value: password } } });
    });
  }
}

// 3. Memberships
const personaIds = () => new Set(userId.values());
for (const g of groups) {
  const gid = groupId.get(g.name);
  const current = gid ? new Set((await oktaAll(`/api/v1/groups/${gid}/users?limit=200`)).map((u) => u.id)) : new Set();
  const wanted = personas.filter((p) => p.groups.includes(g.name));
  for (const p of wanted) {
    if (userId.get(p.key) && current.has(userId.get(p.key))) continue;
    await step(`add ${p.key} to ${g.name}`, () => okta('PUT', `/api/v1/groups/${groupId.get(g.name)}/users/${userId.get(p.key)}`));
  }
  if (PRUNE && gid) {
    const wantedIds = new Set(wanted.map((p) => userId.get(p.key)));
    for (const uid of current) {
      if (personaIds().has(uid) && !wantedIds.has(uid)) {
        await step(`remove ${uid} from ${g.name}`, () => okta('DELETE', `/api/v1/groups/${gid}/users/${uid}`));
      }
    }
  }
}

// 4. Custom OTP factor with the persona's vault seed
if (!factorProfileId) {
  console.log('  ! No "Okta custom OTP factor profile" in the registry; add the Custom OTP authenticator first (skill step 3)');
} else {
  for (const p of personas) {
    const uid = userId.get(p.key);
    const factors = uid ? (await okta('GET', `/api/v1/users/${uid}/factors`)).body || [] : [];
    const otp = factors.find((f) => f.factorType === 'token:hotp' && f.provider === 'CUSTOM');
    if (otp?.status === 'ACTIVE') continue;
    const seed = vault(['get', 'Personas', seedResource(p.upn)])?.trim();
    if (!seed) {
      console.log(`  ! ${p.upn} has no TOTP seed in the vault; run scripts/m365/mfa.mjs (or scripts/lib/totp.mjs ensure) first`);
      continue;
    }
    await step(`enroll Custom OTP for ${p.upn}`, async () => {
      if (otp) await okta('DELETE', `/api/v1/users/${userId.get(p.key)}/factors/${otp.id}`);
      await okta('POST', `/api/v1/users/${userId.get(p.key)}/factors?activate=true`, {
        factorType: 'token:hotp', provider: 'CUSTOM', factorProfileId, profile: { sharedSecret: seed },
      });
    });
  }
}

console.log(changes ? `${changes} change(s) ${APPLY ? 'applied' : 'planned; re-run with --apply'}` : 'No changes: Okta matches the org model');
