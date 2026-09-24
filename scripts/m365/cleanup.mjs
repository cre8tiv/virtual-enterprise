#!/usr/bin/env node
// Remove objects the org model doesn't manage from the M365 sandbox, e.g. the sample users, groups, and
// Teams of an "instant" developer sandbox, so licenses and names are free for the 25 personas.
// Idempotent: a second run finds nothing. Prints the plan and changes nothing unless --apply is given.
//
// Usage: node scripts/m365/cleanup.mjs [--apply] [--keep <upn>]... [--no-purge]
//   --keep      protect an additional user (repeatable). Always protected: personas (canonical/org),
//               users holding any directory role (e.g. the global admin), and ops@<domain>.
//   --no-purge  leave deleted objects in the recycle bin (restorable for 30 days) instead of
//               permanently deleting them
//
// Groups: deletes Microsoft 365 groups (with their Teams/SharePoint sites) and security groups that aren't
// in canonical/org/groups.yaml, except role-assignable groups. Mail-enabled security and distribution groups
// can't be deleted through Graph; they're reported for the Exchange admin center.

import { getRegistryValue } from '../lib/registry.mjs';
import { loadOrg } from '../lib/org.mjs';
import { connect, graph, graphAll } from './graph.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PURGE = !args.includes('--no-purge');
const keep = new Set(args.flatMap((a, i) => (args[i - 1] === '--keep' ? [a.toLowerCase()] : [])));

const domain = getRegistryValue('Domain');
if (!domain) throw new Error('local/registry.md has no Domain (Phase 1)');
const org = loadOrg(domain);
const { tenant, displayName } = await connect();
console.log(`Tenant: ${displayName} (${tenant})  Mode: ${APPLY ? 'apply' : 'plan'}${PURGE ? '' : '  (no purge)'}`);

keep.add(`ops@${domain}`.toLowerCase());
const personaUpns = new Set(org.personas.map((p) => p.upn.toLowerCase()));
const personaIds = new Set(org.personas.map((p) => p.id));
const catalog = new Set(org.groups.map((g) => g.name));

// Principals with any directory role assignment (global admin, etc.) are never touched.
const rolePrincipals = new Set(
  (await graphAll('/roleManagement/directory/roleAssignments?$select=principalId')).map((a) => a.principalId),
);

const users = await graphAll('/users?$select=id,displayName,userPrincipalName,mail,employeeId,userType&$top=999');
const doomedUsers = users.filter((u) => {
  const upn = u.userPrincipalName.toLowerCase();
  const mail = (u.mail || '').toLowerCase();
  return !(
    personaUpns.has(upn) ||
    personaIds.has(u.employeeId) ||
    rolePrincipals.has(u.id) ||
    keep.has(upn) ||
    keep.has(mail)
  );
});

const groups = await graphAll('/groups?$select=id,displayName,groupTypes,mailEnabled,securityEnabled,isAssignableToRole&$top=999');
const nonCatalog = groups.filter((g) => !catalog.has(g.displayName) && !g.isAssignableToRole);
const isUnified = (g) => g.groupTypes.includes('Unified');
const doomedGroups = nonCatalog.filter((g) => isUnified(g) || (g.securityEnabled && !g.mailEnabled));
const exchangeGroups = nonCatalog.filter((g) => !doomedGroups.includes(g));

const protectedUsers = users.filter((u) => rolePrincipals.has(u.id));
console.log(`  Protected (directory roles): ${protectedUsers.map((u) => u.userPrincipalName).join(', ') || 'none'}`);
for (const u of doomedUsers) console.log(`  ${APPLY ? '-' : '~'} delete user ${u.displayName} <${u.userPrincipalName}>${u.userType === 'Guest' ? ' (guest)' : ''}`);
for (const g of doomedGroups) console.log(`  ${APPLY ? '-' : '~'} delete group ${g.displayName} (${isUnified(g) ? 'Microsoft 365 group, with its Team/site' : 'security group'})`);
for (const g of exchangeGroups) console.log(`  ! mail-enabled group "${g.displayName}": delete it in the Exchange admin center`);

const total = doomedUsers.length + doomedGroups.length;
if (!APPLY) {
  console.log(total ? `${total} deletion(s) planned; re-run with --apply` : 'Nothing to clean up');
  process.exit(0);
}

const deleted = [];
for (const u of doomedUsers) {
  await graph('DELETE', `/users/${u.id}`);
  deleted.push(u);
}
for (const g of doomedGroups) {
  await graph('DELETE', `/groups/${g.id}`);
  deleted.push(g);
}

if (PURGE) {
  let purgeDenied = false;
  for (const obj of deleted) {
    try {
      await graph('DELETE', `/directory/deletedItems/${obj.id}`, undefined, { retry404: true });
    } catch (err) {
      if (err.status !== 403) throw err;
      purgeDenied = true;
    }
  }
  if (purgeDenied) {
    console.log('  ! Permanent delete was denied for some objects. Grant ve-provisioning User.DeleteRestore.All ' +
      '(application, admin consent) and re-run, or let the recycle bin expire them in 30 days. Licenses are already freed.');
  }
}
console.log(`${total} object(s) deleted${PURGE ? ' and purged' : ''}. Review SharePoint admin center → Active sites for leftover sample sites.`);
