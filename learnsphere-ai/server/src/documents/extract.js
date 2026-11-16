/**
 * Text extraction for uploaded study material.
 *
 * Supported input: PDF, plain text/Markdown, Word (.docx and Word 97-2003
 * .doc), OpenDocument (.odt) and RTF (.rtf). Extraction NEVER executes,
 * renders or evaluates uploaded content - it only reads text out of the bytes
 * and returns plain strings.
 *
 * Two rules this module follows everywhere:
 *  1. Detect the format from the bytes, not the extension. Word happily saves
 *     RTF with a .doc name, and students rename files constantly; trusting the
 *     extension is what produces "corrupted file" errors for perfectly good
 *     files.
 *  2. Never fail silently. Every lossy outcome (a scanned page, a damaged text
 *     layer, a truncated document, a page-count cap) comes back as a warning
 *     that the UI shows.
 */
import path from 'node:path';
import { detectLanguage } from '../retrieval/tokenize.js';
import { docxToText, odtToText, legacyDocToText, rtfToText, detectDocumentFormat } from './office.js';

const PAGE_LIMIT = 600;
const MAX_CHARS = 4_000_000;

/** Extensions we can actually read, used by the API and the UI. */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown', '.docx', '.doc', '.docm', '.rtf', '.odt'];

/** Control chars, zero-width and bidi-override characters. */
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normaliseText(input) {
  return String(input)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ratio of characters that indicate a broken encoding or a bad text layer. */
function damageRatio(text) {
  if (!text) return 1;
  const bad = (text.match(/[\uFFFD\u25A1]/g) ?? []).length;
  return bad / text.length;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let nul = 0;
  for (const byte of sample) if (byte === 0) nul += 1;
  return sample.length > 0 && nul / sample.length > 0.01;
}

/**
 * Decode a text file, honouring a byte-order mark and falling back to Windows
 * Notepad's 8-bit encodings when the bytes are not valid UTF-8.
 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\uFFFD')) {
    // Not UTF-8 after all: read it as Windows-1252, which is what a Bangla or
    // accented file typed in an old editor will actually be.
    let fallback = '';
    for (const byte of buffer) {
      fallback +=
        byte >= 0x80 && byte <= 0x9f
          ? String.fromCharCode(
              [
                0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
                0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
                0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
              ][byte - 0x80],
            )
          : String.fromCharCode(byte);
    }
    return fallback;
  }
  return text;
}

async function loadPdfJs() {
  // The legacy build is the one that works under plain Node without a DOM.
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

/**
 * Whole-document summary (overview line) for a PDF, used by the summary
 * service to write the "Overview" lead sentence without asking the model.
 */
export async function pdfOverviewText(buffer) {
  const pdfjs = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  } catch (err) {
    // If we cannot even open the PDF, fall back to an empty overview.
    return '';
  }
  const limit = Math.min(doc.numPages, 3);
  const parts = [];
  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = itemsToText(content.items);
    if (text) parts.push(text);
    page.cleanup();
  }
  await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).destroy().catch(() => {});
  return normaliseText(parts.join('\n')).slice(0, 1400);
}

/** Rebuild readable lines from pdfjs text items using their y positions. */
function itemsToText(items) {
  const lines = new Map();
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const y = Math.round((item.transform?.[5] ?? 0) * 2) / 2;
    const line = lines.get(y) ?? [];
    line.push({ x: item.transform?.[4] ?? 0, str: item.str });
    lines.set(y, line);
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF y grows upward
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

async function extractPdf(buffer) {
  const warnings = [];
  const pdfjs = await loadPdfJs();

  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // never eval font programs from an untrusted file
    useSystemFonts: false,
    disableFontFace: true,
    // Silences pdfjs's own console chatter; real errors still throw.
    verbosity: 0,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = err?.name ?? '';
    if (name === 'PasswordException') {
      throw Object.assign(new Error('This PDF is password protected.'), {
        code: 'pdf_encrypted',
      });
    }
    if (name === 'InvalidPDFException') {
      throw Object.assign(new Error('This file is not a readable PDF.'), { code: 'pdf_invalid' });
    }
    throw err;
  }

  const pageCount = doc.numPages;
  const pages = [];
  try {
    const limit = Math.min(pageCount, PAGE_LIMIT);
    if (pageCount > PAGE_LIMIT) {
      warnings.push({
        code: 'page_limit',
        message: `Only the first ${PAGE_LIMIT} of ${pageCount} pages were indexed.`,
      });
    }
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normaliseText(itemsToText(content.items));
      if (text) pages.push({ pageNumber, text });
      page.cleanup();
    }
  } finally {
    // pdfjs v6 exposes teardown on the loading task, not on the document proxy.
    // Releasing it matters: the parsed document holds the whole file in memory.
    await task.destroy().catch(() => {});
  }

  const charCount = pages.reduce((sum, p) => sum + p.text.length, 0);
  if (charCount === 0) {
    warnings.push({
      code: 'no_extractable_text',
      message:
        'No selectable text was found. This looks like a scanned or image-only PDF, so it needs OCR before it can be searched.',
    });
  }

  const joined = pages.map((p) => p.text).join('\n');
  if (charCount > 0 && damageRatio(joined) > 0.02) {
    warnings.push({
      code: 'poor_text_quality',
      message: 'The PDF text layer is partly damaged, so some passages may look garbled.',
    });
  }

  return { kind: 'pdf', pageCount, pages, warnings, charCount };
}

