#!/usr/bin/env node
/** Fix the misplaced imports at the end of service.js. */
import { readFileSync, writeFileSync } from 'node:fs';

const path = './server/src/summary/service.js';
let src = readFileSync(path, 'utf8');

const misplaced = `import { pdfOverviewText } from '../documents/extract.js';
import { docxToText, odtToText, legacyDocToText, rtfToText } from '../documents/office.js';`;

const topImports = `import { pdfOverviewText } from '../documents/extract.js';
import { docxToText, odtToText, legacyDocToText, rtfToText } from '../documents/office.js';`;

if (!src.includes(misplaced)) {
  console.log('Misplaced imports not found; nothing to do.');
  process.exit(0);
}

// Remove the misplaced block at the end
src = src.replace(misplaced, '');

// Insert at the top, after the first line (the file starts with `/**`)
const firstNewline = src.indexOf('\n');
const top = src.slice(0, firstNewline + 1);
const rest = src.slice(firstNewline + 1);
src = top + topImports + '\n' + rest;

writeFileSync(path, src);
console.log('Patched imports in', path);
