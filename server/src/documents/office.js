/**
 * Readers for Office and rich-text documents, with no third-party dependencies.
 *
 * Formats:
 *   .docx  ZIP container -> word/document.xml      (OOXML Word)
 *   .odt   ZIP container -> content.xml            (OpenDocument Text)
 *   .doc   OLE2 compound file -> WordDocument FIB + piece table (Word 97-2003)
 *   .rtf   RTF control-word scanner
 *
 * Everything here is a read-only parse of untrusted bytes: no eval, no external
 * entity expansion, no rendering. Sizes are capped so a zip bomb or a corrupt
 * chain cannot exhaust memory, and every cap that bites is reported as a warning
 * rather than silently dropping content.
 *
 * Text is returned with form feeds (\\f) marking real page boundaries, so a
 * .docx carrying Word's `lastRenderedPageBreak` markers produces genuine page
 * numbers for citations instead of a single synthetic page.
 */
import zlib from 'node:zlib';

const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // decompressed size cap per entry
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_STREAMS = 400;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Decode the numeric and named entities that appear in OOXML/ODF text. */
export function decodeXmlEntities(input) {
  return String(input).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '';
      return String.fromCodePoint(codePoint);
    }
    return XML_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

/** Windows-1252 byte to character; 0x80-0x9F are not Latin-1. */
export function cp1252Char(byte) {
  return byte >= 0x80 && byte <= 0x9f ? String.fromCharCode(CP1252_HIGH[byte - 0x80]) : String.fromCharCode(byte);
}

