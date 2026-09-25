#!/usr/bin/env node
// RFC 6238 TOTP helpers (HMAC-SHA1, 30-second step, 6 digits) using only node:crypto.
// Each persona has one seed, shared by every IdP (Entra, authentik, Okta), stored in the vault's
// "Personas" folder as resource "TOTP: <upn>" (password = base32 seed).
//
// CLI:
//   node scripts/lib/totp.mjs ensure <upn>   create the persona's seed in the vault if missing ("exists" / "created")
//   node scripts/lib/totp.mjs code <upn>     print the current 6-digit code and seconds left (never the seed)

import { createHmac, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

/** @param {Buffer} bytes @returns {string} RFC 4648 base32 without padding */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** @param {string} text base32, case-insensitive, spaces and padding ignored @returns {Buffer} */
export function base32Decode(text) {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32 character in TOTP seed');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** @returns {string} a new 160-bit seed, base32 */
export function newSeed() {
  return base32Encode(randomBytes(20));
}

/**
 * @param {string} seed base32 seed
 * @param {number} [nowMs] time in milliseconds (defaults to now)
 * @returns {string} 6-digit code
 */
export function totp(seed, nowMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / STEP_SECONDS)));
  const hmac = createHmac('sha1', base32Decode(seed)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** @returns {number} seconds until the current code expires */
export function secondsLeft(nowMs = Date.now()) {
  return STEP_SECONDS - (Math.floor(nowMs / 1000) % STEP_SECONDS);
}

/** @param {string} upn @returns {string} vault resource name of the persona's seed */
export const seedResource = (upn) => `TOTP: ${upn}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { vault } = await import('../m365/graph.mjs');
  const [command, upn] = process.argv.slice(2);
  if (!upn || !['ensure', 'code'].includes(command)) {
    console.error('usage: totp.mjs <ensure|code> <upn>');
    process.exit(1);
  }
  const existing = vault(['get', 'Personas', seedResource(upn)]);
  if (command === 'ensure') {
    if (existing) {
      console.log('exists');
    } else {
      vault(['upsert', 'Personas', seedResource(upn), '--username', upn, '--password', newSeed(),
        '--description', 'TOTP seed (base32, SHA1, 30 s, 6 digits), shared by Entra, authentik, Okta']);
      console.log('created');
    }
  } else {
    if (!existing) throw new Error(`No TOTP seed for ${upn}; run: totp.mjs ensure ${upn}`);
    console.log(`${totp(existing.trim())} (${secondsLeft()} s left)`);
  }
}
