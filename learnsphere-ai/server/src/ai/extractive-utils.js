/**
 * Re-export of the tokeniser helpers the offline teacher relies on.
 *
 * Kept as its own module so `demoTeacher.js` depends on a stable, small surface
 * and cannot accidentally reach into index-building code.
 */
export { contentTokens, tokenize, sentences as splitSentences, detectLanguage, banglaRatio } from '../retrieval/tokenize.js';
