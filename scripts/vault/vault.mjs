#!/usr/bin/env node
// Vault adapter: the only interface provisioning scripts use for credentials.
// Wraps go-passbolt-cli (`passbolt`) so the vault provider can change without touching callers.
// Every write is idempotent: existing folders/resources are reused, never duplicated.
//
// Environment:
//   VE_VAULT_CONFIG           go-passbolt-cli config file (default: ~/.config/virtual-enterprise/passbolt.toml)
//   VE_VAULT_PASSPHRASE       passphrase for the automation user's private key, or else
//   VE_VAULT_PASSPHRASE_FILE  file containing it (default: ~/.config/virtual-enterprise/automation.passphrase)
// The passphrase is required for every command except `generate`.
//
// Commands:
//   generate [length]                                   print a random password (no vault access)
//   whoami                                              verify access; print the automation user's username
//   ensure-folder <name> [--share-owner <username>]     create the folder if missing; print its id
//   upsert <folder> <name> [--username U] [--uri U] [--description D]
//          [--password P | --generate [N]] [--rotate]   create the resource if missing; print its id
//                                                      existing resources are left as is unless --rotate
//   get <folder> <name> [--field password|username|uri] print one field (default: password)

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'virtual-enterprise');
const CONFIG = process.env.VE_VAULT_CONFIG || join(CONFIG_DIR, 'passbolt.toml');
const PASSPHRASE_FILE = process.env.VE_VAULT_PASSPHRASE_FILE || join(CONFIG_DIR, 'automation.passphrase');

/** @returns {string} the automation user's passphrase from the environment or the passphrase file */
function readPassphrase() {
  if (process.env.VE_VAULT_PASSPHRASE) return process.env.VE_VAULT_PASSPHRASE;
  if (existsSync(PASSPHRASE_FILE)) return readFileSync(PASSPHRASE_FILE, 'utf8').trim();
  throw new Error(`Set VE_VAULT_PASSPHRASE or create ${PASSPHRASE_FILE}`);
}

/** @returns {string} URL-safe random password of the given length. */
function generatePassword(length = 32) {
  return randomBytes(length).toString('base64url').slice(0, length);
}

const PLAIN_COMMANDS = new Set(['share', 'update']);

/**
 * Run go-passbolt-cli with the project config and the automation passphrase.
 * @param {string[]} args
 * @returns {any} parsed JSON output
 */
