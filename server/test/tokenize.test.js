import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  contentTokens,
  stem,
  detectLanguage,
  banglaRatio,
  normaliseForSearch,
  sentences,
} from '../src/retrieval/tokenize.js';

test('tokenize lowercases, strips punctuation and drops stopwords in contentTokens', () => {
  const tokens = tokenize('Photosynthesis converts Light Energy into glucose!');
  assert.deepEqual(tokens, ['photosynthesis', 'convert', 'light', 'energy', 'into', 'glucose']);
  assert.ok(!contentTokens('What is the photosynthesis of the cell').includes('the'));
  assert.ok(!contentTokens('What is the photosynthesis of the cell').includes('what'));
  assert.ok(contentTokens('What is the photosynthesis of the cell').includes('photosynthesis'));
});

test('stem merges plural and verb forms so a query matches prose', () => {
  assert.equal(stem('organelles'), 'organelle');
  assert.equal(stem('reactions'), 'reaction');
  assert.equal(stem('process'), 'process', 'Latin words ending in -ss must not be truncated to "proces"');
  assert.equal(stem('analysis'), 'analysis', 'words ending in -is must be left alone');
  assert.equal(stem('running'), 'runn');
  assert.equal(stem('studies'), 'study');
  // The point of stemming: singular and plural must collapse to one token.
  assert.equal(stem('organelle'), stem('organelles'));
});

test('normaliseForSearch folds smart quotes and removes zero-width characters', () => {
  const out = normaliseForSearch("Don\u2019t\u200B use\u202E these");
  assert.equal(out, "don't use these");
});

test('Bangla text is tokenised rather than dropped, and detected as Bangla', () => {
  const text = 'সালোকসংশ্লেষণ হলো উদ্ভিদের খাদ্য তৈরির প্রক্রিয়া';
  const tokens = tokenize(text);
  assert.ok(tokens.length >= 4, `expected Bangla tokens, got ${JSON.stringify(tokens)}`);
  assert.ok(tokens.every((t) => t.length > 1));
  assert.equal(detectLanguage(text), 'bn');
  assert.ok(banglaRatio(text) > 0.9);
});

test('sentences splits on Bangla danda as well as Latin stops', () => {
  const parts = sentences('প্রথম বাক্য। দ্বিতীয় বাক্য। Third one. Fourth one?');
  assert.equal(parts.length, 4);
  assert.ok(parts[0].startsWith('প্রথম'));
});

test('detectLanguage treats a mostly-Latin mixed question as English', () => {
  assert.equal(detectLanguage('Explain gradient descent in simple terms'), 'en');
  assert.equal(
    detectLanguage('Gradient descent ব্যাখ্যা কর'),
    'en',
    'a question dominated by English technical terms stays English',
  );
  assert.equal(
    detectLanguage('গ্রেডিয়েন্ট ডিসেন্ট কীভাবে কাজ করে এবং কেন শিখনের হার গুরুত্বপূর্ণ'),
    'bn',
    'a question written mostly in Bangla is answered in Bangla',
  );
});
