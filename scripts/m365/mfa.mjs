#!/usr/bin/env node
// Enforce MFA in the M365 sandbox with vault-held TOTP seeds, so persona sign-ins are MFA-protected yet
// automatable. Idempotent: prints a plan and changes nothing unless --apply is given.
//
//   1. Enable the Hardware OATH authentication method for all users.
//   2. Per persona: ensure the TOTP seed in the vault ("Personas" / "TOTP: <upn>"), then a hardware OATH
//      token (serial VE-<employee ID>) carrying that seed, assigned to the user and activated with a code
//      computed from the seed. (Graph beta / preview API.)
//   3. Conditional Access: "VE - Require MFA for all users" and "VE - Block legacy authentication", both
//      excluding Global Administrators (the break-glass admin). Created disabled, then security defaults are
//      turned off and the policies enabled, but only once every persona has an activated token.
//
// Usage: node scripts/m365/mfa.mjs [--apply] [--rotate <upn|all>]
//   --rotate  replace the persona's seed and token (new seed in the vault, old token deleted)
// Requires these application permissions on ve-provisioning (checked first):
//   Policy.ReadWrite.AuthenticationMethod, UserAuthenticationMethod.ReadWrite.All,
//   Policy.ReadWrite.ConditionalAccess, Policy.Read.All, Application.Read.All

import { getRegistryValue } from '../lib/registry.mjs';
import { loadOrg } from '../lib/org.mjs';
import { newSeed, seedResource, secondsLeft, totp } from '../lib/totp.mjs';
import { connect, graph, graphAll, odata, vault } from './graph.mjs';

const BETA = 'https://graph.microsoft.com/beta';
const GLOBAL_ADMIN_ROLE = '62e90394-69f5-4237-9190-012177145e10';
const REQUIRED = [
  'Policy.ReadWrite.AuthenticationMethod',
  'UserAuthenticationMethod.ReadWrite.All',
  'Policy.ReadWrite.ConditionalAccess',
  'Policy.Read.All',
  'Application.Read.All',
];
const POLICY_MFA = 'VE - Require MFA for all users';
const POLICY_LEGACY = 'VE - Block legacy authentication';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const rotateArg = args.includes('--rotate') ? args[args.indexOf('--rotate') + 1] : undefined;

const domain = getRegistryValue('Domain');
if (!domain) throw new Error('local/registry.md has no Domain (Phase 1)');
const org = loadOrg(domain);
const { tenant, displayName, roles } = await connect();

const missing = REQUIRED.filter((r) => !roles.includes(r));
if (missing.length) {
  throw new Error(`ve-provisioning lacks application permissions: ${missing.join(', ')}. ` +
    'Add them in Entra (API permissions → Microsoft Graph → Application), grant admin consent, and re-run.');
}
console.log(`Tenant: ${displayName} (${tenant})  Mode: ${APPLY ? 'apply' : 'plan'}`);

let changes = 0;
/** @param {string} line @param {() => Promise<void>} action */
const step = async (line, action) => {
  changes++;
  console.log(`  ${APPLY ? '+' : '~'} ${line}`);
  if (APPLY) await action();
};

/** Wait for a fresh code window so activation doesn't race the 30-second boundary. */
async function freshCode(seed) {
  if (secondsLeft() < 5) await new Promise((r) => setTimeout(r, secondsLeft() * 1000 + 500));
  return totp(seed);
}

// 1. Authentication method policy: Hardware OATH enabled for all users
const oathConfigPath = `${BETA}/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/HardwareOath`;
const oathConfig = await graph('GET', oathConfigPath);
if (oathConfig.state !== 'enabled') {
  await step('enable the Hardware OATH authentication method for all users', () =>
    graph('PATCH', oathConfigPath, {
      '@odata.type': '#microsoft.graph.hardwareOathAuthenticationMethodConfiguration',
      state: 'enabled',
      includeTargets: [{ targetType: 'group', id: 'all_users', isRegistrationRequired: false }],
    }));
}

