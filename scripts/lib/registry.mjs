#!/usr/bin/env node
// Read and write values in local/registry.md (the gitignored, non-secret deployment registry).
// The registry is a Markdown table: | Key | Value | Renewal / Expiry |
//
// CLI:
//   node scripts/lib/registry.mjs get "<Key>"
//   node scripts/lib/registry.mjs set "<Key>" "<Value>" ["<Renewal>"]   (adds the row if missing)
// Module: import { getRegistryValue, setRegistryValue } from './lib/registry.mjs'

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'local', 'registry.md');

/** @param {string} line @returns {string[] | null} trimmed cells of a table row, or null */
function cells(line) {
  if (!line.startsWith('|')) return null;
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

/**
 * @param {string} key registry key, e.g. "Domain"
 * @returns {string | undefined} value without surrounding backticks; undefined if the row is missing or empty
 */
export function getRegistryValue(key) {
  for (const line of readFileSync(REGISTRY_PATH, 'utf8').split(/\r?\n/)) {
    const row = cells(line);
    if (row && row[0] === key) return row[1].replace(/^`|`$/g, '') || undefined;
  }
  return undefined;
}

/**
 * Set a registry value, adding the row at the end of the table if it doesn't exist.
 * @param {string} key
 * @param {string} value
 * @param {string} [renewal] leaves the existing renewal cell unchanged when omitted
 */
export function setRegistryValue(key, value, renewal) {
  const lines = readFileSync(REGISTRY_PATH, 'utf8').split(/\r?\n/);
  let lastRow = -1;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const row = cells(lines[i]);
    if (!row) continue;
    lastRow = i;
    if (row[0] === key) {
      lines[i] = `| ${key} | ${value} | ${renewal ?? row[2] ?? ''} |`;
      found = true;
    }
  }
  if (!found) lines.splice(lastRow + 1, 0, `| ${key} | ${value} | ${renewal ?? ''} |`);
  writeFileSync(REGISTRY_PATH, lines.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, key, value, renewal] = process.argv.slice(2);
  if (command === 'get' && key) {
    const v = getRegistryValue(key);
    if (v === undefined) process.exit(1);
    console.log(v);
  } else if (command === 'set' && key && value !== undefined) {
    setRegistryValue(key, value, renewal);
    console.log(`set ${key}`);
  } else {
    console.error('usage: registry.mjs get <Key> | set <Key> <Value> [<Renewal>]');
    process.exit(1);
  }
}
