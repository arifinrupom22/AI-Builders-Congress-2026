/**
 * Dependency-free minimal Office/Word writers.
 *
 * Same philosophy as `minimal-pdf.mjs`: the extraction code is tested against
 * genuine, spec-shaped bytes instead of a mock, and the sample material for the
 * running app is generated rather than committed as opaque binaries.
 *
 * Provided:
 *   - makeZip / makeDocx  : a real ZIP container with word/document.xml
 *   - makeLegacyDoc       : a real OLE2 compound file holding a WordDocument
 *                           stream (Word 97-2003 shape)
 *
 * Text is written as UTF-16LE throughout, which is how Word stores it, so Bangla
 * (and any other non-Latin script) survives the round trip.
 */
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// CRC32 (ZIP needs it; Node's zlib.crc32 only exists on newer runtimes)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/**
 * @param {{name:string, data:string|Buffer}[]} entries
 * @param {{method?:0|8}} options 8 = deflate (what Word writes), 0 = stored
 */
export function makeZip(entries, { method = 8 } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x2821, 12); // date (arbitrary but valid)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const header = Buffer.concat([local, name]);
    locals.push(header, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8); // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([dir, name]));

    offset += header.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a .docx containing the given paragraphs.
 * @param {{text:string, style?:string}[]|string[]} paragraphs
 */
