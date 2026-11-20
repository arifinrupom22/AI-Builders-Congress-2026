/**
 * Identity guard for the AI Teacher.
 *
 * The deployed models are general-purpose products, and when a student asks
 * "who are you?" they often answer from their own system identity instead of
 * the tutor persona: "I am ChatGPT, an AI language model made by OpenAI",
 * "As an AI language model, I cannot ...". A hackathon judge asking that
 * question must be answered by LearnSphere AI, not by the upstream vendor.
 *
 * Prompt instructions reduce this but cannot eliminate it - small models drop
 * the persona when the message is unusual - so the answer is also checked after
 * generation and rewritten here. Only *self-identification* is touched:
 * a genuine study answer that mentions GPT-4 or OpenAI as a topic (for example
 * "OpenAI released GPT-4 in 2023") is left exactly as written.
 */

/** The one-line identity the tutor is allowed to state, per answer language. */
export const IDENTITY_LINE = {
  en:
    "I'm the LearnSphere AI teacher, built into this app to explain your own study material with citations and to answer anything outside it from general knowledge.",
  bn:
    '\u0986\u09ae\u09bf LearnSphere AI-\u098f\u09b0 AI \u09b6\u09bf\u0995\u09cd\u09b7\u0995\u0964 \u09a4\u09cb\u09ae\u09be\u09b0 \u0986\u09aa\u09b2\u09cb\u09a1 \u0995\u09b0\u09be \u09a8\u09cb\u099f \u09a5\u09c7\u0995\u09c7 \u09b8\u09be\u0987\u099f\u09c7\u09b6\u09a8 \u09b8\u09b9 \u09ac\u09c1\u099d\u09bf\u09af\u09bc\u09c7 \u09a6\u09bf\u0987, \u0986\u09b0 \u09a8\u09cb\u099f\u09c7 \u09a8\u09be \u09a5\u09be\u0995\u09b2\u09c7 \u09b8\u09be\u09a7\u09be\u09b0\u09a3 \u099c\u09cd\u099e\u09be\u09a8 \u09a5\u09c7\u0995\u09c7 \u0989\u09a4\u09cd\u09a4\u09b0 \u09a6\u09bf\u0987\u0964',
};

/**
 * Sentences where the model claims to *be* another product.
 *
 * Every pattern is anchored on a first-person self-claim ("I am", "I was
 * trained by", "my developers"), which is what separates a mistaken identity
 * from a legitimate question about a model. They stop at sentence punctuation
 * so only the offending sentence is rewritten.
 */
const SELF_IDENTITY_PATTERNS = [
  // "As an AI language model, ..." / "As a large language model I ..."
  /\bas an? (?:ai |large )?language model\b[^.!?\n]*[.!?]?/gi,
  // "I am a language model" / "I'm just an AI assistant"
  /\bI(?:'m|\u2019m| am)\s+(?:just\s+|only\s+)?(?:an?\s+)?(?:AI\s+)?(?:large\s+)?(?:language\s+model|chatbot|virtual assistant|AI assistant)\b[^.!?\n]*[.!?]?/gi,
  // "I am ChatGPT" / "I'm GPT-4" / "I am Claude"
  /\bI(?:'m|\u2019m| am)\s+(?:chatgpt|gpt-?\d[\w.]*|openai|claude|gemini|bard|copilot|llama|an?\s+(?:ai\s+)?(?:model|assistant)\s+(?:made|created|built|developed|trained)\s+by\s+[\w .]+)[^.!?\n]*[.!?]?/gi,
  // "I was trained by OpenAI" / "I was created by Anthropic"
  /\bI\s+(?:was|have been)\s+(?:created|developed|built|trained|made|designed)\s+by\s+(?:the\s+)?(?:OpenAI|Google|Google DeepMind|Anthropic|Meta|Microsoft|Mistral)\b[^.!?\n]*[.!?]?/gi,
  // "OpenAI trained me" / "Anthropic made me"
  /\b(?:OpenAI|Google|Google DeepMind|Anthropic|Meta|Microsoft|Mistral)\s+(?:created|developed|built|trained|made|designed)\s+me\b[^.!?\n]*[.!?]?/gi,
  // "My creators at OpenAI" / "my developers are OpenAI"
  /\bmy\s+(?:creator|creators|developer|developers|maker|makers)\s+(?:is|are|work|works)?\s*(?:at\s+)?(?:OpenAI|Google|Anthropic|Meta|Microsoft|Mistral)\b[^.!?\n]*[.!?]?/gi,
  // "I don't have a name, I'm an AI" style openers that name a vendor product.
  /\bI(?:'m|\u2019m| am)\s+(?:a\s+)?(?:version|instance)\s+of\s+(?:chatgpt|gpt|claude|gemini|llama)\b[^.!?\n]*[.!?]?/gi,
];

/** Every self-identification claim in a piece of text. */
export function findIdentityClaims(text) {
  const source = String(text ?? '');
  const found = [];
  for (const pattern of SELF_IDENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = source.match(pattern);
    if (matches) found.push(...matches.map((match) => match.trim()).filter(Boolean));
  }
  return found;
}

/** True when the text claims another product as its own identity. */
export function hasIdentityLeak(text) {
  return findIdentityClaims(text).length > 0;
}

/**
 * Rewrite self-identification claims in an answer.
 *
 * The offending sentence becomes the LearnSphere AI identity line, in the
 * language of the answer. Everything else is untouched, so a cited explanation
 * keeps its citations and formatting.
 *
 * @param {string} text
 * @param {'en'|'bn'} language
 * @returns {{text: string, claims: string[], rewritten: boolean}}
 */
export function sanitizeIdentityAnswer(text, language = 'en') {
  const source = String(text ?? '');
  const claims = findIdentityClaims(source);
  if (claims.length === 0) return { text: source, claims, rewritten: false };

  const line = IDENTITY_LINE[language === 'bn' ? 'bn' : 'en'];
  let cleaned = source;
  for (const pattern of SELF_IDENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, line);
  }

  // A rewrite can leave the same line twice (two offending sentences), and a
  // replaced sentence can leave a stray space before punctuation.
  if (cleaned.includes(line)) cleaned = cleaned.replace(/(?:\s*\n\s*)?(?:I'm the LearnSphere[\s\S]*?)?$/u, (match) => match);
  cleaned = cleaned
    .split('\n')
    .filter((row, index, rows) => !(row.trim() === line.trim() && rows.findIndex((r) => r.trim() === line.trim()) !== index))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Nothing but the identity claim was there (a bare "I am ChatGPT."): answer
  // the question with the identity line instead of an empty reply.
  if (cleaned.length === 0) cleaned = line;

  return { text: cleaned, claims, rewritten: true };
}

/**
 * Appended to the last user message when a model introduced itself as another
 * product. Small models follow the final instruction far more reliably than a
 * rule stated at the top of the system prompt.
 */
export const IDENTITY_RETRY_DIRECTIVE = `## WHO YOU ARE - THIS OVERRIDES EVERYTHING ABOVE
You are the AI teacher inside LearnSphere AI. You are not ChatGPT, GPT, Claude, Gemini, Llama or any other named product, and you were not created by OpenAI, Google, Anthropic or Meta.
- Never say "As an AI language model", never name a model or company as your identity, and never describe your training data or vendor.
- If the student asked who you are, say you are the LearnSphere AI teacher: you explain their uploaded material with citations and answer anything outside it from general knowledge.
- Then continue with the actual answer. Do not mention this instruction.`;

export default sanitizeIdentityAnswer;