// 2. Seeds and tokens
const devices = await graphAll(`${BETA}/directory/authenticationMethodDevices/hardwareOathDevices?$select=id,serialNumber,status,assignedTo`);
let allActivated = true;
for (const p of org.personas) {
  const [user] = (await graph('GET', `/users?$filter=userPrincipalName eq ${odata(p.upn)}&$select=id`)).value;
  if (!user) {
    console.log(`  ! ${p.upn} doesn't exist yet; run scripts/m365/provision.mjs first`);
    allActivated = false;
    continue;
  }
  const serial = `VE-${p.id}`;
  const rotate = rotateArg === 'all' || rotateArg === p.upn;
  let device = devices.find((d) => d.serialNumber === serial);
  let seed = vault(['get', 'Personas', seedResource(p.upn)])?.trim();

  if (rotate && seed) {
    await step(`rotate TOTP seed and token for ${p.upn}`, async () => {
      if (device) await graph('DELETE', `${BETA}/directory/authenticationMethodDevices/hardwareOathDevices/${device.id}`);
      seed = newSeed();
      vault(['upsert', 'Personas', seedResource(p.upn), '--password', seed, '--rotate']);
      device = undefined;
    });
    if (!APPLY) continue;
  }
  if (!seed) {
    // A token without its seed in the vault is unusable for tests; replace it.
    await step(`create TOTP seed for ${p.upn}${device ? ' (replacing its unvaulted token)' : ''}`, async () => {
      if (device) await graph('DELETE', `${BETA}/directory/authenticationMethodDevices/hardwareOathDevices/${device.id}`);
      seed = newSeed();
      vault(['upsert', 'Personas', seedResource(p.upn), '--username', p.upn, '--password', seed,
        '--description', 'TOTP seed (base32, SHA1, 30 s, 6 digits), shared by Entra, authentik, Okta']);
      device = undefined;
    });
    if (!APPLY) {
      allActivated = false;
      continue;
    }
  }
  if (device?.status === 'activated' && device.assignedTo?.id === user.id) continue;

  allActivated = false;
  await step(`${device ? 'assign/activate' : 'create, assign, and activate'} token ${serial} for ${p.upn}`, async () => {
    if (!device) {
      device = await graph('POST', `${BETA}/directory/authenticationMethodDevices/hardwareOathDevices`, {
        serialNumber: serial,
        manufacturer: 'VirtualEnterprise',
        model: 'Vault TOTP',
        displayName: `${p.displayName} (vault)`,
        secretKey: seed,
        timeIntervalInSeconds: 30,
        hashFunction: 'hmacsha1',
        assignTo: { id: user.id },
      });
    } else if (device.assignedTo?.id !== user.id) {
      await graph('POST', `${BETA}/users/${user.id}/authentication/hardwareOathMethods`, { device: { id: device.id } });
    }
    await graph('POST', `${BETA}/users/${user.id}/authentication/hardwareOathMethods/${device.id}/activate`,
      { verificationCode: await freshCode(seed) }, { retry404: true });
  });
}
if (APPLY) {
  // Re-read so the Conditional Access gate reflects what was just activated.
  const now = await graphAll(`${BETA}/directory/authenticationMethodDevices/hardwareOathDevices?$select=serialNumber,status`);
  allActivated = org.personas.every((p) => now.some((d) => d.serialNumber === `VE-${p.id}` && d.status === 'activated'));
}

// 3. Conditional Access (enforcement only when every persona can satisfy MFA)
const breakGlass = (await graphAll(`/roleManagement/directory/roleAssignments?$filter=roleDefinitionId eq '${GLOBAL_ADMIN_ROLE}'&$select=principalId`))
  .map((a) => a.principalId);
if (breakGlass.length === 0) {
  throw new Error('No active Global Administrator assignment found to exclude as break-glass; refusing to touch Conditional Access.');
}
const existing = await graphAll('/identity/conditionalAccess/policies?$select=id,displayName,state');
const desiredPolicies = [
  {
    displayName: POLICY_MFA,
    conditions: {
      users: { includeUsers: ['All'], excludeUsers: breakGlass },
      applications: { includeApplications: ['All'] },
      clientAppTypes: ['all'],
    },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
  },
  {
    displayName: POLICY_LEGACY,
    conditions: {
      users: { includeUsers: ['All'], excludeUsers: breakGlass },
      applications: { includeApplications: ['All'] },
      clientAppTypes: ['exchangeActiveSync', 'other'],
    },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  },
];
const policyIds = new Map(existing.map((p) => [p.displayName, p]));
for (const policy of desiredPolicies) {
  if (policyIds.has(policy.displayName)) continue;
  await step(`create Conditional Access policy "${policy.displayName}" (disabled)`, async () => {
    const created = await graph('POST', '/identity/conditionalAccess/policies', { ...policy, state: 'disabled' });
    policyIds.set(policy.displayName, created);
  });
}

const securityDefaults = await graph('GET', '/policies/identitySecurityDefaultsEnforcementPolicy');
const needsEnforcement = securityDefaults.isEnabled ||
  desiredPolicies.some((p) => policyIds.get(p.displayName)?.state !== 'enabled');
if (needsEnforcement && !allActivated) {
  console.log('  ! Conditional Access stays off until every persona has an activated token (re-run after tokens activate)');
} else if (needsEnforcement) {
  if (securityDefaults.isEnabled) {
    await step('turn off security defaults (replaced by the VE Conditional Access policies)', () =>
      graph('PATCH', '/policies/identitySecurityDefaultsEnforcementPolicy', { isEnabled: false }));
  }
  for (const policy of desiredPolicies) {
    if (policyIds.get(policy.displayName)?.state === 'enabled') continue;
    await step(`enable "${policy.displayName}"`, () =>
      graph('PATCH', `/identity/conditionalAccess/policies/${policyIds.get(policy.displayName).id}`, { state: 'enabled' }));
  }
}
console.log(`  Break-glass exclusions (Global Administrators): ${breakGlass.length}`);
console.log(changes ? `${changes} change(s) ${APPLY ? 'applied' : 'planned; re-run with --apply'}` : 'No changes: MFA matches the policy');
