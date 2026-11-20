/**
 * Answer instructions.
 *
 * "Ans ta english e bujhao" is not a question about the material - it is an
 * instruction about the answer. Sent to retrieval, the words "english", "ans"
 * and "ta" match nothing, so the teacher used to refuse and claim the material
 * did not cover the question. This module separates the two: it reports the
 * requested language, whether the sentence is explicitly an instruction, and
 * the text that is left once the instruction is removed.
 */

/** Filler that only makes sense in an instruction, never in a content question. */
const INSTRUCTION_WORDS = new Set([
  'ans', 'answer', 'ans ta', 'ta', 'eta', 'eita', 'it', 'this', 'that', 'the', 'my', 'me', 'please',
  'plz', 'again', 'abbar', 'abar', 'kore', 'koro', 'dao', 'den', 'give', 'tell', 'say', 'bolo', 'bolen',
  'bujhao', 'bujha', 'bujan', 'explain', 'describe', 'write', 'lekho', 'translate', 'translation',
  'version', 'in', 'into', 'to', 'english', 'ingreji', 'bangla', 'banglay', 'banglate', 'bangla e',
  'simple', 'simply', 'detail', 'details', 'vabe', 'bhabe', 'short', 'choto', 'boro', 'full', 'puro',
  'question', 'previous', 'above', 'same', 'one', 'ektu', 'ekbar', 'answer ta', 'ans ta',
]);

const BANGLA_FILLER = ['\u0987\u0982\u09b0\u09c7\u099c\u09bf\u09a4\u09c7', '\u0987\u0982\u09b0\u09c7\u099c\u09bf', '\u09ac\u09be\u0982\u09b2\u09be\u09af\u09bc', '\u09ac\u09be\u0982\u09b2\u09be', '\u09ac\u09b2\u09cb', '\u09ac\u09b2\u09c7\u09a8', '\u09ac\u09c1\u099d\u09be\u0993', '\u0989\u09a4\u09cd\u09a4\u09b0', '\u0986\u09ac\u09be\u09b0', '\u09a6\u09be\u0993'];

const LANGUAGE_RULES = [
  { language: 'en', re: /\bin\s+english\b/i },
  { language: 'en', re: /\benglish\s+(?:e|te|a|ay|y)\b/i },
  { language: 'en', re: /\benglish\s*(?:e|te)?\s*(?:bujhao|bolo|lekho|explain|answer|version|translation)\b/i },
  { language: 'en', re: /\u0987\u0982\u09b0\u09c7\u099c\u09bf(?:\u09a4\u09c7|\u09af\u09bc)?/ },
  { language: 'bn', re: /\bbangla\s*(?:e|y|te)\b/i },
  { language: 'bn', re: /\bbanglay\b/i },
  { language: 'bn', re: /\bbangla\s*(?:bujhao|bolo|lekho|explain|answer)\b/i },
  { language: 'bn', re: /\u09ac\u09be\u0982\u09b2\u09be(?:\u09af\u09bc|\u09a4\u09c7)?/ },
];

/** Verbs that make an instruction explicit rather than an accidental match. */
const INSTRUCTION_VERB = /\b(bujhao|bujha|bolo|bolen|lekho|explain|answer|translate|version|say|tell)\b|\u09ac\u09b2\u09cb|\u09ac\u09c1\u099d\u09be\u0993/i;

/** Remove the matched language phrase and instruction filler, leaving content. */
function stripInstruction(text) {
  let rest = text;
  for (const rule of LANGUAGE_RULES) rest = rest.replace(rule.re, ' ');
  rest = rest.replace(/[.,!?।]+/g, ' ');

  const kept = rest
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => {
      const lower = word.toLowerCase();
      if (INSTRUCTION_WORDS.has(lower)) return false;
      if (BANGLA_FILLER.includes(word)) return false;
      // Single letters ("e", "ta") carry no content on their own.
      return lower.length > 1;
    });

  return kept.join(' ').trim();
}

/**
 * @param {string} question
 * @returns {{language: 'en'|'bn'|null, explicit: boolean, stripped: string}}
 */
export function detectAnswerRequest(question) {
  const text = String(question ?? '').trim();
  if (!text) return { language: null, explicit: false, stripped: '' };

  const match = LANGUAGE_RULES.find((rule) => rule.re.test(text));
  if (!match) return { language: null, explicit: false, stripped: text };

  return {
    language: match.language,
    explicit: INSTRUCTION_VERB.test(text) || /\bin\s+(english|bangla)\b/i.test(text) || /\u0987\u0982\u09b0\u09c7\u099c\u09bf|\u09ac\u09be\u0982\u09b2\u09be/.test(text),
    stripped: stripInstruction(text),
  };
}

