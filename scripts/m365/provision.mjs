#!/usr/bin/env node
// Provision the org model into the M365 E5 sandbox through Microsoft Graph:
// security groups from the catalog, the 25 persona users, group memberships, managers, and
// group-based E5 licensing on app-m365. Idempotent: computes a plan from live state and applies
// only the differences. Prints the plan and changes nothing unless --apply is given.
//
// Usage:
//   node scripts/m365/provision.mjs --desired              print desired personas/groups (no Graph, no vault)
//   node scripts/m365/provision.mjs                        plan against the tenant
//   node scripts/m365/provision.mjs --apply [--prune] [--rotate <upn|all>]
//     --prune   also remove personas from catalog groups they no longer belong to
//     --rotate  reset the password of one persona (or all) and update its vault entry
//
// Inputs:
//   local/registry.md: Domain, Company name, M365 tenant ID
//   vault credentials for the ve-provisioning app (see graph.mjs)
// Persona passwords are stored in the vault ("Personas", resource name = UPN) BEFORE the user is created,
// so a crash never leaves a user with an unknown password.

import { randomBytes } from 'node:crypto';
import { getRegistryValue } from '../lib/registry.mjs';
import { loadOrg } from '../lib/org.mjs';
import { GRAPH, connect, graph, graphAll, odata, vault } from './graph.mjs';

