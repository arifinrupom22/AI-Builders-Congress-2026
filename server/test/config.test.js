/**
 * Configuration regression tests.
 *
 * These exist because of a real bug: the numeric parser used to CLAMP an
 * out-of-range value into the allowed range. A shell that exports `PORT=0`
 * (the standard "give me any free port" convention) was therefore clamped up to
 * 1, so the server tried to bind a privileged port, logged that it was
 * listening, and was unreachable on the 8787 that the frontend proxies to.
 *
 * Config is evaluated once at import time and frozen, so each case runs in its
 * own child process. That also proves the values really come from the
 * environment rather than from module-level state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROBE =
  "import('./src/config.js').then((m) => process.stdout.write(JSON.stringify({ port: m.default.port, warnings: m.default.warnings })));";

async function probe(envOverrides) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const { stdout } = await run(process.execPath, ['-e', PROBE], { cwd: SERVER_ROOT, env });
  return JSON.parse(stdout);
}

test('PORT=0 falls back to the documented default instead of binding port 1', async () => {
  const { port, warnings } = await probe({ PORT: '0' });
  assert.equal(port, 8787);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PORT=0/);
  assert.match(warnings[0], /using 8787/);
});

test('an unset PORT uses the documented default and reports nothing', async () => {
  const { port, warnings } = await probe({ PORT: undefined });
  assert.equal(port, 8787);
  assert.deepEqual(warnings, []);
});

test('a valid PORT is honoured exactly', async () => {
  const { port, warnings } = await probe({ PORT: '9001' });
  assert.equal(port, 9001);
  assert.deepEqual(warnings, []);
});

test('a non-numeric PORT falls back and is reported', async () => {
  const { port, warnings } = await probe({ PORT: 'eight-thousand' });
  assert.equal(port, 8787);
  assert.match(warnings[0], /not a number/);
});

test('a PORT above the valid range falls back rather than clamping to 65535', async () => {
  const { port, warnings } = await probe({ PORT: '99999' });
  assert.equal(port, 8787);
  assert.match(warnings[0], /outside 1\.\.65535/);
});

test('other numeric settings fall back on an out-of-range value too', async () => {
  const { stdout } = await run(
    process.execPath,
    [
      '-e',
      "import('./src/config.js').then((m) => process.stdout.write(JSON.stringify({ topK: m.default.retrieval.topK, warnings: m.default.warnings })));",
    ],
    { cwd: SERVER_ROOT, env: { ...process.env, RETRIEVAL_TOP_K: '999' } },
  );
  const { topK, warnings } = JSON.parse(stdout);
  assert.equal(topK, 4, 'RETRIEVAL_TOP_K=999 is rejected, not clamped to 12');
  assert.ok(warnings.some((w) => w.includes('RETRIEVAL_TOP_K')));
});
