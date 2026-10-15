/**
 * Passage chunking.
 *
 * Splits extracted pages into search-sized passages while preserving the two
 * facts that make citations trustworthy: the source document and the page
 * number. Chunking never crosses a page boundary, so a citation can never
 * point at a page the text did not come from.
 *
 * Every passage carries a stable, human-readable id of the form
 * `<materialId>-p<page>-<n>`, which is what lets us verify after generation
 * that a cited source actually came out of retrieval.
 */
import { normaliseText } from './extract.js';

const DEFAULTS = { targetChars: 900, overlapChars: 160, minChars: 240 };

const SENTENCE_BOUNDARY = /(?<=[.!?।])\s+(?=[^\s])/;

/** Split a block into sentences. Handles Bangla danda (।) as well as Latin stops. */
export function splitSentences(text) {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MD_HEADING = /^\s{0,3}#{1,6}\s+/;
const MD_LIST_MARKER = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const MD_TRAILING_HASHES = /\s+#+\s*$/;

/**
 * Strip markdown decoration from a candidate heading line.
 *
 * Without this, a Markdown document produces headings like
 * "# Database transactions - study notes", which then leak the `#` into
 * citations, quiz topics and the progress breakdown.
 */
export function cleanHeadingLine(line) {
  return String(line)
    .replace(MD_HEADING, '')
    .replace(MD_LIST_MARKER, '')
    .replace(MD_TRAILING_HASHES, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * A short, punctuation-free single line is very likely a heading.
 *
 * The internal-terminator test matters: a chunk can begin with the previous
 * chunk's overlap sentence followed by the next markdown heading, which would
 * otherwise be recorded as a heading of the form
 * "This works well when conflicts are rare. ## Write-ahead logging".
 */
function detectHeading(text) {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (!firstLine || firstLine.length > 90) return null;

  const heading = cleanHeadingLine(firstLine);
  if (!heading || heading.length > 90) return null;
  if (/[.!?\u0964]\s/.test(heading)) return null; // prose, not a heading
  if (/[.!?:;,]$/.test(heading)) return null;
  if (heading.split(/\s+/).length > 12) return null;
  return heading;
}

function splitBlock(block, targetChars) {
  if (block.length <= targetChars * 1.35) return [block];
  const parts = [];
  let current = '';
  for (const sentence of splitSentences(block)) {
    if (current && current.length + sentence.length + 1 > targetChars) {
      parts.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * @param {{pageNumber:number,text:string}[]} pages
 * @param {{materialId:string,documentName:string,options?:Partial<typeof DEFAULTS>}} meta
 */
export function chunkPages(pages, { materialId, documentName, options = {} }) {
  const { targetChars, overlapChars, minChars } = { ...DEFAULTS, ...options };
  const passages = [];

  for (const page of pages) {
    const blocks = normaliseText(page.text)
      .split(/\n{2,}/)
      .flatMap((block) => splitBlock(block, targetChars))
      .filter((block) => block.trim().length > 0);

    const pageChunks = [];
    let current = '';

    for (const block of blocks) {
      if (current && current.length + block.length + 2 > targetChars) {
        pageChunks.push(current);
        // Carry a little overlap so a sentence split across a boundary is still
        // findable, but never let overlap exceed a third of the chunk.
        const tail = splitSentences(current).slice(-2).join(' ');
        const carry = tail.length <= Math.min(overlapChars, Math.floor(targetChars / 3)) ? tail : '';
        current = carry ? `${carry}\n${block}` : block;
      } else {
        current = current ? `${current}\n${block}` : block;
      }
    }
    if (current) pageChunks.push(current);

    // Fold a runt final chunk back into its neighbour (same page, so page
    // numbers stay exact).
    if (pageChunks.length > 1 && pageChunks.at(-1).length < minChars) {
      const last = pageChunks.pop();
      pageChunks[pageChunks.length - 1] = `${pageChunks.at(-1)}\n${last}`;
    }

    pageChunks.forEach((text, index) => {
      const clean = text.trim();
      if (!clean) return;
      passages.push({
        id: `${materialId}-p${page.pageNumber}-${index}`,
        materialId,
        documentName,
        pageNumber: page.pageNumber,
        index,
        heading: detectHeading(clean),
        text: clean,
        charCount: clean.length,
      });
    });
  }

  return passages;
}

export default chunkPages;