export function makeDocx(paragraphs) {
  const list = (Array.isArray(paragraphs) ? paragraphs : [paragraphs]).map((p) =>
    typeof p === 'string' ? { text: p } : p,
  );

  const body = list
    .map(({ text, style }) => {
      const runs = String(text)
        .split('\n')
        .map((line, i) => `${i > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
        .join('');
      const props = style ? `<w:pPr><w:pStyle w:val="${xmlEscape(style)}"/></w:pPr>` : '';
      return `<w:p>${props}<w:r>${runs}</w:r></w:p>`;
    })
    .join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
  ]);
}

// ---------------------------------------------------------------------------
// Legacy .doc — OLE2 compound file holding a WordDocument stream
// ---------------------------------------------------------------------------
const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const FREESECT = 0xffffffff;

function oleDirectoryEntry({ name, type, startSector, sizeBytes, child = FREESECT }) {
  const nameBuffer = Buffer.from(`${name}\0`, 'utf16le');
  const entry = Buffer.alloc(128, 0);
  nameBuffer.copy(entry, 0, 0, Math.min(nameBuffer.length, 64));
  entry.writeUInt16LE(nameBuffer.length, 64);
  entry.writeUInt8(type, 66); // 2 = stream, 5 = root storage
  entry.writeUInt8(1, 67); // colour: black
  entry.writeUInt32LE(FREESECT, 68); // left sibling
  entry.writeUInt32LE(FREESECT, 72); // right sibling
  entry.writeUInt32LE(child, 76); // child
  entry.writeUInt32LE(startSector >>> 0, 116);
  entry.writeUInt32LE(sizeBytes, 120);
  return entry;
}

/**
 * Word 97-2003 File Information Block prefix plus the piece table that says
 * where the text really lives.
 *
 * Only the fields a reader needs are filled in; the rest stays zero, which is
 * what Word writes for the feature blocks it does not use.
 */
function wordFib({ fcMin, fcMac, ccpText, fcClx, lcbClx, whichTableStream }) {
  const fib = Buffer.alloc(0x400, 0);
  fib.writeUInt16LE(0xa5ec, 0); // wIdent: Word 97 magic
  fib.writeUInt16LE(0x00c1, 2); // nFib: Word 97
  fib.writeUInt16LE(0x0409, 6); // lid: en-US
  // fWhichTblStm (0x0200) selects the "1Table" stream; fComplex stays clear.
  fib.writeUInt16LE(whichTableStream ? 0x0200 : 0x0000, 10);
  fib.writeUInt32LE(fcMin, 0x18);
  fib.writeUInt32LE(fcMac, 0x1c);
  fib.writeUInt32LE(ccpText, 0x4c); // ccpText
  fib.writeUInt32LE(fcClx, 0x01a2); // fcClx
  fib.writeUInt32LE(lcbClx, 0x01a6); // lcbClx
  return fib;
}

/** CLX holding one uncompressed (UTF-16LE) text piece covering the whole text. */
function wordClx({ fcText, charCount }) {
  const clx = Buffer.alloc(21, 0);
  clx.writeUInt8(0x02, 0); // clxt=2: a Pcdt follows
  clx.writeUInt32LE(16, 1); // lcb: 2 CPs (8 bytes) + 1 PCD (8 bytes)
  clx.writeUInt32LE(0, 5); // CP[0]
  clx.writeUInt32LE(charCount, 9); // CP[1]
  clx.writeUInt16LE(0, 13); // PCD flags
  clx.writeUInt32LE(fcText >>> 0, 15); // fc with fCompressed (bit 30) clear
  clx.writeUInt16LE(0, 19); // prm
  return clx;
}

/**
 * Generic OLE2 (compound file) writer for a flat set of streams.
 * Streams below the 4096-byte cutoff go into the mini stream, exactly as Word
 * writes them, so both allocation paths exist to be read back.
 *
 * @param {{name:string, data:Buffer}[]} streams
 */
export function makeOle2(streams) {
  const chunks = []; // one entry per 512-byte sector of stream data
  const fatEntries = [];
  const miniFat = [];

  const allocate = (data) => {
    const start = chunks.length;
    const count = Math.max(1, Math.ceil(data.length / SECTOR));
    for (let i = 0; i < count; i += 1) {
      const chunk = Buffer.alloc(SECTOR, 0);
      data.copy(chunk, 0, i * SECTOR, Math.min((i + 1) * SECTOR, data.length));
      chunks.push(chunk);
      fatEntries.push(i === count - 1 ? ENDOFCHAIN : start + i + 1);
    }
    return { start, count };
  };

  // Mini stream first: small streams are gathered into one contiguous stream.
  const miniStreams = streams.filter((s) => s.data.length < MINI_CUTOFF);
  const bigStreams = streams.filter((s) => s.data.length >= MINI_CUTOFF);
  const miniParts = [];
  let miniCursor = 0;
  const miniIndex = new Map();

  for (const stream of miniStreams) {
    const count = Math.max(1, Math.ceil(stream.data.length / MINI_SECTOR));
    miniIndex.set(stream.name, miniCursor);
    for (let i = 0; i < count; i += 1) {
      miniFat.push(i === count - 1 ? ENDOFCHAIN : miniCursor + i + 1);
      const filler = Buffer.alloc(MINI_SECTOR, 0);
      const from = i * MINI_SECTOR;
      stream.data.copy(filler, 0, from, Math.min(from + MINI_SECTOR, stream.data.length));
      miniParts.push(filler);
    }
    miniCursor += count;
  }

  const miniStream = miniParts.length > 0 ? Buffer.concat(miniParts) : Buffer.alloc(0);

  const placements = new Map();
  for (const stream of bigStreams) placements.set(stream.name, allocate(stream.data));
  const miniStreamPlacement = miniStream.length > 0 ? allocate(miniStream) : null;

  // Mini FAT sectors, then the FAT, then the directory.
  const miniFatCount = Math.max(1, Math.ceil((miniFat.length * 4) / SECTOR));
  const miniFatPlacement = allocate(Buffer.alloc(miniFatCount * SECTOR));
  for (let i = 0; i < miniFatCount; i += 1) {
    const sectorIndex = miniFatPlacement.start + i;
    const chunk = chunks[sectorIndex];
    chunk.fill(0xff);
    const perSector = SECTOR / 4;
    for (let j = 0; j < perSector; j += 1) {
      const value = miniFat[i * perSector + j];
      chunk.writeUInt32LE(value === undefined ? FREESECT : value, j * 4);
    }
  }

  const directoryEntries = [
    oleDirectoryEntry({
      name: 'Root Entry',
      type: 5,
      startSector: miniStreamPlacement ? miniStreamPlacement.start : ENDOFCHAIN,
      sizeBytes: miniStream.length,
      child: 1,
    }),
    ...streams.map((s) => {
      const placement = placements.get(s.name);
      return oleDirectoryEntry({
        name: s.name,
        type: 2,
        startSector: placement ? placement.start : miniIndex.get(s.name) ?? ENDOFCHAIN,
        sizeBytes: s.data.length,
      });
    }),
  ];
  const dirSectors = Math.max(1, Math.ceil(directoryEntries.length / 4));
  const dirPlacement = allocate(Buffer.alloc(dirSectors * SECTOR));
  directoryEntries.forEach((entry, i) => entry.copy(chunks[dirPlacement.start], i * 128));

  // Enough FAT sectors to describe every sector including the FAT itself.
  const fatSectorCount = Math.max(1, Math.ceil(chunks.length / 127));
  const fatPlacement = allocate(Buffer.alloc(fatSectorCount * SECTOR));

  // Everything is placed; now write the FAT itself.
  const fatSectorIndexes = [];
  for (let i = 0; i < fatSectorCount; i += 1) fatSectorIndexes.push(fatPlacement.start + i);
  const fullFat = Buffer.alloc(fatPlacement.count * SECTOR, 0xff);
  for (let i = 0; i < chunks.length; i += 1) fullFat.writeUInt32LE(fatEntries[i] ?? ENDOFCHAIN, i * 4);
  for (const index of fatSectorIndexes) fullFat.writeUInt32LE(FATSECT, index * 4);
  fullFat.writeUInt32LE(ENDOFCHAIN, dirPlacement.start * 4);
  for (let i = 0; i < miniFatCount; i += 1) {
    const index = miniFatPlacement.start + i;
    fullFat.writeUInt32LE(i === miniFatCount - 1 ? ENDOFCHAIN : index + 1, index * 4);
  }
  fullFat.copy(chunks[fatPlacement.start]);

  // --- header -------------------------------------------------------------
  const header = Buffer.alloc(SECTOR, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 0x18);
  header.writeUInt16LE(0x0003, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e); // sector shift => 512
  header.writeUInt16LE(6, 0x20); // mini sector shift => 64
  header.writeUInt32LE(0, 0x28);
  header.writeUInt32LE(fatSectorCount, 0x2c);
  header.writeUInt32LE(dirPlacement.start, 0x30);
  header.writeUInt32LE(0, 0x34);
  header.writeUInt32LE(MINI_CUTOFF, 0x38);
  header.writeUInt32LE(miniStream.length > 0 ? miniFatPlacement.start : ENDOFCHAIN, 0x3c);
  header.writeUInt32LE(miniStream.length > 0 ? miniFatCount : 0, 0x40);
  header.writeUInt32LE(ENDOFCHAIN, 0x44);
  header.writeUInt32LE(0, 0x48);
  header.writeUInt32LE(fatSectorIndexes[0], 0x4c);
  for (let i = 1; i < 109; i += 1) header.writeUInt32LE(FREESECT, 0x4c + i * 4);

  return Buffer.concat([header, ...chunks]);
}

/**
 * Build a genuine Word 97-2003 document: an OLE2 container with a WordDocument
 * stream (FIB + UTF-16LE text) and a small "1Table" stream holding the CLX.
 * @param {string} text document text (any script); "\n" becomes a paragraph mark
 */
export function makeLegacyDoc(text) {
  const body = String(text).replace(/\r?\n/g, '\r'); // Word ends paragraphs with CR
  const textBuffer = Buffer.from(body, 'utf16le');
  const fcMin = 0x400;
  const clx = wordClx({ fcText: fcMin, charCount: body.length });

  const documentStream = Buffer.concat([
    wordFib({
      fcMin,
      fcMac: fcMin + textBuffer.length,
      ccpText: body.length,
      fcClx: 0,
      lcbClx: clx.length,
      whichTableStream: true,
    }),
    textBuffer,
  ]);

  return makeOle2([
    { name: 'WordDocument', data: documentStream },
    { name: '1Table', data: clx },
  ]);
}

export default { makeZip, makeDocx, makeOle2, makeLegacyDoc, crc32 };