/**
 * Split extracted document text into pages on the form feeds the readers emit.
 * A reader with no page information yields exactly one page, which keeps
 * citations honest instead of inventing page numbers.
 */
function textToPages(text) {
  return String(text)
    .split('\f')
    .map((pageText, index) => ({ pageNumber: index + 1, text: normaliseText(pageText) }))
    .filter((page) => page.text.length > 0);
}

function extractPlainText(buffer, filename) {
  const warnings = [];
  if (looksBinary(buffer)) {
    throw Object.assign(new Error('This file looks like a binary file, not plain text.'), {
      code: 'binary_not_text',
    });
  }
  const text = normaliseText(decodeText(buffer));

  if (!text) {
    warnings.push({ code: 'empty_document', message: 'This file contains no readable text.' });
  } else if (damageRatio(text) > 0.02) {
    warnings.push({
      code: 'poor_text_quality',
      message: 'This file is not valid UTF-8, so some characters could not be read correctly.',
    });
  }

  const kind = path.extname(filename).toLowerCase() === '.md' ? 'markdown' : 'text';
  return {
    kind,
    pageCount: 1,
    pages: text ? [{ pageNumber: 1, text }] : [],
    warnings,
    charCount: text.length,
  };
}

/**
 * Extract from one of the rich document formats, converting to the same page
 * structure a PDF produces so the rest of the pipeline needs no special cases.
 */
function extractRichDocument(buffer, format, filename) {
  const warnings = [];
  let text = '';
  let kind = format;

  switch (format) {
    case 'docx': {
      // .docm is the same container with macros, which we never execute.
      text = docxToText(buffer).text;
      kind = 'docx';
      warnings.push({
        code: 'docx_no_layout',
        message:
          'Word stores text, not pages, so page numbers come from the breaks Word last recorded. Sections without one are reported as a single page.',
      });
      break;
    }
    case 'odt': {
      text = odtToText(buffer).text;
      warnings.push({
        code: 'odt_no_layout',
        message: 'Page numbers in .odt files come from saved page breaks, not from the original layout.',
      });
      break;
    }
    case 'doc': {
      const result = legacyDocToText(buffer);
      text = result.text;
      warnings.push(...result.warnings);
      warnings.push({
        code: 'doc_formatting_lost',
        message:
          'The old .doc format stores formatting separately from text, so tables and headings may read as plain lines.',
      });
      break;
    }
    case 'rtf': {
      const result = rtfToText(buffer);
      text = result.text;
      warnings.push({
        code: 'rtf_formatting_lost',
        message: 'RTF formatting codes are not text, so emphasis and colours were not kept.',
      });
      break;
    }
    default:
      throw Object.assign(new Error(`Unsupported document format "${format}".`), { code: 'unsupported_type' });
  }

  const pages = textToPages(text);
  const charCount = pages.reduce((sum, page) => sum + page.text.length, 0);

  if (charCount === 0) {
    warnings.push({
      code: 'no_extractable_text',
      message: 'No text could be read out of this document. It may be empty or contain only images or drawings.',
    });
  } else if (damageRatio(text) > 0.02) {
    warnings.push({
      code: 'poor_text_quality',
      message: 'Part of this document could not be decoded cleanly, so some characters may look wrong.',
    });
  }

  return { kind, pageCount: Math.max(1, pages.length), pages, warnings, charCount };
}

