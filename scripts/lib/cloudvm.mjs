// Run a command on the cloud site VM over SSH (registry "Cloud VM address", key ~/.config/virtual-enterprise/cloud_ssh),
// in the compose folder /opt/ve/cloud. Secrets travel on stdin, never as arguments.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getRegistryValue } from './registry.mjs';

const SSH_KEY = join(homedir(), '.config', 'virtual-enterprise', 'cloud_ssh');

/**
 * @param {string} command shell command run in /opt/ve/cloud on the VM
 * @param {string} [input] written to the command's stdin
 * @returns {string} stdout
 */
export function onCloudVm(command, input) {
  const target = getRegistryValue('Cloud VM address');
  if (!target) throw new Error('local/registry.md has no "Cloud VM address" (Phase 5a)');
  return execFileSync('ssh', ['-i', SSH_KEY, '-o', 'BatchMode=yes', target, `cd /opt/ve/cloud && ${command}`],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Run Python in `odoo shell` (database "hr") inside the running odoo container.
 * @param {string} python script; must call env.cr.commit() to persist changes
 * @returns {string} stdout
 */
export function odooShell(python) {
  return onCloudVm(
    `docker compose exec -T odoo sh -c 'exec odoo shell -d hr --no-http --db_host "$HOST" --db_user "$USER" --db_password "$PASSWORD"'`,
    python,
  );
}