function passbolt(args) {
  const passphrase = readPassphrase();
  const out = execFileSync(
    'passbolt',
    // `share` and `update` have no --json flag and print plain text.
    [...args, '--config', CONFIG, '--userPassword', passphrase, '--mfaMode', 'none', ...(PLAIN_COMMANDS.has(args[0]) ? [] : ['--json'])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return !PLAIN_COMMANDS.has(args[0]) && out.trim() ? JSON.parse(out) : null;
}

/**
 * Like passbolt() for list commands: the CLI exits non-zero with "no such ... found" on an empty result.
 * @param {string[]} args
 * @returns {any[]} parsed rows, or [] when nothing matched
 */
function passboltList(args) {
  try {
    return passbolt(args) || [];
  } catch (err) {
    if (/no such .* found/i.test(String(err.stderr || err.message))) return [];
    throw err;
  }
}

/** @param {string} value @returns {string} CEL string literal */
function cel(value) {
  return JSON.stringify(value);
}

/** @param {string} name @returns {{id: string} | undefined} */
function findFolder(name) {
  const folders = passboltList(['list', 'folder', '--filter', `name == ${cel(name)}`]);
  if (folders.length > 1) throw new Error(`More than one folder named "${name}"`);
  return folders[0];
}

/** @param {string} folderId @param {string} name @returns {{id: string} | undefined} */
function findResource(folderId, name) {
  // Restrict columns so listing doesn't decrypt every secret.
  const resources = passboltList([
    'list', 'resource', '--folder', folderId, '--filter', `name == ${cel(name)}`, '-c', 'id', '-c', 'name',
  ]);
  if (resources.length > 1) throw new Error(`More than one resource named "${name}" in the folder`);
  return resources[0];
}

/** @param {string} username @returns {string} user id */
function userId(username) {
  const users = passbolt(['list', 'user', '--filter', `username == ${cel(username)}`]) || [];
  if (users.length !== 1) throw new Error(`User "${username}" not found`);
  return users[0].id;
}

/** @param {string} folderId @param {string} uid @returns {boolean} true if the user already owns the folder */
function isOwner(folderId, uid) {
  const permissions = passbolt(['get', 'folder', 'permission', '--id', folderId]) || [];
  return permissions.some(
    (p) => (p.aro_foreign_key ?? p.AroForeignKey) === uid && Number(p.type ?? p.Type) === 15,
  );
}

/**
 * A resource created through the CLI is owned only by its creator, even inside a shared folder.
 * Share it with every user who owns the folder, so the operator sees it in the UI.
 * @param {string} folderId @param {string} resourceId
 */
function shareWithFolderOwners(folderId, resourceId) {
  const owners = (passbolt(['get', 'folder', 'permission', '--id', folderId]) || [])
    .filter((p) => (p.aro ?? p.Aro) === 'User' && Number(p.type ?? p.Type) === 15)
    .map((p) => p.aro_foreign_key ?? p.AroForeignKey);
  const has = new Set(
    (passbolt(['get', 'resource', 'permission', '--id', resourceId]) || []).map((p) => p.aro_foreign_key ?? p.AroForeignKey),
  );
  for (const uid of owners) {
    if (!has.has(uid)) passbolt(['share', 'resource', '--id', resourceId, '--type', '15', '--user', uid]);
  }
}

/** @param {string[]} argv @returns {{positional: string[], flags: Record<string, string | true>}} */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

/** @param {string} folderName @returns {string} folder id */
function requireFolder(folderName) {
  const folder = findFolder(folderName);
  if (!folder) throw new Error(`Folder "${folderName}" not found (run ensure-folder first)`);
  return folder.id;
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

try {
  switch (command) {
    case 'generate': {
      console.log(generatePassword(Number(positional[0]) || 32));
      break;
    }
    case 'whoami': {
      const users = passbolt(['list', 'user']);
      if (!Array.isArray(users)) throw new Error('Unexpected response');
      console.log(`ok (${users.length} users visible)`);
      break;
    }
    case 'ensure-folder': {
      const [name] = positional;
      if (!name) throw new Error('usage: ensure-folder <name> [--share-owner <username>]');
      let folder = findFolder(name);
      if (!folder) folder = passbolt(['create', 'folder', '--name', name]);
      const id = folder.id;
      if (typeof flags['share-owner'] === 'string') {
        const uid = userId(flags['share-owner']);
        if (!isOwner(id, uid)) passbolt(['share', 'folder', '--id', id, '--type', '15', '--user', uid]);
      }
      console.log(id);
      break;
    }
    case 'upsert': {
      const [folderName, name] = positional;
      if (!folderName || !name) throw new Error('usage: upsert <folder> <name> [options]');
      const folderId = requireFolder(folderName);
      const existing = findResource(folderId, name);
      const password =
        typeof flags.password === 'string'
          ? flags.password
          : flags.generate
            ? generatePassword(Number(flags.generate) || 32)
            : undefined;
      if (existing && !flags.rotate) {
        shareWithFolderOwners(folderId, existing.id);
        console.log(existing.id);
        break;
      }
      const fields = [];
      if (typeof flags.username === 'string') fields.push('--username', flags.username);
      if (typeof flags.uri === 'string') fields.push('--uri', flags.uri);
      if (typeof flags.description === 'string') fields.push('--description', flags.description);
      if (password !== undefined) fields.push('--password', password);
      if (existing) {
        passbolt(['update', 'resource', '--id', existing.id, ...fields]);
        shareWithFolderOwners(folderId, existing.id);
        console.log(existing.id);
      } else {
        const created = passbolt(['create', 'resource', '--name', name, '--folderParentID', folderId, ...fields]);
        shareWithFolderOwners(folderId, created.id);
        console.log(created.id);
      }
      break;
    }
    case 'get': {
      const [folderName, name] = positional;
      if (!folderName || !name) throw new Error('usage: get <folder> <name> [--field password|username|uri]');
      const resource = findResource(requireFolder(folderName), name);
      if (!resource) throw new Error(`Resource "${name}" not found in "${folderName}"`);
      const detail = passbolt(['get', 'resource', '--id', resource.id]);
      const field = typeof flags.field === 'string' ? flags.field : 'password';
      if (!(field in detail)) throw new Error(`Field "${field}" not present`);
      process.stdout.write(String(detail[field]));
      break;
    }
    default:
      throw new Error('usage: vault.mjs <generate|whoami|ensure-folder|upsert|get> ...');
  }
} catch (err) {
  const detail = err.stderr ? String(err.stderr).trim() : err.message;
  console.error(`vault: ${detail}`);
  process.exit(1);
}
