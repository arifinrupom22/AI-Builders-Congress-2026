/**
 * Ingestion pipeline: bytes -> validated material -> text -> passages -> index.
 *
 * Ordering matters. The record is created first so a failure is visible in the
 * student's library rather than vanishing, and the raw bytes are written under
 * a generated UUID filename so the original filename never touches the
 * filesystem (no traversal, no collisions, no unicode surprises).
 */
import path from 'node:path';
import AppError from '../errors.js';
import { extractText } from './extract.js';
import { chunkPages } from './chunk.js';
import { sha256 } from '../storage/store.js';

const KIND_BY_EXT = {
  '.pdf': 'pdf',
  '.txt': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.docx': 'docx',
  '.docm': 'docx',
  '.doc': 'doc',
  '.rtf': 'rtf',
  '.odt': 'odt',
};


/** Strip path components and control characters from a user-supplied filename. */
export function safeDisplayName(rawName) {
  const base = path.basename(String(rawName ?? 'document')).replace(/[\u0000-\u001F\u007F]/g, '');
  const cleaned = base.replace(/[\\/]/g, '_').trim();
  const limited = cleaned.length > 180 ? cleaned.slice(-180) : cleaned;
  return limited || 'document';
}

/** Container formats whose bytes must actually match their extension. */
const CONTAINER_EXTENSIONS = new Set(['.docx', '.docm', '.doc', '.odt']);

export function validateUpload({ filename, sizeBytes, ext, mimeType, config, buffer }) {
  const problems = [];
  if (!config.upload.allowedExtensions.includes(ext)) {
    problems.push({
      code: 'unsupported_type',
      message: `"${ext || 'unknown'}" files are not supported. Upload ${config.upload.allowedExtensions.join(', ')} files.`,
    });
  }

  // Refuse a file whose bytes contradict its extension before anything is
  // written to disk: a mislabelled file can never be read, so putting a failed
  // record in the student's library would only add noise. Deeper problems (a
  // valid container with a damaged part) are found during extraction, where
  // they are stored and explained like any other extraction failure.
  if (CONTAINER_EXTENSIONS.has(ext) && Buffer.isBuffer(buffer) && buffer.length > 0) {
    const head = buffer.subarray(0, 8).toString('latin1');
    const looksLikeContainer =
      head.startsWith('PK') || head.startsWith('\u00d0\u00cf\u0011\u00e0\u00a1\u00b1\u001a\u00e1');
    if (!looksLikeContainer) {
      const label = ext === '.odt' ? 'OpenDocument' : 'Word';
      problems.push({
        code: 'unsupported_type',
        message: `This file is named "${ext}" but does not contain a ${label} document. Re-export it as ${ext} and upload it again.`,
      });
    }
  }
  if (sizeBytes === 0) problems.push({ code: 'empty_file', message: 'That file is empty.' });
  if (sizeBytes > config.upload.maxBytes) {
    problems.push({
      code: 'payload_too_large',
      message: `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(
        config.upload.maxBytes / 1024 / 1024,
      )} MB.`,
    });
  }
  if (mimeType && !config.upload.allowedMimeTypes.includes(mimeType) && !mimeType.startsWith('text/')) {
    problems.push({ code: 'unsupported_media_type', message: `The server reported content type "${mimeType}".` });
  }
  return problems;
}

/**
 * @returns {Promise<{material:object, passages:object[], ok:boolean}>}
 */
