#!/usr/bin/env node
// Idempotently set keys in a gitignored .env file.
// Creates the file from the sibling .env.example if it doesn't exist; only the given keys change.
//
// Usage: node scripts/env/set-env.mjs <path/to/.env> KEY=VALUE [KEY=VALUE ...] [--if-empty]
//   --if-empty  set a key only when it is missing or empty (never overwrite an existing value)
// Prints "set KEY" or "kept KEY" per key. Values are never printed.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const ifEmpty = args.includes('--if-empty');
const [file, ...pairs] = args.filter((a) => a !== '--if-empty');

if (!file || pairs.length === 0 || pairs.some((p) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(p))) {
  console.error('usage: set-env.mjs <path/to/.env> KEY=VALUE [KEY=VALUE ...] [--if-empty]');
  process.exit(1);
}

if (!existsSync(file)) {
  const example = join(dirname(file), '.env.example');
  if (existsSync(example)) copyFileSync(example, file);
  else writeFileSync(file, '');
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
if (lines.at(-1) === '') lines.pop();

for (const pair of pairs) {
  const eq = pair.indexOf('=');
  const key = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const current = index >= 0 ? lines[index].slice(key.length + 1) : undefined;
  if (ifEmpty && current) {
    console.log(`kept ${key}`);
    continue;
  }
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  console.log(`set ${key}`);
}

writeFileSync(file, `${lines.join('\n')}\n`);
