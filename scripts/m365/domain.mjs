#!/usr/bin/env node
// Manage the company domain in the M365 sandbox through Graph. Every command is idempotent.
// DNS records are printed as JSON for the Cloudflare side (created via the cloudflare MCP server).
//
// Usage: node scripts/m365/domain.mjs <status|add|verify|default>
//   status   JSON: { added, verified, default, records[] }; records are the TXT needed for
//            verification (unverified) or the service records M365 needs (verified)
//   add      add the domain to the tenant if it isn't there
//   verify   verify the domain (after the TXT record resolves)
//   default  make it the tenant's default domain
// Record shape: { type, name, value, priority?, port?, weight?, ttl, service }; name is the FQDN.

import { getRegistryValue } from '../lib/registry.mjs';
import { connect, graph } from './graph.mjs';

const domain = getRegistryValue('Domain');
if (!domain) throw new Error('local/registry.md has no Domain (Phase 1)');
const command = process.argv[2];

/** @param {string} label record label from Graph ("@" or a host, possibly already fully qualified) */
function fqdn(label) {
  if (!label || label === '@' || label.toLowerCase() === domain.toLowerCase()) return domain;
  return label.toLowerCase().endsWith(`.${domain.toLowerCase()}`) ? label : `${label}.${domain}`;
}

/** @param {any} r Graph domainDnsRecord @returns {any} normalized record */
function normalize(r) {
  const base = { name: fqdn(r.label), ttl: r.ttl, service: r.supportedService };
  switch (r.recordType) {
    case 'Txt':
      return { ...base, type: 'TXT', value: r.text };
    case 'Mx':
      return { ...base, type: 'MX', value: r.mailExchange, priority: r.preference };
    case 'CName':
      return { ...base, type: 'CNAME', value: r.canonicalName };
    case 'Srv':
      // Graph sometimes already includes "_service._proto" in the label; don't prefix it twice.
      return {
        ...base,
        type: 'SRV',
        name: fqdn(r.label).startsWith(`${r.service}.`) ? fqdn(r.label) : `${r.service}.${r.protocol}.${fqdn(r.label)}`,
        value: r.nameTarget,
        priority: r.priority,
        weight: r.weight,
        port: r.port,
      };
    default:
      return { ...base, type: r.recordType, value: null };
  }
}

/** @returns {Promise<any | null>} the Graph domain, or null if not added */
async function getDomain() {
  try {
    return await graph('GET', `/domains/${domain}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

const { tenant, displayName } = await connect();
console.error(`Tenant: ${displayName} (${tenant})  Domain: ${domain}`);
let d = await getDomain();

switch (command) {
  case 'status': {
    let records = [];
    if (d && !d.isVerified) records = (await graph('GET', `/domains/${domain}/verificationDnsRecords`)).value;
    if (d && d.isVerified) records = (await graph('GET', `/domains/${domain}/serviceConfigurationRecords`)).value;
    console.log(JSON.stringify({
      added: Boolean(d),
      verified: Boolean(d?.isVerified),
      default: Boolean(d?.isDefault),
      records: records.map(normalize),
    }, null, 2));
    break;
  }
  case 'add':
    if (!d) d = await graph('POST', '/domains', { id: domain });
    // Graph is eventually consistent: `status` can report "not added" for a few seconds after the POST.
    for (let i = 0; i < 10 && !(await getDomain()); i++) await new Promise((r) => setTimeout(r, 2000));
    console.log(`added ${domain}`);
    break;
  case 'verify':
    if (!d) throw new Error('Domain not added; run add first');
    if (!d.isVerified) d = await graph('POST', `/domains/${domain}/verify`);
    console.log(d.isVerified ? `verified ${domain}` : `not verified yet: check the TXT record`);
    if (!d.isVerified) process.exit(1);
    break;
  case 'default':
    if (!d?.isVerified) throw new Error('Domain must be verified first');
    if (!d.isDefault) await graph('PATCH', `/domains/${domain}`, { isDefault: true });
    console.log(`default ${domain}`);
    break;
  default:
    console.error('usage: domain.mjs <status|add|verify|default>');
    process.exit(1);
}