export async function ingestMaterial({ store, retrieval, config, logger, learnerId, buffer, filename, mimeType = '' }) {
  const displayName = safeDisplayName(filename);
  const ext = path.extname(displayName).toLowerCase();
  const sizeBytes = buffer.length;

  const problems = validateUpload({ filename: displayName, sizeBytes, ext, mimeType, config, buffer });
  if (problems.length > 0) {
    const first = problems[0];
    const error = new AppError(first.message, {
      status: first.code === 'payload_too_large' ? 413 : 415,
      code: first.code,
      details: { problems },
      expose: true,
    });
    throw error;
  }

  const count = await store.countMaterials(learnerId);
  if (count >= config.upload.maxDocuments) {
    throw new AppError(
      `Material limit reached (${config.upload.maxDocuments} documents). Remove one before uploading another.`,
      { status: 409, code: 'material_limit_reached', expose: true },
    );
  }

  const hash = sha256(buffer);
  const duplicate = await store.findMaterialByHash(learnerId, hash);
  if (duplicate) {
    throw new AppError(`"${duplicate.name}" already has identical contents, so it is already in your library.`, {
      status: 409,
      code: 'duplicate_material',
      details: { existingMaterialId: duplicate.id, existingName: duplicate.name },
      expose: true,
    });
  }

  const material = await store.createMaterial({
    learnerId,
    name: displayName,
    sizeBytes,
    kind: KIND_BY_EXT[ext] ?? 'text',
    ext,
    mimeType: mimeType || 'application/octet-stream',
    hash,
  });

  await store.saveRaw(material.id, ext, buffer);

  try {
    const extracted = await extractText({ buffer, filename: displayName, mimeType });
    const passages = chunkPages(extracted.pages, { materialId: material.id, documentName: displayName });

    await store.savePassages(material.id, passages);

    const status = passages.length === 0 ? 'empty' : 'ready';
    const updated = await store.updateMaterial(material.id, learnerId, {
      status,
      warnings: extracted.warnings,
      pageCount: extracted.pageCount,
      passageCount: passages.length,
      charCount: extracted.charCount,
      language: extracted.language,
      error: passages.length === 0 ? extracted.warnings[0]?.message ?? 'No readable text found.' : null,
    });

    await retrieval.invalidate(learnerId);
    logger.info('material ingested', {
      materialId: material.id,
      learnerId,
      kind: extracted.kind,
      status,
      language: extracted.language,
      pageCount: extracted.pageCount,
      passages: passages.length,
      warnings: extracted.warnings.map((w) => w.code),
    });

    // Contract: whenever `ok` is false there is an `error` describing why, so a
    // caller never has to invent a message for a legitimate outcome such as a
    // scanned PDF with no text layer.
    return {
      material: updated,
      passages,
      ok: status === 'ready',
      error:
        status === 'empty'
          ? { code: extracted.warnings[0]?.code ?? 'no_extractable_text', message: updated.error }
          : undefined,
    };
  } catch (err) {
    // Each reader reports a specific code, so the student is told what is
    // actually wrong with their file instead of a generic failure.
    const messages = {
      pdf_encrypted: 'This PDF is password protected, so its text could not be read.',
      pdf_invalid: 'This PDF appears to be corrupted and could not be read.',
      binary_not_text: 'This file was named as text but contains binary data.',
      docx_invalid: 'This .docx file is missing its document part, so it may be damaged.',
      odt_invalid: 'This .odt file is missing its content part, so it may be damaged.',
      zip_invalid: 'This Office file is damaged: its archive has no readable directory.',
      zip_empty: 'This Office file contains no readable parts.',
      doc_invalid: 'This .doc file does not contain a Word document stream.',
      doc_no_text: 'No readable text was found inside this .doc file.',
      ole2_invalid: 'This .doc file is not a valid Word 97-2003 document.',
      ole2_empty: 'This .doc file has no readable streams inside it.',
      rtf_invalid: 'This .rtf file is not a readable RTF document.',
      empty_file: 'That file is empty.',
    };
    const message = messages[err.code] ?? (err.code === 'unsupported_type' ? err.message : 'The text could not be extracted from this file.');

    const failed = await store.updateMaterial(material.id, learnerId, {
      status: 'failed',
      error: message,
      warnings: [{ code: err.code ?? 'extraction_failed', message }],
    });
    logger.warn('material ingestion failed', { materialId: material.id, learnerId, code: err.code, reason: message });
    // The record is kept on purpose: the student sees exactly which file failed
    // and why, and can remove it with one click.
    return { material: failed, passages: [], ok: false, error: { code: err.code ?? 'extraction_failed', message } };
  }
}

export default ingestMaterial;
