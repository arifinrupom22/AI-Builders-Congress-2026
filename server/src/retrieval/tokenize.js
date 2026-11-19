/**
 * Tokeniser.
 *
 * Written by hand rather than pulling in a search library so behaviour is fully
 * inspectable and testable, and so Bangla works out of the box: the token
 * pattern is Unicode-aware, the sentence-aware pipeline treats the Bangla danda
 * (।) as a full stop, and stemming is only applied to Latin script - applying
 * English suffix rules to Bangla would corrupt it.
 */

/**
 * Banglish function words: Bangla written in Latin letters ("ki vabe hoy").
 *
 * Kept as a named list because two features need the same vocabulary: the
 * retrieval stopword filter (below) and question-language detection, which uses
 * it to notice that a Latin-script question is really a Bangla question and
 * should therefore get a Bangla answer.
 */
export const ROMANISED_BANGLA_WORDS = Object.freeze([
  'ki', 'kii', 'kivabe', 'kivhabe', 'kibhabe', 'vabe', 'vhabe', 'bhabe', 'keno', 'kano', 'kemon', 'kotha', 'ktha',
  'mane', 'bolo', 'bolun', 'dao', 'din', 'koro', 'korbo', 'kore', 'kora', 'korte', 'korle',
  'ache', 'aache', 'achhe', 'hoy', 'hoi', 'hobe', 'holo', 'chilo', 'theke', 'jonno', 'jonyo',
  'sathe', 'moddhe', 'upor', 'niche', 'ami', 'amra', 'apni', 'tumi', 'tara', 'nei', 'nai',
  'bujhao', 'bujha', 'bujhte', 'bujhbo', 'likho', 'likhun', 'kothay', 'kothae', 'ktota', 'koto',
  'somporke', 'bisoye', 'proyojon', 'dorkar', 'chai', 'lagbe', 'dekhao', 'dekhaw',
  // Time words. "Ajk nki lockdown chilo?" is Banglish, but it contains only one
  // listed particle, so it used to be classified as English and answered in
  // English.
  'aj', 'ajk', 'ajke', 'ekhon', 'akhon', 'nki', 'khobor', 'notun', 'sorkar', 'prodhanmontri',
].map((word) => word.toLowerCase()));

const ROMANISED_SET = new Set(ROMANISED_BANGLA_WORDS);

/**
 * Romanised Bangla question words. One of these is enough evidence on its own:
 * a short question like "mechatronix ki" is only three words long, so the
 * two-hit rule would miss it. Deliberately excludes words that are ordinary
 * English too ("mane", "kore" in a name), which keeps the detector from
 * hijacking an English sentence.
 */
export const BANGLISH_QUESTION_WORDS = new Set([
  'ki', 'kii', 'kivabe', 'kivhabe', 'kibhabe', 'vabe', 'vhabe', 'bhabe', 'keno', 'kano',
  'kemon', 'kotha', 'ktha', 'kothay', 'kothae', 'koto', 'ktota',
  'bujhao', 'bujha', 'bujhte', 'bujhbo', 'bolo', 'bolun', 'nki',
]);

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
  // Banglish (Bangla written in Latin letters). These are question/function
  // words, not content: leaving them in a query lowers passage coverage and
  // makes an answer the material DOES support look unsupported.
  ...ROMANISED_BANGLA_WORDS,
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

/**
 * How many romanised Bangla function words a Latin-script question needs before
 * it counts as Banglish rather than English. Two hits AND a fifth of the words,
 * so an English sentence that happens to contain a single loanword ("mane" in a
 * quoted phrase) is not misread.
 */
export const BANGLISH_MIN_HITS = 2;
export const BANGLISH_MIN_RATIO = 0.2;

/**
 * Language of a student's question, in three states:
 *   'bn'       - Bangla script (the answer should be Bangla)
 *   'banglish' - Bangla written in Latin letters: "photosynthesis ki vabe hoy"
 *   'en'       - English
 *
 * Banglish is the case that used to fall through the cracks. The letters are
 * Latin, so `detectLanguage` reported English and the tutor replied in English
 * even when the student wrote "Bangla e bujhao".
 */
export function detectQuestionLanguage(text) {
  if (detectLanguage(text) === 'bn') return 'bn';
  const tokens = tokenize(text);
  if (tokens.length === 0) return 'en';
  let hits = 0;
  let distinctive = false;
  for (const token of tokens) {
    if (!ROMANISED_SET.has(token)) continue;
    hits += 1;
    if (BANGLISH_QUESTION_WORDS.has(token)) distinctive = true;
  }
  if (distinctive) return 'banglish';
  return hits >= BANGLISH_MIN_HITS && hits / tokens.length >= BANGLISH_MIN_RATIO ? 'banglish' : 'en';
}

/** Output language for a question: Bangla for Bangla and Banglish, else English. */
export function answerLanguage(text) {
  return detectQuestionLanguage(text) === 'en' ? 'en' : 'bn';
}

export const STOPWORD_LIST = STOPWORDS;

/**
 * Query normalisation for Banglish and spelling variants.
 *
 * This is deliberately a small, inspectable table rather than a transliteration
 * engine. It maps spellings that appear in student queries ("mechatronix",
 * "photosinthesis", American -ize forms in British material, common typos) onto
 * the token the corpus is likely to use. Expansions are added to the query, not
 * substituted: the original wording is untouched, and a passage still has to
 * pass the confidence threshold on its own.
 *
 * Full Bangla<->Latin transliteration is NOT implemented; the README says so.
 */
const QUERY_ALIASES = new Map([
  ['mechatronix', 'mechatronics'],
  ['mechatroniks', 'mechatronics'],
  ['mechatronic', 'mechatronics'],
  ['photosinthesis', 'photosynthesis'],
  ['photosynthasis', 'photosynthesis'],
  ['fotosynthesis', 'photosynthesis'],
  ['defination', 'definition'],
  ['definations', 'definition'],
  ['definaton', 'definition'],
  ['sensores', 'sensors'],
  ['sensor', 'sensor'],
  ['normalization', 'normalisation'],
  ['organization', 'organisation'],
  ['analyze', 'analyse'],
  ['recognize', 'recognise'],
  ['summarize', 'summarise'],
  ['optimize', 'optimise'],
  ['characterize', 'characterise'],
]);

/**
 * Extra search terms for a query. Callers decide whether to use them (the
 * retrieval service only keeps ones that exist in the index).
 */
export function expandQuery(query) {
  const base = new Set(contentTokens(query));
  const out = new Set();
  for (const token of base) {
    const alias = QUERY_ALIASES.get(token);
    if (alias && !base.has(alias)) out.add(alias);
    // British spellings are common in this corpus; normalise American forms.
    if (token.endsWith('ization') && token.length > 12) out.add(`${token.slice(0, -7)}isation`);
    if (token.endsWith('ize') && token.length > 6) out.add(`${token.slice(0, -3)}ise`);
  }
  return [...out];
}

export function queryAliases() {
  return new Map(QUERY_ALIASES);
}
