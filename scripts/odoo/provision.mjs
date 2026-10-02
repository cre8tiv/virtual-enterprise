#!/usr/bin/env node
// Provision the org model into Odoo Community (https://hr.<domain>, database "hr") over JSON-RPC: company,
// HR apps, site addresses and work locations, departments with managers, job positions, the 25 persona
// employees, the HR manager's Odoo user, and the SUT's API user. Idempotent: prints a plan and changes nothing
// unless --apply is given.
//
// Usage:
//   node scripts/odoo/provision.mjs --bootstrap-admin   over SSH, before hr.<domain> is public: replace the fresh
//                                                       database's default admin/admin with the vaulted password
//   node scripts/odoo/provision.mjs [--apply]           plan / apply over JSON-RPC
//
// Inputs:
//   local/registry.md: Domain, Company name, Cloud VM address
//   vault "Service & API" / "Odoo: admin" (login admin; created by --bootstrap-admin)
// Employees are matched by Badge ID (barcode = canonical employee ID, e.g. E0001). Generated (non-persona)
// employees are loaded in Phase 10. Odoo users linked to personas get the persona's TOTP seed (auth_totp),
// set with `odoo shell` over SSH because the API can't write it.

import { randomBytes } from 'node:crypto';
import { getRegistryValue } from '../lib/registry.mjs';
import { loadOrg } from '../lib/org.mjs';
import { odooShell } from '../lib/cloudvm.mjs';
import { seedResource } from '../lib/totp.mjs';
import { vault } from '../m365/graph.mjs';

const APPLY = process.argv.includes('--apply');
const DB = 'hr';
const MODULES = ['hr', 'hr_holidays', 'hr_recruitment', 'hr_attendance', 'hr_expense', 'auth_totp'];

if (process.argv.includes('--bootstrap-admin')) {
  let password = vault(['get', 'Service & API', 'Odoo: admin'])?.trim();
  if (!password) {
    password = `${randomBytes(24).toString('base64url')}Aa1!`;
    vault(['upsert', 'Service & API', 'Odoo: admin', '--username', 'admin', '--password', password]);
  }
  const out = odooShell([
    'import json',
    `u = env.ref("base.user_admin")`,
    `u.password = json.loads(${JSON.stringify(JSON.stringify(password))})`,
    'env.cr.commit()',
    'print("admin password set")',
    '',
  ].join('\n'));
  console.log(out.includes('admin password set') ? 'admin password set from the vault' : out);
  process.exit(out.includes('admin password set') ? 0 : 1);
}
const SUT_LOGIN = (domain) => `sut-odoo@svc.${domain}`;

const domain = getRegistryValue('Domain');
const company = getRegistryValue('Company name');
if (!domain || !company) throw new Error('local/registry.md needs Domain and Company name (Phase 1)');
const org = loadOrg(domain);
const URL = `https://hr.${domain}/jsonrpc`;

/** @param {string} service @param {string} method @param {any[]} args @returns {Promise<any>} */
async function rpc(service, method, args) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${service}.${method}: ${json.error.data?.message || json.error.message}`);
  return json.result;
}

// --- admin session (bootstrap the vaulted password on first run) ------------------------------------------

let adminPassword = vault(['get', 'Service & API', 'Odoo: admin'])?.trim();
let uid = adminPassword ? await rpc('common', 'authenticate', [DB, 'admin', adminPassword, {}]) : false;
if (!uid) {
  const defaultUid = await rpc('common', 'authenticate', [DB, 'admin', 'admin', {}]);
  if (!defaultUid) throw new Error('Cannot sign in as admin with the vaulted password or the initial default; check the "hr" database exists');
  console.log(`  ${APPLY ? '+' : '~'} replace the default admin password with a vaulted one`);
  if (!APPLY) {
    uid = defaultUid;
    adminPassword = 'admin';
  } else {
    const next = adminPassword || `${randomBytes(24).toString('base64url')}Aa1!`;
    vault(['upsert', 'Service & API', 'Odoo: admin', '--username', 'admin', '--uri', `https://hr.${domain}/odoo`, '--password', next]);
    await rpc('object', 'execute_kw', [DB, defaultUid, 'admin', 'res.users', 'write', [[defaultUid], { password: next }]]);
    adminPassword = next;
    uid = await rpc('common', 'authenticate', [DB, 'admin', adminPassword, {}]);
  }
}