function decodeCodepage(bytes, codepage) {
  if (codepage === 65001) return bytes.toString('utf8');
  if (codepage === 1200) return bytes.toString('utf16le');
  let out = '';
  for (const byte of bytes) out += cp1252Char(byte);
  return out;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/**
 * Read the entries of a ZIP archive using the central directory.
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} entry name -> decompressed bytes
 */
export function readZipEntries(buffer) {
  // The end-of-central-directory record sits at the end, possibly followed by a
  // comment, so scan back over the largest comment the format allows.
  const searchFrom = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw Object.assign(new Error('This file is not a readable ZIP container (no central directory).'), {
      code: 'zip_invalid',
    });
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = directoryOffset;
  let total = 0;

  for (let index = 0; index < entryCount && index < MAX_STREAMS; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/') || compressedSize === 0) continue;
    if (uncompressedSize > MAX_ENTRY_BYTES || total + uncompressedSize > MAX_TOTAL_BYTES) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      const data =
        method === 0
          ? Buffer.from(raw)
          : method === 8
            ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
            : null;
      if (!data) continue; // unsupported method (e.g. the rare bzip2/deflate64)
      total += data.length;
      entries.set(name, data);
    } catch {
      // A single corrupt entry should not fail the whole document.
    }
  }

  if (entries.size === 0) {
    throw Object.assign(new Error('This ZIP container has no readable entries.'), { code: 'zip_empty' });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// OOXML (.docx)
// ---------------------------------------------------------------------------

/**
 * Tokens that carry text in a WordprocessingML run. Table cells and paragraphs
 * are split out before this runs, so only inline content is left.
 */
const RUN_TOKEN =
  /<w:t\b[^>]*(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b([^>]*)\/?>|<w:noBreakHyphen\b[^>]*\/>|<w:softHyphen\b[^>]*\/>/g;

function runText(chunk) {
  let out = '';
  RUN_TOKEN.lastIndex = 0;
  let match = RUN_TOKEN.exec(chunk);
  while (match) {
    const [full, text, brAttributes] = match;
    if (text !== undefined) {
      out += decodeXmlEntities(text);
    } else if (full.startsWith('<w:tab')) {
      out += '\t';
    } else if (full.startsWith('<w:br') || full.startsWith('<w:cr')) {
      // A page break is a real page boundary; a line break is just a newline.
      out += /\bw:type\s*=\s*"(?:page|column)"/i.test(brAttributes ?? '') ? '\f' : '\n';
    } else if (full.startsWith('<w:noBreakHyphen')) {
      out += '\u2011';
    }
    match = RUN_TOKEN.exec(chunk);
  }
  return out;
}

/** Turn a table into one plain line per row so it stays readable as prose. */
function flattenTables(body) {
  return body.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) => {
    const rows = table.split(/<w:tr(?=[\s/>])/).slice(1);
    const lines = rows
      .map((row) =>
        row
          .split(/<w:tc(?=[\s/>])/)
          .slice(1)
          .map((cell) => runText(cell).replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | '),
      )
      .filter(Boolean);
    return lines.map((line) => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  });
}

function headingLevel(styleValue) {
  if (!styleValue) return 0;
  const match = /^(?:heading|h)\s*([1-9])$/i.exec(styleValue.trim());
  if (match) return Number(match[1]);
  return /^(?:title|subtitle)$/i.test(styleValue.trim()) ? 1 : 0;
}

/**
 * Extract the body of a .docx as plain text with markdown-ish headings.
 * @param {Buffer} buffer
 * @returns {{text:string, pageCount:number}}
 */
export function docxToText(buffer) {
  const entries = readZipEntries(buffer);
  const document = entries.get('word/document.xml') ?? entries.get('word/document2.xml');
  if (!document) {
    throw Object.assign(new Error('This .docx has no word/document.xml part.'), { code: 'docx_invalid' });
  }

  const xml = document.toString('utf8');
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
  const body = flattenTables(bodyMatch ? bodyMatch[1] : xml);

  // Paragraphs are the unit of structure; <w:pPr> must not be matched here.
  const paragraphs = body.split(/<w:p(?=[\s/>])/).slice(1);
  const lines = [];

  for (const paragraph of paragraphs) {
    const text = runText(paragraph);
    if (!text.replace(/[\s\f]+/g, '')) {
      // An empty paragraph still carries its page break, if it had one.
      if (text.includes('\f')) lines.push('\f');
      continue;
    }
    const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(paragraph)?.[1] ?? '';
    const level = headingLevel(decodeXmlEntities(style));
    const bulleted = /<w:numPr\b/.test(paragraph);
    if (level > 0) lines.push(`# ${text}`);
    else if (bulleted) lines.push(`- ${text}`);
    else lines.push(text);
  }

  // A page break may sit in the middle of a paragraph, so split on form feeds
  // last, once every line has been assembled.
  const raw = lines.join('\n');
  const pageCount = Math.max(1, raw.split('\f').length);
  return { text: raw, pageCount };
}

// ---------------------------------------------------------------------------
// OpenDocument (.odt)
// ---------------------------------------------------------------------------

/**
 * Strip every tag from a chunk, keeping text plus the whitespace and breaks that
 * OpenDocument encodes as empty elements.
 */
function stripTagsKeepingText(chunk) {
  return decodeXmlEntities(
    String(chunk)
      .replace(/<text:s\b([^>]*)\/>/g, (_, attributes) => {
        const count = /\btext:c\s*=\s*"(\d+)"/.exec(attributes ?? '')?.[1];
        return ' '.repeat(Math.min(Number(count ?? 1) || 1, 64));
      })
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<text:soft-page-break\b[^>]*\/>/g, '\f')
      .replace(/<[^>]*>/g, ''),
  );
}

/**
 * Extract the text of an .odt from its content.xml.
 * @param {Buffer} buffer
 */
export function odtToText(buffer) {
  const entries = readZipEntries(buffer);
  const content = entries.get('content.xml');
  if (!content) {
    throw Object.assign(new Error('This .odt has no content.xml part.'), { code: 'odt_invalid' });
  }

  const xml = content.toString('utf8');
  const bodyMatch = /<office:body\b[^>]*>([\s\S]*)<\/office:body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;

  // Tables collapse to one line per row, like the .docx path.
  const withTables = body.replace(/<table:table\b[\s\S]*?<\/table:table>/g, (table) => {
    const rows = table.split(/<table:table-row(?=[\s/>])/).slice(1);
    return rows
      .map((row) => {
        const cells = row
          .split(/<table:table-cell(?=[\s/>])/)
          .slice(1)
          // The split consumed the opening `<`; putting a tag back lets the
          // stripper remove the attributes too instead of leaving a stray `>`.
          .map((cell) => stripTagsKeepingText(`<c${cell}`).replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ');
        return cells ? `<text:p>${escapeXml(cells)}</text:p>` : '';
      })
      .join('');
  });

  const blocks = withTables.split(/<(text:h|text:p)(?=[\s/>])/).slice(1);
  const lines = [];
  for (let i = 0; i < blocks.length - 1; i += 2) {
    const isHeading = blocks[i] === 'text:h';
    // The split consumed the opening `<`, so put a tag back before stripping:
    // otherwise `text:outline-level="1">` would be read as document text.
    const chunk = `<${blocks[i]}${blocks[i + 1]}`;
    const text = stripTagsKeepingText(chunk).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
    if (!text) {
      if (chunk.includes('\f')) lines.push('\f');
      continue;
    }
    lines.push(isHeading ? `# ${text}` : text);
  }

  const raw = lines.join('\n');
  return { text: raw, pageCount: Math.max(1, raw.split('\f').length) };
}

// ---------------------------------------------------------------------------
// OLE2 compound files (the container of a legacy .doc)
// ---------------------------------------------------------------------------

const OLE_SIGNATURE = '\u00d0\u00cf\u0011\u00e0\u00a1\u00b1\u001a\u00e1';
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const CHAIN_LIMIT = 1_000_000; // sectors; a guard against a cyclic chain

/**
 * Read every stream of an OLE2 compound file (Word 97-2003 and friends).
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function readOle2Streams(buffer) {
  if (buffer.length < 512 || buffer.subarray(0, 8).toString('latin1') !== OLE_SIGNATURE) {
    throw Object.assign(new Error('This file is not an OLE2 compound document.'), { code: 'ole2_invalid' });
  }
  const sectorShift = buffer.readUInt16LE(0x1e);
  if (sectorShift < 7 || sectorShift > 12) {
    throw Object.assign(new Error('This OLE2 file uses an unsupported sector size.'), { code: 'ole2_invalid' });
  }
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << buffer.readUInt16LE(0x20);
  const miniCutoff = buffer.readUInt32LE(0x38) || 4096;
  const fatSectorCount = buffer.readUInt32LE(0x2c);
  const firstDirectorySector = buffer.readUInt32LE(0x30);
  const firstMiniFatSector = buffer.readUInt32LE(0x3c);
  const miniFatSectorCount = buffer.readUInt32LE(0x40);
  const firstDifatSector = buffer.readUInt32LE(0x44);
  const difatSectorCount = buffer.readUInt32LE(0x48);
  const perSector = sectorSize / 4;

  const sector = (index) => buffer.subarray((index + 1) * sectorSize, (index + 1) * sectorSize + sectorSize);
  const sectorExists = (index) => index >= 0 && index < 0xfffffffa && (index + 1) * sectorSize < buffer.length;

  // --- DIFAT -> FAT -------------------------------------------------------
  const difat = [];
  for (let i = 0; i < 109; i += 1) {
    const value = buffer.readUInt32LE(0x4c + i * 4);
    if (sectorExists(value)) difat.push(value);
  }
  let next = firstDifatSector;
  for (let i = 0; i < Math.min(difatSectorCount, 1024) && sectorExists(next); i += 1) {
    const data = sector(next);
    for (let j = 0; j < perSector - 1; j += 1) {
      const value = data.readUInt32LE(j * 4);
      if (sectorExists(value)) difat.push(value);
    }
    next = data.readUInt32LE((perSector - 1) * 4);
  }

  const fat = new Uint32Array(Math.max(1, difat.length * perSector));
  difat.forEach((sectorIndex, i) => {
    if (i * perSector > fat.length) return;
    const data = sector(sectorIndex);
    for (let j = 0; j < perSector && i * perSector + j < fat.length; j += 1) {
      fat[i * perSector + j] = data.readUInt32LE(j * 4);
    }
  });

  const miniFatSectors = [];
  {
    let current = firstMiniFatSector;
    for (let guard = 0; guard < miniFatSectorCount && sectorExists(current); guard += 1) {
      miniFatSectors.push(current);
      current = fat[current];
    }
  }
  // A mini FAT sector is a normal sector full of 4-byte entries; each entry
  // describes one mini sector (64 bytes by default), NOT one 4-byte slot.
  const miniFatPerSector = sectorSize / 4;
  const miniFat = new Uint32Array(Math.max(1, miniFatSectors.length * miniFatPerSector));
  miniFatSectors.forEach((sectorIndex, i) => {
    const data = sector(sectorIndex);
    for (let j = 0; j < miniFatPerSector; j += 1) {
      miniFat[i * miniFatPerSector + j] = data.readUInt32LE(j * 4);
    }
  });

  /** Follow a sector chain into its bytes; `miniStream` must be set for mini sectors. */
  const readChain = (start, table, { mini = false, miniStream = null } = {}) => {
    const parts = [];
    let current = start;
    for (let guard = 0; guard < CHAIN_LIMIT; guard += 1) {
      if (current === ENDOFCHAIN || current === FREESECT) break;
      if (mini) {
        const from = current * miniSize;
        if (!miniStream || from + miniSize > miniStream.length) break;
        parts.push(miniStream.subarray(from, from + miniSize));
      } else {
        if (!sectorExists(current)) break;
        parts.push(sector(current));
      }
      const following = table[current];
      if (following === undefined) break;
      current = following;
    }
    return Buffer.concat(parts);
  };

  // The root entry describes the mini stream, so the directory has to be read
  // before any stream smaller than the cutoff can be resolved.
  const directoryBytes = readChain(firstDirectorySector, fat);
  const entries = [];
  for (let offset = 0; offset + 128 <= directoryBytes.length; offset += 128) {
    const nameLength = directoryBytes.readUInt16LE(offset + 64);
    const type = directoryBytes.readUInt8(offset + 66);
    if (nameLength < 2 || nameLength > 64 || (type !== 2 && type !== 5)) continue;
    entries.push({
      name: directoryBytes.subarray(offset, offset + nameLength - 2).toString('utf16le'),
      type,
      startSector: directoryBytes.readUInt32LE(offset + 116),
      size: directoryBytes.readUInt32LE(offset + 120),
    });
  }

  const root = entries.find((entry) => entry.type === 5) ?? entries[0];
  const miniStream = root && root.size > 0 ? readChain(root.startSector, fat) : Buffer.alloc(0);

  const streams = new Map();
  for (const entry of entries) {
    if (entry.type !== 2 || entry.size <= 0 || entry.size > MAX_ENTRY_BYTES) continue;
    if (streams.size >= MAX_STREAMS) break;
    try {
      const data =
        entry.size < miniCutoff && miniStream.length > 0
          ? readChain(entry.startSector, miniFat, { mini: true, miniStream }).subarray(0, entry.size)
          : readChain(entry.startSector, fat).subarray(0, entry.size);
      if (entry.name) streams.set(entry.name, data);
    } catch {
      // A stream with a broken chain is skipped, not fatal.
    }
  }

  if (streams.size === 0) {
    throw Object.assign(new Error('This OLE2 container has no readable streams.'), { code: 'ole2_empty' });
  }
  return streams;
}

/**
 * Word's CLX (in the table stream) holds the piece table: a list of character
 * ranges plus, for each, the byte offset of its text in the WordDocument stream.
 * Pieces are either 8-bit (one code page byte per character) or UTF-16.
 */
function parsePieceTable(clx, { textLimit }) {
  let offset = 0;
  while (offset < clx.length) {
    const kind = clx.readUInt8(offset);
    if (kind === 0x01) {
      // Prc: skip the grpprl it carries.
      const size = clx.readUInt16LE(offset + 1);
      offset += 3 + size;
      continue;
    }
    if (kind !== 0x02) return null;
    const length = clx.readUInt32LE(offset + 1);
    if (length < 4 || offset + 5 + length > clx.length) return null;
    const block = clx.subarray(offset + 5, offset + 5 + length);
    const pieceCount = Math.floor((block.length - 4) / 12);
    const pieces = [];
    for (let i = 0; i < pieceCount; i += 1) {
      const cpStart = block.readUInt32LE(i * 4);
      const cpEnd = block.readUInt32LE((i + 1) * 4);
      const rawFc = block.readUInt32LE((pieceCount + 1) * 4 + i * 8 + 2);
      pieces.push({
        cpStart,
        cpEnd: Math.min(cpEnd, textLimit || cpEnd),
        compressed: (rawFc & 0x40000000) !== 0,
        byteOffset: (rawFc & 0x3fffffff) >>> 0,
      });
    }
    return pieces.length > 0 ? pieces : null;
  }
  return null;
}

/** Word paragraph marks and field characters are control codes, not content. */
function cleanWordText(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[\u0007]/g, ' | ') // cell mark
    .replace(/[\u000b\u000c]/g, '\n')
    .replace(/[\u0013\u0014\u0015\u0001\u0002\u0008\u001f]/g, '')
    .replace(/[\u001e]/g, '-'); // non-breaking hyphen
}

/**
 * Extract the main text of a Word 97-2003 (.doc) file.
 * @param {Buffer} buffer
 */
export function legacyDocToText(buffer) {
  const streams = readOle2Streams(buffer);
  const document = streams.get('WordDocument') ?? streams.get('worddocument');
  if (!document || document.length < 0x200) {
    throw Object.assign(new Error('This .doc has no WordDocument stream.'), { code: 'doc_invalid' });
  }

  const flags = document.readUInt16LE(10);
  const textLimit = document.readUInt32LE(0x4c); // ccpText
  const fcClx = document.readUInt32LE(0x1a2);
  const lcbClx = document.readUInt32LE(0x1a6);
  let warnings = [];

  // Word 97+ keeps the text location in the piece table of the table stream.
  const tableStream = streams.get(flags & 0x0200 ? '1Table' : '0Table') ?? streams.get('1Table') ?? streams.get('0Table');
  if (tableStream && lcbClx > 0 && fcClx + lcbClx <= tableStream.length) {
    const pieces = parsePieceTable(tableStream.subarray(fcClx, fcClx + lcbClx), { textLimit });
    if (pieces) {
      let text = '';
      for (const piece of pieces) {
        const characters = Math.max(0, piece.cpEnd - piece.cpStart);
        if (characters === 0) continue;
        if (piece.compressed) {
          const bytes = document.subarray(piece.byteOffset, piece.byteOffset + characters);
          let decoded = '';
          for (const byte of bytes) decoded += cp1252Char(byte);
          text += decoded;
        } else {
          const bytes = document.subarray(piece.byteOffset, piece.byteOffset + characters * 2);
          text += bytes.toString('utf16le');
        }
      }
      return { text: cleanWordText(text), warnings };
    }
    warnings = [
      {
        code: 'doc_piece_table_skipped',
        message: 'This .doc uses an unusual internal layout, so its text was read in a simpler way.',
      },
    ];
  }

  // Fallback for pre-Word 97 files: one contiguous text range after the FIB.
  const fcMin = document.readUInt32LE(0x18);
  const fcMac = document.readUInt32LE(0x1c);
  const start = Math.max(fcMin, 0x400);
  const end = Math.min(fcMac > start ? fcMac : document.length, document.length);
  if (end <= start) {
    throw Object.assign(new Error('No readable text was found in this .doc file.'), { code: 'doc_no_text' });
  }
  return { text: cleanWordText(document.subarray(start, end).toString('utf16le')), warnings };
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

/** Destinations whose contents are metadata or binary, never document text. */
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'revtbl',
  'filetbl',
  'info',
  'pict',
  'object',
  'objdata',
  'datastore',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'generator',
  'xmlnstbl',
  'mmathPr',
  'wgrffmtfilter',
  'pgptbl',
  'docvar',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'ftnsep',
  'ftnsepc',
  'ftncn',
  'aftnsep',
  'aftnsepc',
  'upr',
  'ud',
]);

