#!/usr/bin/env node
// Pull audit and sign-in logs from the environment's SaaS/IdP systems and send them to Splunk HEC.
// Checkpointed per source in local/state/siem-checkpoints.json, so re-runs send only new events (no duplicates).
//
// Usage: node scripts/siem/collect.mjs [--source <name>]... [--since <days>] [--dry-run]
//   --source   limit to entra, authentik, okta, cloudflare (default: every source that's configured)
//   --since    first-run lookback in days when a source has no checkpoint (default 7)
//   --dry-run  fetch and count, send nothing, keep checkpoints unchanged
//
// Sources -> index / sourcetype:
//   entra       idp / ms:aad:signin, ms:aad:audit     (Graph auditLogs; ve-provisioning needs AuditLog.Read.All)
//   authentik   idp / authentik:event                 (vault "authentik: API token")
//   okta        idp / OktaIM2:log                     (vault "Okta API token"; registry "Okta org URL")
//   cloudflare  cloudflare / cloudflare:audit, cloudflare:access
//                                                     (vault "Cloudflare API token: siem-collector"; registry "Cloudflare account ID")
// HEC: registry "Splunk HEC URL" (e.g. https://hec.<domain>), vault "On-prem Splunk: HEC token".

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegistryValue } from '../lib/registry.mjs';
import { connect, graph, vault } from '../m365/graph.mjs';

const STATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'local', 'state', 'siem-checkpoints.json');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const lookbackDays = Number(args.includes('--since') ? args[args.indexOf('--since') + 1] : 7);
const only = args.flatMap((a, i) => (args[i - 1] === '--source' ? [a] : []));

const domain = getRegistryValue('Domain');
const hecUrl = getRegistryValue('Splunk HEC URL')?.replace(/\/$/, '');
const hecToken = vault(['get', 'Service & API', 'On-prem Splunk: HEC token'])?.trim();
if (!hecUrl || !hecToken) throw new Error('Need registry "Splunk HEC URL" and vault "On-prem Splunk: HEC token"');

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const defaultSince = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

/**
 * Keep only events newer than the source's checkpoint (events at the checkpoint instant are deduplicated by id).
 * @param {string} key @param {{id: string, time: string}[]} events
 */
function unseen(key, events) {
  const cp = state[key];
  if (!cp) return events;
  return events.filter((e) => e.time > cp.time || (e.time === cp.time && !cp.ids.includes(e.id)));
}

/** @param {string} key @param {{id: string, time: string}[]} events */
function advance(key, events) {
  if (!events.length) return;
  const latest = events.reduce((m, e) => (e.time > m ? e.time : m), events[0].time);
  const prior = state[key]?.time === latest ? state[key].ids : [];
  state[key] = { time: latest, ids: [...prior, ...events.filter((e) => e.time === latest).map((e) => e.id)] };
}

/**
 * Send events to HEC in batches.
 * @param {{time: string, raw: any}[]} events @param {string} index @param {string} sourcetype @param {string} source
 */
async function send(events, index, sourcetype, source) {
  for (let i = 0; i < events.length; i += 500) {
    const body = events.slice(i, i + 500).map((e) => JSON.stringify({
      time: Date.parse(e.time) / 1000, host: domain, index, sourcetype, source, event: e.raw,
    })).join('\n');
    const res = await fetch(`${hecUrl}/services/collector/event`, {
      method: 'POST', headers: { Authorization: `Splunk ${hecToken}` }, body,
    });
    if (!res.ok) throw new Error(`HEC ${res.status}: ${await res.text()}`);
  }
}

