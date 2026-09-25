// Load the org model (canonical/org/*.yaml) and compute each persona's desired identity and groups.
// Shared by every identity provisioner (M365/Entra, authentik, Okta) so they all agree on membership.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ORG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'canonical', 'org');

/** @param {string} file @returns {any} */
function load(file) {
  return parse(readFileSync(resolve(ORG_DIR, file), 'utf8'));
}

/** @param {string} s @returns {string} lowercase ASCII for UPNs/mail nicknames ("Lindqvist" -> "lindqvist") */
export function asciiSlug(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');
}

/**
 * @typedef {object} Persona
 * @property {string} id            canonical employee ID (E0001)
 * @property {string} key
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} displayName
 * @property {string} upn
 * @property {string} mailNickname
 * @property {string} title
 * @property {string} department    department display name
 * @property {string} departmentKey
 * @property {string} costCenter
 * @property {string} siteName
 * @property {string} city
 * @property {string} country       ISO 3166 alpha-2 (also the M365 usage location)
 * @property {string} region
 * @property {string | null} manager persona key
 * @property {string} startDate     YYYY-MM-DD
 * @property {boolean} licensed
 * @property {string[]} groups      every catalog group the persona belongs to
 */

/**
 * @param {string} domain the company domain, e.g. "example.com"
 * @returns {{ personas: Persona[], groups: any[], departments: any[], sites: any[], subsets: Record<string, string[]> }}
 *   subsets: persona keys per IdP that holds only some personas (e.g. subsets.okta); absent = all personas
 */
export function loadOrg(domain) {
  const { sites } = load('sites.yaml');
  const { departments } = load('departments.yaml');
  const { groups, defaults } = load('groups.yaml');
  const { personas, idp_subsets: subsets = {} } = load('personas.yaml');
  const keys = new Set(personas.map((p) => p.key));
  for (const [idp, members] of Object.entries(subsets)) {
    const unknown = members.filter((k) => !keys.has(k));
    if (unknown.length) throw new Error(`idp_subsets.${idp}: unknown persona keys ${unknown.join(', ')}`);
  }

  const siteByKey = new Map(sites.map((s) => [s.key, s]));
  const deptByKey = new Map(departments.map((d) => [d.key, d]));
  const catalog = groups.map((g) => ({ provision_to: defaults.provision_to, ...g }));
  const catalogNames = new Set(catalog.map((g) => g.name));

  const resolved = personas.map((p) => {
    const site = siteByKey.get(p.site);
    const dept = deptByKey.get(p.department);
    if (!site || !dept) throw new Error(`Persona ${p.key}: unknown site or department`);
    const local = `${asciiSlug(p.first_name)}.${asciiSlug(p.last_name)}`;
    const memberOf = new Set([
      `dept-${dept.key}`,
      `region-${site.region}`,
      ...dept.default_apps.map((a) => `app-${a}`),
      ...(p.licensed ? ['app-m365'] : []),
      ...p.extra_groups,
    ]);
    for (const g of memberOf) if (!catalogNames.has(g)) throw new Error(`Persona ${p.key}: unknown group ${g}`);
    return {
      id: p.id,
      key: p.key,
      firstName: p.first_name,
      lastName: p.last_name,
      displayName: `${p.first_name} ${p.last_name}`,
      upn: `${local}@${domain}`,
      mailNickname: local,
      title: p.title,
      department: dept.name,
      departmentKey: dept.key,
      costCenter: dept.cost_center,
      siteName: site.name,
      city: site.city,
      country: site.country,
      region: site.region,
      manager: p.manager,
      startDate: String(p.start_date instanceof Date ? p.start_date.toISOString().slice(0, 10) : p.start_date),
      licensed: Boolean(p.licensed),
      groups: [...memberOf].sort(),
    };
  });

  return { personas: resolved, groups: catalog, departments, sites, subsets };
}