/** @param {string} model @param {string} method @param {any[]} [args] @param {object} [kwargs] */
const call = (model, method, args = [], kwargs = {}) =>
  rpc('object', 'execute_kw', [DB, uid, adminPassword, model, method, args, kwargs]);

const version = await rpc('common', 'version', []);
console.log(`Odoo ${version.server_version} at https://hr.${domain} (db ${DB})  Mode: ${APPLY ? 'apply' : 'plan'}`);

let changes = 0;
/** @param {string} line @param {() => Promise<void>} action */
const step = async (line, action) => {
  changes++;
  console.log(`  ${APPLY ? '+' : '~'} ${line}`);
  if (APPLY) await action();
};

/**
 * Find a record by domain, or plan/create it.
 * @param {string} model @param {any[]} domainFilter @param {object} values @param {string} label
 * @returns {Promise<number | undefined>} record id (undefined in plan mode when it doesn't exist yet)
 */
async function ensure(model, domainFilter, values, label) {
  const [id] = await call(model, 'search', [domainFilter], { limit: 1 });
  if (id) return id;
  let created;
  await step(`create ${label}`, async () => {
    created = await call(model, 'create', [values]);
  });
  return created;
}

/** @param {string} module @param {string} name @returns {Promise<number>} id of a record by XML ID */
async function xmlid(module, name) {
  const [row] = await call('ir.model.data', 'search_read', [[['module', '=', module], ['name', '=', name]]], { fields: ['res_id'] });
  if (!row) throw new Error(`XML ID ${module}.${name} not found`);
  return row.res_id;
}

// 1. HR apps
const pending = await call('ir.module.module', 'search_read',
  [[['name', 'in', MODULES], ['state', '!=', 'installed']]], { fields: ['name'] });
if (pending.length) {
  await step(`install apps: ${pending.map((m) => m.name).join(', ')}`, () =>
    call('ir.module.module', 'button_immediate_install', [pending.map((m) => m.id)]));
}

// 2. Company
const [main] = await call('res.company', 'search_read', [[]], { fields: ['name', 'partner_id'], limit: 1, order: 'id' });
if (main.name !== company) {
  await step(`rename company "${main.name}" to "${company}"`, () => call('res.company', 'write', [[main.id], { name: company }]));
}

// 3. Sites: address partners and work locations
const countryId = async (code) => (await call('res.country', 'search', [[['code', '=', code]]], { limit: 1 }))[0];
const locationId = new Map();
for (const s of org.sites) {
  const partner = await ensure('res.partner', [['name', '=', `${company} ${s.name}`]],
    { name: `${company} ${s.name}`, is_company: false, city: s.city, country_id: await countryId(s.country), parent_id: main.partner_id[0] },
    `address "${s.name}"`);
  const loc = await ensure('hr.work.location', [['name', '=', s.name]],
    { name: s.name, address_id: partner, location_type: 'office' }, `work location "${s.name}"`);
  locationId.set(s.key, loc);
}

// 4. Departments and job positions
const deptId = new Map();
for (const d of org.departments) {
  deptId.set(d.key, await ensure('hr.department', [['name', '=', d.name]], { name: d.name }, `department "${d.name}"`));
}
const jobId = new Map();
for (const title of new Set(org.personas.map((p) => p.title))) {
  jobId.set(title, await ensure('hr.job', [['name', '=', title]], { name: title }, `job position "${title}"`));
}