const LICENSE_GROUP = 'app-m365';
// The Developer Program sells the E5 pack under either part number depending on when the sandbox was created.
const E5_SKUS = ['DEVELOPERPACK_E5', 'DEVELOPERPACK_V2_E5'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = flag('apply');
const PRUNE = flag('prune');
const ROTATE = option('rotate');

/** @returns {string} password meeting Entra complexity rules */
function newPassword() {
  return `${randomBytes(24).toString('base64url')}Aa1!`;
}

const domain = getRegistryValue('Domain');
if (!domain) throw new Error('local/registry.md has no Domain (Phase 1)');
const org = loadOrg(domain);
const entraGroups = org.groups.filter((g) => g.provision_to.includes('entra'));

if (flag('desired')) {
  console.log(JSON.stringify({ personas: org.personas, groups: entraGroups.map((g) => g.name) }, null, 2));
  process.exit(0);
}

const company = getRegistryValue('Company name') || '';
const { tenant, clientId, displayName, verifiedDomains } = await connect();

// Password resets need a directory role for the app (application permissions alone give 403). Check before any
// change, because a rotation writes the new password to the vault first and would leave it out of sync with Entra.
if (ROTATE && APPLY) {
  const roles = (await graphAll(
    `/servicePrincipals(appId='${clientId}')/transitiveMemberOf/microsoft.graph.directoryRole?$select=displayName`,
  )).map((r) => r.displayName);
  const canReset = ['User Administrator', 'Password Administrator', 'Helpdesk Administrator', 'Global Administrator'];
  if (!roles.some((r) => canReset.includes(r))) {
    throw new Error(
      've-provisioning has no directory role that can reset passwords. In the Entra admin center, assign it ' +
      'User Administrator (Roles & admins, scope Directory), then re-run. Nothing was changed.',
    );
  }
}

// Tenant guard: the company domain must be verified in this tenant (scripts/m365/domain.mjs).
if (!verifiedDomains.some((d) => d.name.toLowerCase() === domain.toLowerCase())) {
  throw new Error(`Domain ${domain} is not verified in tenant "${displayName}" (${tenant})`);
}
console.log(`Tenant: ${displayName} (${tenant})  Domain: ${domain}  Mode: ${APPLY ? 'apply' : 'plan'}`);

const plan = [];
/** @param {string} line @param {() => Promise<void>} action */
const step = async (line, action) => {
  plan.push(line);
  console.log(`  ${APPLY ? '+' : '~'} ${line}`);
  if (APPLY) await action();
};

// 1. Groups
const groupIds = new Map();
for (const g of entraGroups) {
  const [existing] = (await graph('GET', `/groups?$filter=displayName eq ${odata(g.name)}&$select=id`)).value;
  if (existing) {
    groupIds.set(g.name, existing.id);
    continue;
  }
  await step(`create group ${g.name}`, async () => {
    const created = await graph('POST', '/groups', {
      displayName: g.name,
      description: (g.description || `${g.type} group`).slice(0, 1024),
      mailEnabled: false,
      mailNickname: g.name,
      securityEnabled: true,
    });
    groupIds.set(g.name, created.id);
  });
}

// 2. Users (password vaulted before creation)
const userIds = new Map();
const userSelect = 'id,userPrincipalName,jobTitle,department,officeLocation,city,country,usageLocation,employeeId,companyName';
for (const p of org.personas) {
  const desired = {
    jobTitle: p.title,
    department: p.department,
    officeLocation: p.siteName,
    city: p.city,
    country: p.country,
    usageLocation: p.country,
    employeeId: p.id,
    companyName: company || undefined,
  };
  const [existing] = (await graph('GET', `/users?$filter=userPrincipalName eq ${odata(p.upn)}&$select=${userSelect}`)).value;
  const vaulted = vault(['get', 'Personas', p.upn]);

  if (!existing) {
    await step(`create user ${p.upn} (${p.key})`, async () => {
      let password = vaulted;
      if (!password) {
        password = newPassword();
        vault(['upsert', 'Personas', p.upn, '--username', p.upn, '--uri', 'https://myapps.microsoft.com', '--password', password,
          '--description', `${p.displayName}, ${p.title} (${p.key}, ${p.id})`]);
      }
      const created = await graph('POST', '/users', {
        accountEnabled: true,
        displayName: p.displayName,
        givenName: p.firstName,
        surname: p.lastName,
        mailNickname: p.mailNickname,
        userPrincipalName: p.upn,
        employeeHireDate: `${p.startDate}T00:00:00Z`,
        passwordProfile: { password, forceChangePasswordNextSignIn: false },
        ...desired,
      });
      userIds.set(p.key, created.id);
    });
    continue;
  }

  userIds.set(p.key, existing.id);
  const drift = Object.fromEntries(Object.entries(desired).filter(([k, v]) => v !== undefined && existing[k] !== v));
  if (Object.keys(drift).length) {
    await step(`update ${p.upn}: ${Object.keys(drift).join(', ')}`, () => graph('PATCH', `/users/${existing.id}`, drift));
  }
  const rotate = ROTATE === 'all' || ROTATE === p.upn;
  if (rotate || !vaulted) {
    if (!rotate) {
      console.log(`  ! ${p.upn} exists but has no vault entry; re-run with --rotate ${p.upn} to reset and vault it`);
      continue;
    }
    await step(`reset password for ${p.upn}`, async () => {
      const password = newPassword();
      vault(['upsert', 'Personas', p.upn, '--username', p.upn, '--uri', 'https://myapps.microsoft.com', '--password', password, '--rotate']);
      await graph('PATCH', `/users/${existing.id}`, { passwordProfile: { password, forceChangePasswordNextSignIn: false } });
    });
  }
}

// 3. Memberships
const personaIds = () => new Set([...userIds.values()]);
for (const g of entraGroups) {
  const desiredMembers = org.personas.filter((p) => p.groups.includes(g.name)).map((p) => p.key);
  const gid = groupIds.get(g.name);
  const current = gid ? new Set((await graphAll(`/groups/${gid}/members?$select=id`)).map((m) => m.id)) : new Set();
  for (const key of desiredMembers) {
    const uid = userIds.get(key);
    if (uid && current.has(uid)) continue;
    await step(`add ${key} to ${g.name}`, () =>
      graph('POST', `/groups/${groupIds.get(g.name)}/members/$ref`,
        { '@odata.id': `${GRAPH}/directoryObjects/${userIds.get(key)}` }, { retry404: true }));
  }
  if (PRUNE && gid) {
    const wanted = new Set(desiredMembers.map((k) => userIds.get(k)));
    const personas = personaIds();
    for (const uid of current) {
      if (personas.has(uid) && !wanted.has(uid)) {
        const key = [...userIds].find(([, id]) => id === uid)[0];
        await step(`remove ${key} from ${g.name}`, () => graph('DELETE', `/groups/${gid}/members/${uid}/$ref`));
      }
    }
  }
}

// 4. Managers
for (const p of org.personas) {
  if (!p.manager) continue;
  const uid = userIds.get(p.key);
  let currentManager = null;
  if (uid) {
    try {
      currentManager = (await graph('GET', `/users/${uid}/manager?$select=id`)).id;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  if (uid && currentManager === userIds.get(p.manager)) continue;
  await step(`set manager of ${p.key} to ${p.manager}`, () =>
    graph('PUT', `/users/${userIds.get(p.key)}/manager/$ref`,
      { '@odata.id': `${GRAPH}/users/${userIds.get(p.manager)}` }, { retry404: true }));
}

// 5. Group-based licensing
const skus = (await graph('GET', '/subscribedSkus')).value;
const e5 = skus.find((s) => E5_SKUS.includes(s.skuPartNumber));
if (!e5) {
  console.log(`  ! No ${E5_SKUS.join(' or ')} subscription found (available: ${skus.map((s) => s.skuPartNumber).join(', ') || 'none'})`);
} else {
  const licensedPersonas = org.personas.filter((p) => p.licensed).length;
  console.log(`  License ${e5.skuPartNumber}:${e5.consumedUnits}/${e5.prepaidUnits.enabled} consumed; ${licensedPersonas} personas need one`);
  const directLicensed = (await graphAll(`/users?$filter=assignedLicenses/any(x:x/skuId eq ${e5.skuId})&$count=true&$select=id,userPrincipalName`))
    .filter((u) => !personaIds().has(u.id));
  if (directLicensed.length && e5.prepaidUnits.enabled - directLicensed.length < licensedPersonas) {
    console.log(`  ! Non-persona users hold E5 licenses (${directLicensed.map((u) => u.userPrincipalName).join(', ')}); ` +
      'remove them to free units for all personas');
  }
  const gid = groupIds.get(LICENSE_GROUP);
  const assigned = gid ? (await graph('GET', `/groups/${gid}?$select=assignedLicenses`)).assignedLicenses : [];
  if (!assigned.some((l) => l.skuId === e5.skuId)) {
    await step(`assign ${e5.skuPartNumber} to ${LICENSE_GROUP}`, () =>
      graph('POST', `/groups/${groupIds.get(LICENSE_GROUP)}/assignLicense`,
        { addLicenses: [{ skuId: e5.skuId, disabledPlans: [] }], removeLicenses: [] }, { retry404: true }));
  }
}

console.log(plan.length ? `${plan.length} change(s) ${APPLY ? 'applied' : 'planned; re-run with --apply'}` : 'No changes: tenant matches the org model');
