#!/usr/bin/env node
// Keep one secret consistent between a gitignored .env file and the vault. Idempotent; never prints the value.
//
// Usage: node scripts/env/secret-env.mjs <env-file> <KEY> <vault-folder> <vault-name>
//          [--username U] [--uri U] [--description D] [--kind password|guid]
//   .env has it, vault doesn't  -> store it in the vault
//   vault has it, .env doesn't  -> write it to .env (e.g. after re-cloning the repo on a new host)
//   neither has it              -> generate (vault first, then .env, so a crash never loses it)
//   both have different values  -> stop with an error; resolve by hand, nothing is overwritten
// --kind: password (default; 32+ chars with upper, lower, digit, symbol: satisfies SQL Server and Splunk rules)
//         guid (e.g. Splunk HEC tokens)

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = resolve(here, '..', 'vault', 'vault.mjs');
const SET_ENV = resolve(here, 'set-env.mjs');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [file, key, folder, name] = args;
if (!file || !key || !folder || !name || key.startsWith('--')) {
  console.error('usage: secret-env.mjs <env-file> <KEY> <vault-folder> <vault-name> [--username U] [--uri U] [--description D] [--kind password|guid]');
  process.exit(1);
}

/** @param {string[]} vaultArgs @returns {string | null} stdout, or null when the resource doesn't exist */
function vault(vaultArgs) {
  try {
    return execFileSync(process.execPath, [VAULT, ...vaultArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (/Resource ".*" not found/.test(String(err.stderr))) return null;
    throw new Error(`vault ${vaultArgs[0]} failed: ${String(err.stderr).trim()}`);
  }
}

/** @returns {string | undefined} the key's current value in the .env file */
function readEnv() {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) || undefined : undefined;
}

/** @param {string} value */
function writeEnv(value) {
  execFileSync(process.execPath, [SET_ENV, file, `${key}=${value}`], { stdio: 'ignore' });
}

/** @param {string} value */
function storeInVault(value) {
  const extra = ['username', 'uri', 'description'].flatMap((f) => (option(f) ? [`--${f}`, option(f)] : []));
  vault(['upsert', folder, name, '--password', value, ...extra]);
}

const generate = () => (option('kind') === 'guid' ? randomUUID() : `${randomBytes(24).toString('base64url')}Aa1!`);

const inEnv = readEnv();
const inVault = vault(['get', folder, name]);

if (inEnv && inVault) {
  if (inEnv !== inVault) {
    console.error(`${key}: .env and vault "${folder}/${name}" differ. Resolve by hand; nothing was changed.`);
    process.exit(1);
  }
  console.log(`kept ${key} (in sync)`);
} else if (inEnv) {
  storeInVault(inEnv);
  console.log(`vaulted ${key}`);
} else if (inVault) {
  writeEnv(inVault);
  console.log(`restored ${key} from vault`);
} else {
  const value = generate();
  storeInVault(value);
  writeEnv(value);
  console.log(`generated ${key}`);
}