// 5. Employees (matched by Badge ID), then managers and department heads
const siteOf = new Map(org.sites.map((s) => [s.name, s.key]));
const employeeId = new Map();
for (const p of org.personas) {
  const values = {
    name: p.displayName,
    work_email: p.upn,
    job_id: jobId.get(p.title),
    job_title: p.title,
    department_id: deptId.get(p.departmentKey),
    work_location_id: locationId.get(siteOf.get(p.siteName)),
    barcode: p.id,
  };
  const [existing] = await call('hr.employee', 'search_read', [[['barcode', '=', p.id]]],
    { fields: Object.keys(values), context: { active_test: false } });
  if (!existing) {
    await step(`create employee ${p.displayName} (${p.id})`, async () => {
      employeeId.set(p.key, await call('hr.employee', 'create', [values]));
    });
    continue;
  }
  employeeId.set(p.key, existing.id);
  const many2one = (v) => (Array.isArray(v) ? v[0] : v);
  const drift = Object.keys(values).filter((k) => values[k] !== undefined && many2one(existing[k]) !== values[k]);
  if (drift.length) {
    await step(`update ${p.displayName}: ${drift.join(', ')}`, () => call('hr.employee', 'write', [[existing.id], values]));
  }
}
for (const p of org.personas) {
  if (!p.manager) continue;
  if (!employeeId.get(p.key)) {
    changes++;
    console.log(`  ~ set manager of ${p.key} to ${p.manager} (after the employee is created)`);
    continue;
  }
  const [row] = await call('hr.employee', 'read', [[employeeId.get(p.key)]], { fields: ['parent_id'] });
  if (row.parent_id?.[0] === employeeId.get(p.manager)) continue;
  await step(`set manager of ${p.key} to ${p.manager}`, () =>
    call('hr.employee', 'write', [[employeeId.get(p.key)], { parent_id: employeeId.get(p.manager) }]));
}
for (const d of org.departments) {
  const id = deptId.get(d.key);
  const head = employeeId.get(d.head);
  if (!id || !head) continue;
  const [row] = await call('hr.department', 'read', [[id]], { fields: ['manager_id'] });
  if (row.manager_id?.[0] === head) continue;
  await step(`set head of ${d.name} to ${d.head}`, () => call('hr.department', 'write', [[id], { manager_id: head }]));
}

// 6. Odoo users: the HR manager persona (HR administrator) and the SUT API user (Employees officer)
const userFields = await call('res.users', 'fields_get', [], { attributes: ['type'] });
const groupsField = 'group_ids' in userFields ? 'group_ids' : 'groups_id'; // renamed in newer Odoo versions
const hrManager = org.personas.find((p) => p.key === 'hr-manager');
const users = [
  { login: hrManager.upn, name: hrManager.displayName, group: ['hr', 'group_hr_manager'], vaultFolder: 'Personas', vaultName: `odoo: ${hrManager.upn}`, employee: employeeId.get('hr-manager') },
  { login: SUT_LOGIN(domain), name: 'SUT API (Odoo)', group: ['hr', 'group_hr_user'], vaultFolder: 'Service & API', vaultName: 'Odoo: SUT API user' },
];
for (const u of users) {
  const [existing] = await call('res.users', 'search', [[['login', '=', u.login]]], { limit: 1, context: { active_test: false } });
  if (existing) continue;
  await step(`create Odoo user ${u.login}`, async () => {
    let password = vault(['get', u.vaultFolder, u.vaultName])?.trim();
    if (!password) {
      password = `${randomBytes(24).toString('base64url')}Aa1!`;
      vault(['upsert', u.vaultFolder, u.vaultName, '--username', u.login, '--uri', `https://hr.${domain}/odoo`, '--password', password]);
    }
    const userId = await call('res.users', 'create', [{
      name: u.name, login: u.login, email: u.login, password, [groupsField]: [[4, await xmlid(...u.group)]],
    }]);
    if (u.employee) await call('hr.employee', 'write', [[u.employee], { user_id: userId }]);
  });
}

// 7. TOTP for persona-linked Odoo users (the persona's vault seed; auth_totp)
const personaByUpn = new Map(org.personas.map((p) => [p.upn, p]));
const loginUsers = await call('res.users', 'search_read', [[['login', 'in', [...personaByUpn.keys()]]]], { fields: ['login', 'totp_enabled'] })
  .catch(() => []); // totp_enabled exists once auth_totp is installed
const needTotp = {};
for (const u of loginUsers.filter((x) => !x.totp_enabled)) {
  const seed = vault(['get', 'Personas', seedResource(u.login)])?.trim();
  if (seed) needTotp[u.login] = seed;
  else console.log(`  ! ${u.login} has no TOTP seed in the vault; run scripts/m365/mfa.mjs first`);
}
if (Object.keys(needTotp).length) {
  await step(`enable TOTP for ${Object.keys(needTotp).join(', ')} via odoo shell`, async () => {
    const out = odooShell([
      'import json',
      `data = json.loads(${JSON.stringify(JSON.stringify(needTotp))})`,
      'for login, seed in data.items():',
      '    user = env["res.users"].search([("login", "=", login)], limit=1)',
      '    user.totp_secret = seed',
      '    print("totp", login)',
      'env.cr.commit()',
      '',
    ].join('\n'));
    for (const line of out.split('\n').filter((l) => l.startsWith('totp '))) console.log(`    ${line}`);
  });
}

console.log(changes ? `${changes} change(s) ${APPLY ? 'applied' : 'planned; re-run with --apply'}` : 'No changes: Odoo matches the org model');