/**
 * Short social messages: greetings, thanks, goodbyes, acknowledgements and
 * "who are you" questions.
 *
 * These are not study questions. Sent to retrieval they match nothing, and the
 * general-knowledge path then apologised that the material did not cover "Hi",
 * which reads like a machine. They get a short conversational reply instead:
 * no retrieval, no citations, no coverage warning.
 */
const SMALL_TALK_RULES = [
  {
    category: 'greeting',
    re: /^(?:hi+|hey+|hello+|helo+|hlo|yo|sup|hola|greetings|namaste|namaskar|salam|assalamu(?: alaikum)?|as-?salamu alaykum|salaam|good (?:morning|afternoon|evening|night))$/i,
  },
  {
    category: 'greeting',
    re: /^(?:hi|hey|hello|good morning|good evening)\s+(?:there|teacher|tutor|bot|ai|sir|maam|ma'am|friend)$/i,
  },
  {
    category: 'greeting',
    re: /^(?:kemon|kemono|kaimon|kemne)\s+(?:acho|achen|aso|asen|acen|achhen)$/i,
  },
  { category: 'greeting', re: /^(?:ki\s+)?(?:khobor|kobor|obostha)(?:\s+ki)?$/i },
  { category: 'greeting', re: /^how (?:are|r) (?:you|u)(?: doing)?$/i },
  { category: 'greeting', re: /^what'?s up$/i },
  { category: 'greeting', re: /^(?:\u09b9\u09be\u0987|\u09b9\u09cd\u09af\u09be\u09b2\u09cb|\u09b8\u09be\u09b2\u09be\u09ae|\u09a8\u09ae\u09b8\u09cd\u0995\u09be\u09b0)$/ },
  { category: 'greeting', re: /^(?:\u0995\u09c7\u09ae\u09a8 \u0986\u099b\u09cb|\u0995\u09c7\u09ae\u09a8 \u0986\u099b\u09c7\u09a8|\u0995\u09bf \u0996\u09ac\u09b0)$/ },
  {
    category: 'thanks',
    re: /^(?:thanks|thank you|thanks a lot|many thanks|thx|ty|tysm|dhonnobad|dhanyabad|dhonnobad vai|shukriya|\u09a7\u09a8\u09cd\u09af\u09ac\u09be\u09a6)$/i,
  },
  { category: 'farewell', re: /^(?:bye|byebye|goodbye|good bye|see you|see ya|tata|ok bye|\u09ac\u09bf\u09a6\u09be\u0987)$/i },
  {
    category: 'ack',
    re: /^(?:ok|okay|k|kk|got it|gotcha|bujhlam|bujhechi|bujlam|thik ache|thikase|tik ache|accha|achha|nice|cool|great|perfect|\u09ac\u09c1\u099d\u09b2\u09be\u09ae|\u09a0\u09bf\u0995 \u0986\u099b\u09c7)$/i,
  },
  // "Who are you?" arrives in many spellings, and every one of them must take
  // the identity path. Sent to retrieval or the general prompt, the model
  // answered from its own persona ("I am ChatGPT, an OpenAI language model"),
  // which is exactly the answer this product must never give.
  {
    category: 'about',
    re: /^(?:who are you|who r u|who are u|who r ya|who r you|what are you|what r u|what r you|what can you do|what do you do|what is this|what is this app|what is this site|what is learnsphere|tell me about yourself|introduce yourself|how can you help(?: me)?|what can you help(?: me)? with|help|help me)/i,
  },
  {
    category: 'about',
    re: /^(?:who|what)(?:'s| is| are| r| s|s)?\s+(?:your|ur)\s+name$/i,
  },
  {
    category: 'about',
    re: /^(?:what|which)\s+(?:ai\s+|language\s+)?(?:model|llm|bot|assistant)\s+(?:are|r)\s+(?:you|u)(?:\s+(?:using|running|built on))?$/i,
  },
  {
    category: 'about',
    re: /^(?:are|r)\s+(?:you|u)\s+(?:a\s+|an\s+)?(?:chatgpt|gpt-?\d?|openai|claude|gemini|bard|llama|copilot|human|bot|robot|real(?: ai)?|ai model)(?:\s+(?:model|bot|assistant|ai))?$/i,
  },
  {
    category: 'about',
    re: /^(?:who|what)\s+(?:made|created|built|trained|developed|owns)\s+(?:you|u)$/i,
  },
  {
    category: 'about',
    re: /^(?:who|what)\s+(?:is|are)\s+(?:your|ur)\s+(?:creator|creators|developer|developers|maker|makers|owner|owners|company)$/i,
  },
  {
    category: 'about',
    re: /^(?:are|r)\s+(?:you|u)\s+(?:made|built|created|trained)\s+by\s+(?:openai|google|anthropic|meta|microsoft)$/i,
  },
  // Bangla script and Banglish forms of the same question.
  { category: 'about', re: /^(?:tumi|tui|apni|tumi\s+ki|apni\s+ki)\s+ke$/i },
  { category: 'about', re: /^(?:tomar|tor|apnar|apni|tumi)\s+(?:nam|naam)\s+ki$/i },
  {
    category: 'about',
    re: /^(?:tomake|toke|apnake|tomader|apnader)\s+ke\s+(?:banaise|baniyeche|banalo|tairi\s+koreche|create\s+koreche|train\s+koreche)$/i,
  },
  {
    category: 'about',
    re: /^(?:tumi|tui|apni)\s+(?:ki|kono|ekta)?\s*(?:chatgpt|gpt|openai|claude|gemini|bot|robot|ai model)\s*(?:ho|hosen|hobi)?$/i,
  },
  { category: 'about', re: /^(?:\u0986\u09aa\u09a8\u09bf|\u09a4\u09c1\u09ae\u09bf|\u09a4\u09c1\u0987)\s+\u0995\u09c7$/ },
  { category: 'about', re: /^(?:\u0986\u09aa\u09a8\u09be\u09b0|\u09a4\u09cb\u09ae\u09be\u09b0|\u09a4\u09cb\u09b0)\s+\u09a8\u09be\u09ae\s+\u0995\u09bf$/ },
  {
    category: 'about',
    re: /^(?:\u0986\u09aa\u09a8\u09be\u0995\u09c7|\u09a4\u09cb\u09ae\u09be\u0995\u09c7)\s+\u0995\u09c7\s+(?:\u09ac\u09be\u09a8\u09bf\u09af\u09bc\u09c7\u099b\u09c7|\u09ac\u09be\u09a8\u09be\u09b2\u09cb|\u09a4\u09c8\u09b0\u09bf\s+\u0995\u09b0\u09c7\u099b\u09c7)$/ },
  {
    category: 'about',
    re: /^(?:\u0986\u09aa\u09a8\u09bf|\u09a4\u09c1\u09ae\u09bf)\s+(?:\u0995\u09c7|\u0995\u09bf)\s*(?:chatgpt|gpt|\u09ac\u099f|ai)\s*(?:\u09b9\u09cb|\u09b9\u09c7\u09a8)?$/i,
  },
  // --- study intent -------------------------------------------------------
  // "Ami poralekha korbo" is a student saying they are about to study, not a
  // question about essay writing. Without these rules the phrase was treated as
  // a topic and the general-knowledge model answered with an essay-writing
  // guide about "poralekha".
  {
    category: 'study',
    re: /^(?:i|i will|i'?ll|i want to|i wanna|i am going to|i'?m going to|let'?s|time to|cholo|chol|ami)\s+(?:study|revise|read|prepare)\b/i,
  },
  { category: 'study', re: /^(?:study|revision|revise)\s+(?:korbo|korte chai|korte cai|start|time)$/i },
  {
    category: 'study',
    re: /^(?:ami|ami ekhon|cholo|chol|aj|today)\s+(?:pora\s?lekha|poralekha|porashona|pora|porbo|porte|study)\b/i,
  },
  {
    category: 'study',
    re: /^(?:pora\s?lekha|poralekha|porashona|pora|study)\s+(?:korbo|korte chai|korte cai|shuru korbo|suru korbo|bosbo|boshbo|kori)$/i,
  },
  { category: 'study', re: /^(?:ami\s+)?(?:porbo|porte\s+bosbo|porte\s+boshbo)$/i },
  { category: 'study', re: /^(?:study|revision|pora|pora\s?lekha|poralekha|porashona)$/i },
  // Bangla script: "ami poralekha korbo" and its short forms.
  {
    category: 'study',
    re: /^(?:\u0986\u09ae\u09bf\s+)?(?:\u09aa\u09a1\u09bc\u09be\u09b2\u09c7\u0996\u09be|\u09aa\u09a1\u09bc\u09be\u09b6\u09cb\u09a8\u09be|\u09aa\u09a1\u09bc\u09be)(?:\s+(?:\u0995\u09b0\u09ac|\u0995\u09b0\u09a4\u09c7 \u099a\u09be\u0987|\u09b6\u09c1\u09b0\u09c1 \u0995\u09b0\u09ac|\u09ac\u09b8\u09ac))?$/,
  },
  { category: 'study', re: /^(?:\u0986\u09ae\u09bf\s+)?(?:\u09aa\u09a1\u09bc\u09ac|\u09aa\u09a1\u09bc\u09a4\u09c7 \u09ac\u09b8\u09ac)$/ },
];

/**
 * A follow-up is a short message that refers to the previous turn instead of
 * naming a topic: "aro bolo", "eta bujhlam na", "example dao", "why?".
 *
 * These used to be searched as if they were new questions, matched nothing, and
 * were answered from general knowledge - so a student who asked "aro bolo"
 * after an answer about algorithms got a fresh, unrelated introduction.
 */
/**
 * Does this question depend on information that changes over time?
 *
 * A language model's knowledge stops at its training cutoff, but it will still
 * answer "who is the prime minister now?" or "was there a lockdown today?" in a
 * confident present tense. That is how a stale model produced a wrong current
 * office-holder and a "no lockdown" claim about an event it never saw. Questions
 * like these must be answered with an explicit freshness caveat, never as
 * settled current fact.
 */
const TIME_SENSITIVE_RE =
  /(?:\b(?:today|tonight|yesterday|this (?:week|month|year)|right now|currently|current (?:prime minister|president|government|minister|chief|situation|lockdown|news)|latest|breaking|recent(?:ly)?|news|lockdown|curfew|election|prime minister|chief adviser|president|government|minister|stock market|weather|exchange rate|price of|pm)\b|ki chole|\b20(?:2[4-9]|3[0-9])\b|\b(?:ekhon|akhon|aj|ajke|ajk|ei somoy|ei muchhurte|khobor|notun|sorkar|prodhan ?montri|prodhanmontri|nirbachon|lockdown|curfew|bandho|bondho|dam|abar)\b)/i;

/**
 * @param {string} question
 * @returns {boolean} true when the answer depends on live/current information
 */
export function isTimeSensitive(question) {
  const text = String(question ?? '');
  if (!text.trim()) return false;
  return TIME_SENSITIVE_RE.test(text);
}

const FOLLOW_UP_RE =
  /^(?:(?:ok|okay|hmm|tahole|to|then|and)\s+)?(?:aro|aaro|more|beshi|detail|details|continue|carry on|next|again|abar|explain more|explain again|bujhlam na|bujhi ni|bujhte parlam na|bujte parlam na|bujhlam na|eta|eita|eta bujhao|eita bujhao|why|keno|kivabe|kibhabe|how so|example|examples|udahoron|udaharan|udahoron dao|another example|give (?:an? )?example|tarpor|erpor|pore ki|what next)\b/i;

/**
 * @param {string} question
 * @returns {boolean}
 */
export function isFollowUp(question) {
  const text = String(question ?? '')
    .toLowerCase()
    .replace(/[\u0964.!?,;:'"()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  // A follow-up is short: a full question names its own topic.
  if (text.split(' ').length > 7) return false;
  return FOLLOW_UP_RE.test(text);
}

/**
 * @param {string} question
 * @returns {'greeting'|'thanks'|'farewell'|'ack'|'about'|'study'|null}
 */
export function detectSmallTalk(question) {
  const text = String(question ?? '')
    .toLowerCase()
    .replace(/[\u0964.!?,;:'"()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const rule = SMALL_TALK_RULES.find((candidate) => candidate.re.test(text));
  if (!rule) return null;
  // A greeting is short. Anything longer carries content and must be taught.
  // A study-intent sentence is a little longer ("i am going to study today"),
  // but is still a statement about the session rather than a question. Identity
  // questions span a few words too ("what can you help me with").
  const limit = rule.category === 'study' ? 9 : rule.category === 'about' ? 8 : 5;
  if (text.split(' ').length > limit) return null;
  return rule.category;
}

export default detectAnswerRequest;
