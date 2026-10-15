#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const FILE = './server/src/summary/service.js';
let src = readFileSync(FILE, 'utf8');

const seen = new Set();
const out = [];
for (const raw of src.split('\n')) {
  if (raw.trimStart().startsWith('import ')) {
    if (seen.has(raw)) continue;
    seen.add(raw);
  }
  out.push(raw);
}

writeFileSync(FILE, out.join('\n'));
console.log('Deduplicated imports in', FILE);
