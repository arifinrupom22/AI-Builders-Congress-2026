/**
 * Dependency-free minimal PDF writer.
 *
 * Used for two things:
 *   1. Generating the bundled sample study material (samples/*.pdf).
 *   2. Building real PDF fixtures in the test suite, so PDF extraction is
 *      tested against genuine PDF bytes rather than a mock.
 *
 * It writes a spec-shaped file: catalog, page tree, one content stream per page,
 * a Base14 font, a correct cross-reference table with real byte offsets, and a
 * trailer. Text is WinAnsi/latin1 only - these fixtures are English on purpose.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const LEADING = 15;

function escapeText(text) {
  return String(text)
    .replace(/[\u0080-\uFFFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapLine(text, maxChars = 88) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function contentStream(text) {
  const lines = String(text)
    .split('\n')
    .flatMap((line) => wrapLine(line));
  const body = lines.map((line) => `(${escapeText(line)}) Tj T*`).join('\n');
  return `BT\n/F1 11 Tf\n${LEADING} TL\n${MARGIN} ${PAGE_HEIGHT - MARGIN} Td\n${body}\nET`;
}

/**
 * @param {string[]} pages one string per page
 * @returns {Buffer}
 */
export function makePdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('makePdf needs at least one page');

  const pageNums = [];
  const contentNums = [];
  let next = 3;
  for (let i = 0; i < pages.length; i += 1) {
    pageNums.push(next);
    next += 1;
    contentNums.push(next);
    next += 1;
  }
  const fontNum = next;
  const total = fontNum;

  const bodies = new Array(total + 1).fill('');
  const kids = pageNums.map((n) => `${n} 0 R`).join(' ');

  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  bodies[fontNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  pages.forEach((text, index) => {
    const stream = contentStream(text);
    bodies[pageNums[index]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> /ProcSet [/PDF /Text] >> ` +
      `/Contents ${contentNums[index]} 0 R >>`;
    bodies[contentNums[index]] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  // --- serialise, recording byte offsets -----------------------------------
  let file = '%PDF-1.4\n';
  const offsets = new Array(total + 1).fill(0);

  for (let n = 1; n <= total; n += 1) {
    offsets[n] = Buffer.byteLength(file, 'latin1');
    file += `${n} 0 obj\n${bodies[n]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(file, 'latin1');
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n += 1) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  file += xref;
  file += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(file, 'latin1');
}

export default makePdf;