const RTF_SPECIALS = {
  par: '\n',
  line: '\n',
  sect: '\n',
  page: '\f',
  column: '\n',
  row: '\n',
  cell: '\t',
  tab: '\t',
  emdash: '\u2014',
  endash: '\u2013',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201c',
  rdblquote: '\u201d',
  bullet: '\u2022',
  nbsp: '\u00a0',
  '~': '\u00a0',
  '-': '\u00ad',
  _: '\u2011',
};

/**
 * Read the visible text of an RTF document.
 *
 * RTF is a stack of groups made of control words, escape sequences and literal
 * runs. Groups marked ignorable (`{\*\...}`) and formatting tables are dropped;
 * `\uN` escapes and, for UTF-8 documents (WordPad writes `\ansicpg65001`),
 * consecutive `\'hh` byte runs are decoded properly so Bangla survives.
 *
 * @param {Buffer} buffer
 */
export function rtfToText(buffer) {
  const source = buffer.toString('latin1');
  if (!/^\s*\{\\rtf/.test(source)) {
    throw Object.assign(new Error('This file is not a readable RTF document.'), { code: 'rtf_invalid' });
  }

  const stack = [];
  let skip = false;
  let fallbackChars = 1;
  let codepage = 1252;
  let out = '';
  let pendingBytes = [];

  const flushBytes = () => {
    if (pendingBytes.length === 0) return;
    if (!skip) out += decodeCodepage(Buffer.from(pendingBytes), codepage);
    pendingBytes = [];
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];

    if (char === '{') {
      flushBytes();
      stack.push({ skip, fallbackChars, codepage });
      i += 1;
      continue;
    }
    if (char === '}') {
      flushBytes();
      const previous = stack.pop();
      if (previous) {
        skip = previous.skip;
        fallbackChars = previous.fallbackChars;
        codepage = previous.codepage;
      }
      i += 1;
      continue;
    }
    if (char === '\\') {
      const next = source[i + 1];

      if (next === "'") {
        pendingBytes.push(Number.parseInt(source.slice(i + 2, i + 4), 16) || 0);
        i += 4;
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        flushBytes();
        if (!skip) out += next;
        i += 2;
        continue;
      }
      if (next === '*') {
        // {\*\destination ...}: metadata the reader should ignore.
        skip = true;
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        i += 2;
        continue;
      }

      const wordMatch = /^\\([a-zA-Z]+)(-?\d+)?\s?/.exec(source.slice(i));
      if (!wordMatch) {
        // A control symbol we do not model (\~, \-, \_ and friends).
        const symbol = RTF_SPECIALS[next];
        flushBytes();
        if (!skip && symbol) out += symbol;
        i += 2;
        continue;
      }

      const word = wordMatch[1].toLowerCase();
      const parameter = wordMatch[2] === undefined ? null : Number.parseInt(wordMatch[2], 10);
      i += wordMatch[0].length;

      if (word === 'ansicpg' && parameter !== null) {
        flushBytes();
        codepage = parameter;
        continue;
      }
      if (word === 'uc' && parameter !== null) {
        fallbackChars = Math.max(0, Math.min(parameter, 8));
        continue;
      }
      if (RTF_SKIP_DESTINATIONS.has(word)) {
        flushBytes();
        skip = true;
        continue;
      }
      if (word === 'u' && parameter !== null) {
        flushBytes();
        if (!skip) out += String.fromCharCode(parameter < 0 ? parameter + 65_536 : parameter);
        // Skip the ASCII fallback that follows a \u escape (usually "?").
        for (let dropped = 0; dropped < fallbackChars && i < source.length; dropped += 1) {
          if (source[i] === '\\') {
            const escape = /^\\'[0-9a-fA-F]{2}/.exec(source.slice(i));
            i += escape ? escape[0].length : 2;
          } else {
            i += 1;
          }
        }
        continue;
      }
      if (word === 'plain' || word === 'pard' || word === 'par') {
        flushBytes();
        if (!skip && word === 'par') out += '\n';
        continue;
      }
      const special = RTF_SPECIALS[word];
      if (special !== undefined && !skip) {
        flushBytes();
        out += special;
        continue;
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      // Layout newlines in the RTF source are not document content.
      i += 1;
      continue;
    }
    flushBytes();
    if (!skip) out += cp1252Char(source.charCodeAt(i));
    i += 1;
  }
  flushBytes();

  return { text: out };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const RTF_SIGNATURE = '{\\rtf';

/**
 * Identify a document by its bytes rather than trusting the extension, since a
 * wrongly-named file is common and a wrong reader gives a confusing error.
 * @param {Buffer} buffer
 * @param {string} ext lower-case extension including the dot
 */
export function detectDocumentFormat(buffer, ext) {
  const head = buffer.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('PK')) {
    if (ext === '.odt') return 'odt';
    if (ext === '.docx' || ext === '.doc') return 'docx';
    // A ZIP that is not named as an Office file could be either container.
    return 'zip';
  }
  if (head.startsWith(OLE_SIGNATURE)) return 'doc';
  if (head.replace(/^\s+/, '').startsWith(RTF_SIGNATURE)) return 'rtf';
  return ext === '.docx' ? 'zip' : 'text';
}

export default {
  readZipEntries,
  readOle2Streams,
  docxToText,
  odtToText,
  legacyDocToText,
  rtfToText,
  detectDocumentFormat,
  decodeXmlEntities,
  cp1252Char,
};