/** Drop pages past the character budget, and say so. */
function applyCharLimit(result) {
  if (result.charCount <= MAX_CHARS) return result;
  const pages = [];
  let used = 0;
  for (const page of result.pages) {
    if (used >= MAX_CHARS) break;
    const remaining = MAX_CHARS - used;
    const text = page.text.length <= remaining ? page.text : page.text.slice(0, remaining);
    pages.push({ pageNumber: page.pageNumber, text });
    used += text.length;
  }
  return {
    ...result,
    pages,
    charCount: used,
    warnings: [
      ...result.warnings,
      {
        code: 'truncated',
        message: `This document is larger than the ${Math.round(MAX_CHARS / 1000)}k character indexing limit, so only its first part was indexed.`,
      },
    ],
  };
}

/** Dominant language of the document, from the text itself. */
function detectDocumentLanguage(result) {
  const sample = result.pages
    .slice(0, 20)
    .map((page) => page.text.slice(0, 4000))
    .join('\n');
  return detectLanguage(sample);
}

/** Declared as an Office document: the bytes have to back that up. */
const OFFICE_EXTENSIONS = new Set(['.docx', '.docm', '.doc', '.odt']);

function typeError(message) {
  return Object.assign(new Error(message), { code: 'unsupported_type' });
}

/**
 * Decide how to read the file from its bytes, and refuse anything whose content
 * contradicts its extension with a message that says how to fix it. Trusting
 * the extension alone is what turns a mislabelled file into a confusing
 * "corrupted document" error.
 */
function resolveFormat(buffer, ext, filename, mimeType) {
  const detected = detectDocumentFormat(buffer, ext);
  const looksZip = buffer.subarray(0, 2).toString('latin1') === 'PK';

  const rescueZip = () => {
    try {
      docxToText(buffer);
      return 'docx';
    } catch {
      try {
        odtToText(buffer);
        return 'odt';
      } catch {
        return null;
      }
    }
  };

  if (OFFICE_EXTENSIONS.has(ext)) {
    if (detected === 'doc') return 'doc';
    if (detected === 'odt') return 'odt';
    if (looksZip) {
      const rescued = rescueZip();
      if (rescued) return rescued;
      throw typeError(
        'This file is a ZIP archive, but not a Word or OpenDocument document (an installer or a spreadsheet looks similar). Upload the document itself.',
      );
    }
    const label = ext === '.odt' ? 'OpenDocument' : 'Word';
    throw typeError(
      `This file is named "${ext}" but does not contain a ${label} document. Re-export it as ${ext} and upload it again.`,
    );
  }

  if (detected === 'zip') {
    const rescued = rescueZip();
    if (rescued) return rescued;
    throw typeError(
      'This file is a ZIP archive, but not a Word or OpenDocument document (an installer or a spreadsheet looks similar). Upload the document itself.',
    );
  }
  if (detected === 'doc' || detected === 'odt' || detected === 'rtf') return detected;

  // A file named .pdf that is not a PDF would otherwise be read as text and
  // indexed as garbage, so it is rejected with the real reason instead.
  if (ext === '.pdf' && detected !== 'pdf') {
    throw Object.assign(
      new Error('This file is named .pdf but does not contain PDF data, so its text could not be read.'),
      { code: 'pdf_invalid' },
    );
  }
  if (detected === 'pdf') return 'pdf';

  const isText = detected === 'text' || detected === 'markdown';
  if (!isText) {
    throw typeError(`Unsupported file type "${ext || mimeType || filename || 'unknown'}".`);
  }
  return detected;
}

/**
 * @param {{ buffer: Buffer, filename: string, mimeType?: string }} input
 * @returns {Promise<{kind:string,pageCount:number,pages:{pageNumber:number,text:string}[],warnings:{code:string,message:string}[],charCount:number,language:'en'|'bn'}>}
 */
export async function extractText({ buffer, filename, mimeType = '' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('The uploaded file is empty.'), { code: 'empty_file' });
  }

  const ext = path.extname(filename).toLowerCase();
  const format = resolveFormat(buffer, ext, filename, mimeType);
  const isPlain = format === 'text' || format === 'markdown';

  const result =
    format === 'pdf'
      ? await extractPdf(buffer)
      : isPlain
        ? extractPlainText(buffer, filename)
        : extractRichDocument(buffer, format, filename);

  const limited = applyCharLimit(result);
  return { ...limited, language: detectDocumentLanguage(limited) };
}

export default extractText;
