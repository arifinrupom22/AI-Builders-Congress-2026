/**
 * Tokeniser.
 *
 * Written by hand rather than pulling in a search library so behaviour is fully
 * inspectable and testable, and so Bangla works out of the box: the token
 * pattern is Unicode-aware, the sentence-aware pipeline treats the Bangla danda
 * (।) as a full stop, and stemming is only applied to Latin script - applying
 * English suffix rules to Bangla would corrupt it.
 */

/** Function words carry no retrieval signal. English + common Bangla particles. */
const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'because', 'as', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'with', 'about', 'into', 'over', 'after', 'before', 'between', 'during', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'will', 'would',
  'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'you', 'he', 'she', 'we', 'they', 'them', 'his', 'her', 'their', 'our', 'your', 'my', 'me', 'us', 'what', 'which',
  'who', 'whom', 'when', 'where', 'why', 'how', 'there', 'here', 'not', 'no', 'nor', 'only', 'also', 'very', 'more',
  'most', 'some', 'any', 'all', 'each', 'both', 'from', 'up', 'down', 'out', 'off', 'again', 'further', 'once',
  'please', 'explain', 'tell', 'show', 'give', 'about', 'define', 'mean', 'means', 'does', 'difference',
  // Bangla
  'এবং', 'বা', 'কিন্তু', 'যদি', 'তাহলে', 'যে', 'এই', 'সেই', 'একটি', 'একটা', 'হলো', 'হল', 'হয়', 'হবে', 'কি', 'কী',
  'কে', 'কেন', 'কিভাবে', 'কীভাবে', 'কোন', 'কোনটি', 'থেকে', 'জন্য', 'সাথে', 'মধ্যে', 'উপর', 'নিচে', 'আর', 'তার', 'আমি', 'আমরা',
  'আপনি', 'তুমি', 'সে', 'তারা', 'নয়', 'না', 'ব্যাখ্যা', 'কর', 'করা', 'করো', 'দাও', 'বলো',
  'এটি', 'সেটি', 'ওটি', 'করে', 'করি', 'দিয়ে', 'হচ্ছে', 'হয়েছে', 'কেমন', 'কতটা',
]);

// \p{M} (combining marks) must be included or Brahmic scripts fall apart:
// the vowel signs in "ফিটিং" are marks, not letters, so \p{L} alone would split
// the word into fragments and Bangla retrieval would silently degrade.
const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;
const LATIN_RE = /^[a-z0-9]+$/;

export function normaliseForSearch(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

/**
 * Bangla inflectional suffixes, longest first.
 *
 * Bangla is agglutinative: the notes say "শক্তিকে" while a student writes
 * "শক্তিতে", and "সালোকসংশ্লেষণ" also appears as "সালোকসংশ্লেষণে". Without
 * stripping these endings the two forms look like unrelated words, which made a
 * Bangla question whose answer IS in the notes score zero and get refused. A
 * remainder of at least three characters is required so short words survive.
 */
// LONGEST FIRST. Order is load-bearing: "শক্তিকে" must lose "কে" and not the
// single "ে", otherwise it stems to "শক্তিক" and matches nothing.
const BANGLA_SUFFIXES = [
  'গুলোর', 'গুলির', 'দেরকে', 'গুলো', 'গুলি', 'দের', 'টার', 'টির',
  'ের', 'কে', 'তে', 'য়ে', 'টি', 'টা', 'ে', 'র', 'য়',
];

export function stemBangla(token) {
  for (const suffix of BANGLA_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length);
  }
  return token;
}

/**
 * Conservative English suffix stemmer, Latin-only by design.
 *
 * Order matters and is deliberate (a simplified Porter step 1a): plural rules
 * run before the -ing/-ed rules, and words ending in -ss/-us/-is are never
 * truncated. That is what stops "process" becoming "proces" and keeps
 * "organelle"/"organelles" collapsing to the SAME token, which is the whole
 * point of stemming in a search index.
 */
export function stem(token) {
  // Latin gets English rules; anything else (Bangla, Devanagari, ...) gets the
  // script-appropriate treatment rather than English suffix stripping.
  if (!LATIN_RE.test(token)) return stemBangla(token);
  if (token.length < 5) return token;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  for (const suffix of ['ingly', 'edly', 'ing', 'ed', 'ly']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  }
  return token;
}

export function tokenize(text) {
  const matches = normaliseForSearch(text).match(TOKEN_RE);
  if (!matches) return [];
  // A token made only of combining marks (or a single mark) is noise, and a
  // single Latin letter is too. A single Bangla letter, however, is a real word
  // ("ক" is not, but "ন" appears in contractions), so length is judged without
  // counting marks.
  return matches.map(stem).filter((token) => {
    const baseLength = token.replace(/\p{M}/gu, '').length;
    if (baseLength === 0) return false;
    const isLatin = LATIN_RE.test(token);
    if (isLatin) return token.length > 1 && token.length < 40;
    return token.length < 40;
  });
}

/**
 * Stopwords are matched against STEMMED tokens, so the list has to be stemmed
 * too. Otherwise a Bangla stopword like "কীভাবে" is stored raw while the
 * tokeniser produces "কীভাব", the filter misses, and a question word is treated
 * as a meaningful content term. Built lazily because `stem` depends on
 * constants that are declared after the raw list.
 */
let stemmedStopwords = null;
function stopwordSet() {
  if (stemmedStopwords === null) stemmedStopwords = new Set([...STOPWORDS].map((word) => stem(word)));
  return stemmedStopwords;
}

/** Query terms with stopwords removed - the terms that decide relevance. */
export function contentTokens(text) {
  const stop = stopwordSet();
  return tokenize(text).filter((token) => !stop.has(token));
}

export function isStopword(token) {
  return stopwordSet().has(token);
}

/** Sentence split that also honours the Bangla danda. */
export function sentences(text) {
  return String(text)
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Ratio of Bangla-script letters. Lets the tutor answer in the language the
 * student asked in, which is a stated goal of the AIBC 2026 brief.
 */
export function banglaRatio(text) {
  const letters = String(text).match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  const bangla = letters.filter((ch) => /[\u0980-\u09FF]/.test(ch)).length;
  return bangla / letters.length;
}

/**
 * A question must be substantially in Bangla before the tutor switches
 * language. Mixed questions like "explain gradient descent ব্যাখ্যা কর" are
 * treated as English (the technical terms are English), while a question mostly
 * written in Bangla gets a Bangla answer.
 */
export const BANGLA_ANSWER_THRESHOLD = 0.4;

export function detectLanguage(text) {
  return banglaRatio(text) >= BANGLA_ANSWER_THRESHOLD ? 'bn' : 'en';
}

export const STOPWORD_LIST = STOPWORDS;
