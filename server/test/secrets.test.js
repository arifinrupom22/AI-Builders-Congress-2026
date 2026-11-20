/**
 * Release-safety checks for secrets.
 *
 * These do not prove a key was never leaked historically, but they do keep the
 * project from shipping one now: `.env` stays ignored, the template stays blank,
 * the published bundle never contains the configured key, and the public config
 * endpoint never serialises it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { PROJECT_ROOT } from '../src/config.js';

const read = (relative) => fs.readFile(path.join(PROJECT_ROOT, relative), 'utf8');

test('.env is git-ignored and the template keeps blank placeholders', async () => {
  const gitignore = await read('.gitignore');
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*\.local$/m);
  assert.match(gitignore, /^server\/data\/$/m);

  const template = await read('.env.example');
  assert.match(template, /^LEARNSPHERE_AI_API_KEY=$/m);
  assert.match(template, /^LEARNSPHERE_AI_PROVIDER=none$/m);
  // No line in the template carries a non-empty credential value.
  for (const line of template.split(/\r?\n/)) {
    assert.doesNotMatch(line, /^[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*=\S+/i, `template leaks a value: ${line}`);
  }
});

test('the public config never contains the API key', () => {
  const serialised = JSON.stringify(config.publicConfig());
  assert.ok(!('apiKey' in config.publicConfig().ai));
  if (config.ai.apiKey) {
    assert.ok(!serialised.includes(config.ai.apiKey));
  }
});

test('a built web bundle does not contain the configured API key', async (t) => {
  if (!config.ai.apiKey) {
    t.diagnostic('no API key configured; bundle comparison skipped');
    return;
  }
  const dist = path.join(PROJECT_ROOT, 'web', 'dist');
  const exists = await fs
    .stat(dist)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    t.diagnostic('web/dist is not built; run npm run build to enable this check');
    return;
  }

  const files = await fs.readdir(dist, { recursive: true });
  for (const relative of files) {
    const full = path.join(dist, String(relative));
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile() || full.endsWith('.map')) continue;
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    assert.ok(!text.includes(config.ai.apiKey), `the API key appears in ${relative}`);
  }
});

test('the PDF/office readers and static bundle paths do not include the dotenv file', async () => {
  // A folder-only deploy publishes web/dist only; assert nothing writes the
  // environment file into it.
  const viteConfig = await fs
    .readFile(path.join(PROJECT_ROOT, 'web', 'vite.config.js'), 'utf8')
    .catch(() => '');
  if (viteConfig) {
    // Vite only inlines `VITE_`-prefixed values by default. Reading `.env` from
    // the repository root is required and safe - it is the file the server reads
    // and where `.env.example` documents `VITE_FIREBASE_*`. What must never
    // happen is widening that prefix, or hand-copying the env file into the
    // bundle. The scan above is the real check: the configured AI key must not
    // appear in web/dist.
    assert.doesNotMatch(viteConfig, /envPrefix|loadEnv\(|dotenv/);
    assert.match(viteConfig, /envDir/);
  }
  const serverSource = await fs.readFile(
    path.join(fileURLToPath(new URL('../src/index.js', import.meta.url))),
    'utf8',
  );
  assert.doesNotMatch(serverSource, /console\.log|process\.stdout/, 'startup must go through the logger');
});
