#!/usr/bin/env node
// Provision the org model into authentik (https://sso.<domain>): catalog groups, the 25 persona users with
// attributes and group memberships, their passwords, and their TOTP devices (the persona's vault seed).
// Idempotent: prints a plan and changes nothing unless --apply is given.
//
// Usage: node scripts/authentik/provision.mjs [--apply] [--prune] [--rotate <upn|all>]
//   --prune   also remove personas from catalog groups they no longer belong to
//   --rotate  set a new password (vault "Personas" / "authentik: <upn>")
//
// Inputs:
//   local/registry.md: Domain, Cloud VM address (ubuntu@<ip>, for the TOTP step)
//   vault "Service & API" / "authentik: API token" (the AUTHENTIK_BOOTSTRAP_TOKEN)
// TOTP devices can't be created with a given key through authentik's API (the key isn't writable), so they are
// created with `ak shell` on the cloud VM over SSH; the seeds travel on stdin, never as arguments.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getRegistryValue } from '../lib/registry.mjs';
import { loadOrg } from '../lib/org.mjs';
import { base32Decode, seedResource } from '../lib/totp.mjs';
import { vault } from '../m365/graph.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PRUNE = args.includes('--prune');
const ROTATE = args.includes('--rotate') ? args[args.indexOf('--rotate') + 1] : undefined;
const DEVICE_NAME = 've-vault';
const SSH_KEY = join(homedir(), '.config', 'virtual-enterprise', 'cloud_ssh');

const domain = getRegistryValue('Domain');
if (!domain) throw new Error('local/registry.md has no Domain (Phase 1)');
const org = loadOrg(domain);
const groups = org.groups.filter((g) => g.provision_to.includes('authentik'));
const API = `https://sso.${domain}/api/v3`;
const token = vault(['get', 'Service & API', 'authentik: API token'])?.trim();
if (!token) throw new Error('Vault resource "authentik: API token" not found in "Service & API"');

/** @param {string} method @param {string} path @param {any} [body] @returns {Promise<any>} */
async function ak(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** @param {string} path @returns {Promise<any[]>} every page of a list endpoint */
async function akAll(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await ak('GET', `${path}${sep}page=${page}&page_size=100`);
    items.push(...res.results);
    if (!res.pagination?.next) return items;
  }
}

const newPassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;

let changes = 0;
/** @param {string} line @param {() => Promise<void>} action */
const step = async (line, action) => {
  changes++;
  console.log(`  ${APPLY ? '+' : '~'} ${line}`);
  if (APPLY) await action();
};

const me = await ak('GET', '/core/users/me/');
console.log(`authentik: ${API} (as ${me.user.username})  Mode: ${APPLY ? 'apply' : 'plan'}`);

// 1. Groups
const groupPk = new Map((await akAll('/core/groups/')).map((g) => [g.name, g.pk]));
for (const g of groups) {
  if (groupPk.has(g.name)) continue;
  await step(`create group ${g.name}`, async () => {
    const created = await ak('POST', '/core/groups/', { name: g.name, attributes: { catalogType: g.type } });
    groupPk.set(g.name, created.pk);
  });
}