/** @param {string} key @param {string} index @param {string} sourcetype @param {{id: string, time: string, raw: any}[]} all */
async function deliver(key, index, sourcetype, all) {
  const fresh = unseen(key, all);
  console.log(`  ${key}: ${fresh.length} new event(s)${DRY ? ' (dry run)' : ''}`);
  if (DRY || !fresh.length) return;
  await send(fresh, index, sourcetype, key);
  advance(key, fresh);
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

const since = (key) => state[key]?.time ?? defaultSince;

// --- sources -------------------------------------------------------------------------------------------------

const sources = {
  async entra() {
    if (!getRegistryValue('M365 tenant ID')) return 'no M365 tenant ID';
    const { roles } = await connect();
    if (!roles.includes('AuditLog.Read.All')) return 've-provisioning lacks AuditLog.Read.All (add it and grant admin consent)';
    for (const [key, path, timeField, sourcetype] of [
      ['entra:signin', '/auditLogs/signIns', 'createdDateTime', 'ms:aad:signin'],
      ['entra:audit', '/auditLogs/directoryAudits', 'activityDateTime', 'ms:aad:audit'],
    ]) {
      const events = [];
      for (let next = `${path}?$filter=${timeField} ge ${since(key)}&$top=1000`; next; ) {
        const page = await graph('GET', next);
        events.push(...page.value.map((v) => ({ id: v.id, time: v[timeField], raw: v })));
        next = page['@odata.nextLink'];
      }
      await deliver(key, 'idp', sourcetype, events);
    }
    return null;
  },

  async authentik() {
    const token = vault(['get', 'Service & API', 'authentik: API token'])?.trim();
    if (!token) return 'no authentik API token in the vault';
    const key = 'authentik:event';
    const cutoff = since(key);
    const events = [];
    // Newest first; stop paging once past the checkpoint.
    for (let page = 1; ; page++) {
      const res = await fetch(`https://sso.${domain}/api/v3/events/events/?ordering=-created&page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`authentik events: ${res.status}`);
      const json = await res.json();
      const rows = json.results.map((e) => ({ id: e.pk, time: new Date(e.created).toISOString(), raw: e }));
      events.push(...rows.filter((e) => e.time >= cutoff));
      if (!json.pagination?.next || rows.some((e) => e.time < cutoff)) break;
    }
    await deliver(key, 'idp', 'authentik:event', events);
    return null;
  },

  async okta() {
    const orgUrl = getRegistryValue('Okta org URL')?.replace(/\/$/, '');
    const token = vault(['get', 'Service & API', 'Okta API token'])?.trim();
    if (!orgUrl || !token) return 'no Okta org URL or API token';
    const key = 'okta:log';
    const events = [];
    for (let next = `${orgUrl}/api/v1/logs?since=${encodeURIComponent(since(key))}&sortOrder=ASCENDING&limit=1000`; next; ) {
      const res = await fetch(next, { headers: { Authorization: `SSWS ${token}`, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Okta logs: ${res.status}`);
      const rows = await res.json();
      events.push(...rows.map((e) => ({ id: e.uuid, time: e.published, raw: e })));
      // Okta always returns a "next" link for polling; an empty page means caught up.
      next = rows.length ? /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1] : undefined;
    }
    await deliver(key, 'idp', 'OktaIM2:log', events);
    return null;
  },

  async cloudflare() {
    const account = getRegistryValue('Cloudflare account ID');
    const token = vault(['get', 'Service & API', 'Cloudflare API token: siem-collector'])?.trim();
    if (!account || !token) return 'no Cloudflare account ID or siem-collector token';
    const cf = async (path) => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!json.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(json.errors)}`);
      return json;
    };
    const audit = [];
    for (let page = 1; ; page++) {
      const json = await cf(`/audit_logs?since=${encodeURIComponent(since('cloudflare:audit'))}&direction=asc&per_page=1000&page=${page}`);
      audit.push(...json.result.map((e) => ({ id: e.id, time: e.when, raw: e })));
      if (json.result.length < 1000) break;
    }
    await deliver('cloudflare:audit', 'cloudflare', 'cloudflare:audit', audit);

    const access = (await cf(`/access/logs/access_requests?since=${encodeURIComponent(since('cloudflare:access'))}&direction=asc&limit=1000`)).result
      .map((e) => ({ id: e.ray_id || `${e.created_at}:${e.user_email}`, time: e.created_at, raw: e }));
    await deliver('cloudflare:access', 'cloudflare', 'cloudflare:access', access);
    return null;
  },
};

console.log(`HEC: ${hecUrl}  Lookback for new sources: ${lookbackDays} d${DRY ? '  (dry run)' : ''}`);
let failures = 0;
for (const [name, run] of Object.entries(sources)) {
  if (only.length && !only.includes(name)) continue;
  try {
    const skipped = await run();
    if (skipped) console.log(`  ${name}: skipped (${skipped})`);
  } catch (err) {
    failures++;
    console.log(`  ${name}: FAILED ${err.message}`);
  }
}
process.exit(failures ? 1 : 0);
