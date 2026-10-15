/**
 * Upload handling.
 *
 * Files are held in memory, never written to a path derived from the client's
 * filename, and the multipart parser is restricted to a single `file` field
 * with a hard byte ceiling enforced by multer before anything reaches our code.
 * PDFs are parsed later with `isEvalSupported: false`, so no content inside an
 * upload is ever executed.
 */
import multer from 'multer';
import AppError from '../errors.js';

export function createUploadMiddleware(config) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.upload.maxBytes,
      files: 1,
      fields: 4,
      parts: 6,
    },
  }).single('file');

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return next(err);
      if (!req.file) {
        return next(
          AppError.badRequest('No file was received. Send a multipart/form-data request with a "file" field.', {
            field: 'file',
          }),
        );
      }
      return next();
    });
  };
}

export default createUploadMiddleware;