// 2. Users, attributes, memberships, passwords
const catalogPks = () => new Set(groups.map((g) => groupPk.get(g.name)).filter(Boolean));
const userPk = new Map();
for (const p of org.personas) {
  const attributes = {
    employeeId: p.id,
    title: p.title,
    department: p.department,
    costCenter: p.costCenter,
    site: p.siteName,
    city: p.city,
    country: p.country,
    region: p.region,
    manager: p.manager,
    personaKey: p.key,
  };
  const wanted = () => p.groups.filter((n) => groupPk.has(n)).map((n) => groupPk.get(n));
  const [existing] = (await ak('GET', `/core/users/?username=${encodeURIComponent(p.upn)}`)).results;
  const vaultName = `authentik: ${p.upn}`;
  let password = vault(['get', 'Personas', vaultName])?.trim();

  if (!existing) {
    await step(`create user ${p.upn} (${p.key})`, async () => {
      if (!password) {
        password = newPassword();
        vault(['upsert', 'Personas', vaultName, '--username', p.upn, '--uri', `https://sso.${domain}/`, '--password', password]);
      }
      const created = await ak('POST', '/core/users/', {
        username: p.upn, name: p.displayName, email: p.upn, is_active: true, path: 'users', type: 'internal',
        attributes, groups: wanted(),
      });
      userPk.set(p.key, created.pk);
      await ak('POST', `/core/users/${created.pk}/set_password/`, { password });
    });
    continue;
  }

  userPk.set(p.key, existing.pk);
  const current = new Set(existing.groups);
  const desired = new Set(wanted());
  const keep = [...current].filter((pk) => desired.has(pk) || !PRUNE || !catalogPks().has(pk));
  const next = [...new Set([...keep, ...desired])];
  const attrDrift = Object.entries(attributes).some(([k, v]) => existing.attributes?.[k] !== v);
  if (next.length !== current.size || next.some((pk) => !current.has(pk)) || attrDrift || existing.name !== p.displayName) {
    await step(`update ${p.upn}: ${attrDrift ? 'attributes ' : ''}groups/name`, () =>
      ak('PATCH', `/core/users/${existing.pk}/`, {
        name: p.displayName, attributes: { ...existing.attributes, ...attributes }, groups: next,
      }));
  }
  if (!password || ROTATE === 'all' || ROTATE === p.upn) {
    await step(`${password ? 'rotate' : 'set and vault'} password for ${p.upn}`, async () => {
      password = newPassword();
      vault(['upsert', 'Personas', vaultName, '--username', p.upn, '--uri', `https://sso.${domain}/`, '--password', password, '--rotate']);
      await ak('POST', `/core/users/${existing.pk}/set_password/`, { password });
    });
  }
}

// 3. TOTP devices (persona seed, via ak shell on the cloud VM)
const devices = await akAll('/authenticators/admin/totp/');
const hasDevice = (upn) => devices.some((d) => d.name === DEVICE_NAME && d.user?.username === upn);
const needTotp = {};
for (const p of org.personas) {
  if (hasDevice(p.upn)) continue;
  const seed = vault(['get', 'Personas', seedResource(p.upn)])?.trim();
  if (!seed) {
    console.log(`  ! ${p.upn} has no TOTP seed in the vault; run scripts/m365/mfa.mjs (or scripts/lib/totp.mjs ensure) first`);
    continue;
  }
  needTotp[p.upn] = base32Decode(seed).toString('hex');
}
if (Object.keys(needTotp).length) {
  await step(`create TOTP devices for ${Object.keys(needTotp).length} persona(s) via ak shell`, async () => {
    const target = getRegistryValue('Cloud VM address');
    if (!target) throw new Error('local/registry.md has no "Cloud VM address" (Phase 5a)');
    const python = [
      'import json, sys',
      'from authentik.core.models import User',
      'from authentik.stages.authenticator_totp.models import TOTPDevice',
      `data = json.loads(${JSON.stringify(JSON.stringify(needTotp))})`,
      'for username, key in data.items():',
      '    user = User.objects.get(username=username)',
      `    device, created = TOTPDevice.objects.get_or_create(user=user, name="${DEVICE_NAME}", defaults={"key": key, "confirmed": True, "digits": 6, "step": 30})`,
      '    if not created and (device.key != key or not device.confirmed):',
      '        device.key = key',
      '        device.confirmed = True',
      '        device.save()',
      '    print("totp", username, "created" if created else "updated")',
      '',
    ].join('\n');
    const out = execFileSync('ssh', ['-i', SSH_KEY, '-o', 'BatchMode=yes', target,
      'cd /opt/ve/cloud && docker compose exec -T authentik-server ak shell'], { input: python, encoding: 'utf8' });
    for (const line of out.split('\n').filter((l) => l.startsWith('totp '))) console.log(`    ${line}`);
  });
}

// 4. MFA check: the default authentication flow prompts for configured devices
const [validation] = (await ak('GET', '/stages/authenticator/validate/?name=default-authentication-mfa-validation')).results;
if (!validation) console.log('  ! Stage "default-authentication-mfa-validation" not found; check the authentication flow prompts for TOTP');
else if (!validation.device_classes.includes('totp')) console.log('  ! The MFA validation stage does not accept TOTP devices');

console.log(changes ? `${changes} change(s) ${APPLY ? 'applied' : 'planned; re-run with --apply'}` : 'No changes: authentik matches the org model');
