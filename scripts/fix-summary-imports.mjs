#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const FILE = './server/src/summary/service.js';
let src = readFileSync(FILE, 'utf8');

const wanted = [
  "import { normaliseText, pdfOverviewText } from '../documents/extract.js';",
  "import { docxToText, odtToText, legacyDocToText, rtfToText } from '../documents/office.js';",
  "import { contentTokens, sentences } from '../retrieval/tokenize.js';",
  "import { preparePassages, validateCitations, stripInvalidCitations, findUnsupportedQuotes, clampAnswer, screenPassage } from '../ai/grounding.js';",
  "import { buildSummaryMessages, SUMMARY_LENGTHS, DEFAULT_SUMMARY_LENGTH } from '../ai/prompts.js';",
  "import { extractKeyTerms } from '../ai/keyterms.js';",
];

// Remove every occurrence of any wanted import line anywhere in the file.
for (const line of wanted) {
  let idx;
  while ((idx = src.indexOf(line)) !== -1) {
    const end = src.indexOf('\n', idx + line.length);
    src = src.slice(0, idx) + src.slice(end + 1);
  }
}

// Prepend canonical imports block.
const block = wanted.join('\n') + '\n\n';
src = block + src.trimStart();

writeFileSync(FILE, src);
console.log('Canonicalised imports in', FILE);
