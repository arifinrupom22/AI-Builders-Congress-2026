/**
 * Grounding: the layer that keeps answers attached to real sources.
 *
 * Three jobs, all of them testable without any AI provider:
 *  1. Screen retrieved passages for prompt-injection text and flag it (we keep
 *     the text, because deleting it would silently lose legitimate content,
 *     but the model is told to ignore it and the UI is warned).
 *  2. Assemble a bounded CONTEXT with stable short ids ([S1], [S2], ...).
 *  3. Verify the model's output: every citation must match a passage that
 *     really was retrieved, and every long quotation must really appear in the
 *     retrieved text. Anything that fails is stripped or flagged, never shown
 *     as a source.
 */
import { normaliseForSearch } from '../retrieval/tokenize.js';

/** Instruction-like text found inside uploaded documents. */
export const INJECTION_PATTERNS = [
  { code: 'ignore_instructions', re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction)/i },
  { code: 'role_override', re: /\byou are (now|no longer)\b|\bact as\b[^.\n]{0,30}\b(dan|jailbreak|unrestricted|admin)/i },
  { code: 'prompt_exfiltration', re: /\b(reveal|print|show|repeat|leak|output)\b[^.\n]{0,30}\b(system prompt|instructions|api[ _-]?key|secret|token|password)/i },
  { code: 'chat_markup', re: /<\|(im_start|im_end|system|endoftext)\|>|\[\/?INST\]|^\s*(system|assistant)\s*:/im },
  { code: 'exfiltrate_files', re: /\b(output|send|upload|email|post)\b[^.\n]{0,40}\b(file|document|every (pdf|file)|all (pdf|file)s?)\b/i },
];

export function screenPassage(text) {
  const reasons = [];
  for (const { code, re } of INJECTION_PATTERNS) {
    if (re.test(text)) reasons.push(code);
  }
  return { suspicious: reasons.length > 0, reasons };
}

/**
 * Turn retrieval results into numbered context passages under a character budget.
 * Highest-ranked passages are kept whole; the budget only ever drops the tail.
 */
export function preparePassages(results, { contextChars = 6000 } = {}) {
  const passages = [];
  const notes = [];
  let used = 0;
  let truncated = false;

  for (const result of results) {
    const screen = screenPassage(result.text);
    const headerCost = 80;
    const remaining = contextChars - used - headerCost;
    if (remaining < 200) {
      truncated = true;
      break;
    }

    let text = result.text;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining).trimEnd()}...`;
      truncated = true;
    }

    const id = `S${passages.length + 1}`;
    passages.push({
      id,
      passageId: result.passageId,
      materialId: result.materialId,
      documentName: result.documentName,
      pageNumber: result.pageNumber,
      heading: result.heading,
      text,
      score: result.score,
      suspicious: screen.suspicious,
      suspiciousReasons: screen.reasons,
    });

    if (screen.suspicious) {
      notes.push({
        code: 'unsafe_instruction_text',
        passageId: id,
        message: `Passage ${id} in "${result.documentName}" contains instruction-like text. It was treated as data only.`,
      });
    }
    used += text.length + headerCost;
  }

  return { passages, notes, truncated, usedChars: used };
}

const CITATION_RE = /\[S(\d+)\]/g;

/**
 * Keep only citations that point at passages we actually retrieved.
 * @returns {{citations:object[], invalidIds:string[], citedIds:string[]}}
 */
export function validateCitations(answerText, passages) {
  const byId = new Map(passages.map((p) => [p.id, p]));
  const seen = new Set();
  const invalid = new Set();

  for (const match of String(answerText).matchAll(CITATION_RE)) {
    const id = `S${match[1]}`;
    if (byId.has(id)) seen.add(id);
    else invalid.add(id);
  }

  const citedIds = [...seen].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const citations = citedIds.map((id) => {
    const p = byId.get(id);
    return {
      id,
      passageId: p.passageId,
      materialId: p.materialId,
      documentName: p.documentName,
      pageNumber: p.pageNumber,
      heading: p.heading,
      snippet: p.text.length > 320 ? `${p.text.slice(0, 320).trimEnd()}...` : p.text,
      relevance: p.score,
    };
  });

  return { citations, invalidIds: [...invalid], citedIds };
}

/**
 * Remove citations the model invented, so a dangling [S9] never renders as if
 * it were a real source. Also returns the invalid ids for logging.
 */
export function stripInvalidCitations(answerText, invalidIds) {
  if (invalidIds.length === 0) return answerText;
  return invalidIds.reduce(
    (text, id) => text.replaceAll(`[${id}]`, '').replace(/[ \t]{2,}/g, ' '),
    String(answerText),
  );
}

const QUOTE_RE = /[""]([^""]{40,400})[""]|"([^"]{40,400})"/g;

/**
 * Find long quotations in an answer that do not appear in the retrieved text.
 * A cheap, deterministic anti-hallucination check that needs no model call.
 */
export function findUnsupportedQuotes(answerText, passages) {
  const haystack = normaliseForSearch(passages.map((p) => p.text).join('\n'));
  const flatHaystack = haystack.replace(/\s+/g, ' ');
  const flagged = [];

  for (const match of String(answerText).matchAll(QUOTE_RE)) {
    const quote = match[1] ?? match[2];
    if (!quote) continue;
    const needle = normaliseForSearch(quote).replace(/\s+/g, ' ').trim();
    if (needle.length < 40) continue;
    if (!flatHaystack.includes(needle)) flagged.push(quote.trim());
  }

  return flagged;
}

/** Cap absurdly long model output before it reaches the client. */
export function clampAnswer(text, maxChars = 12000) {
  const clean = String(text ?? '').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars)}\n\n_(answer truncated)_`;
}

export default { preparePassages, validateCitations, stripInvalidCitations, findUnsupportedQuotes, screenPassage };
