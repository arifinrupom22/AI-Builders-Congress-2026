/**
 * Typed application errors + the single Express error handler.
 *
 * Every failure the client can see is one of these, so responses stay uniform
 * and internal details (stack traces, filesystem paths, provider error bodies)
 * never reach the browser unless we explicitly opt in.
 */

export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details = null, expose = false } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }

  static badRequest(message, details) {
    return new AppError(message, { status: 400, code: 'bad_request', details, expose: true });
  }
  static notFound(message = 'Not found') {
    return new AppError(message, { status: 404, code: 'not_found', expose: true });
  }
  static tooLarge(message, details) {
    return new AppError(message, { status: 413, code: 'payload_too_large', details, expose: true });
  }
  static unsupportedMedia(message, details) {
    return new AppError(message, { status: 415, code: 'unsupported_media_type', details, expose: true });
  }
  static conflict(message, details) {
    return new AppError(message, { status: 409, code: 'conflict', details, expose: true });
  }
  static tooManyRequests(message = 'Too many requests', details) {
    return new AppError(message, { status: 429, code: 'rate_limited', details, expose: true });
  }
  static upstream(message, details) {
    return new AppError(message, { status: 502, code: 'ai_provider_error', details, expose: true });
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `No API route matches ${req.method} ${req.path}` },
  });
}

/** eslint-disable-next-line no-unused-vars -- Express requires the 4-arg shape. */
export function errorHandler(logger) {
  return (err, req, res, _next) => {
    const requestId = req.id;

    // Multer surfaces limits as its own error codes.
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: { code: 'payload_too_large', message: 'That file is larger than the configured upload limit.', requestId },
      });
    }
    if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: { code: 'bad_request', message: `Unexpected upload field "${err.field}". Use the "file" field.`, requestId },
      });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'payload_too_large', message: 'Request body is too large.', requestId },
      });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({
        error: { code: 'bad_request', message: 'Request body is not valid JSON.', requestId },
      });
    }

    if (err instanceof AppError) {
      const body = {
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Request failed.',
          ...(err.details && err.expose ? { details: err.details } : {}),
          requestId,
        },
      };
      if (err.status >= 500) logger.error('request failed', { requestId, code: err.code, message: err.message });
      else logger.warn('request rejected', { requestId, code: err.code, status: err.status });
      return res.status(err.status).json(body);
    }

    logger.error('unhandled error', {
      requestId,
      name: err?.name,
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
    });
    return res.status(500).json({
      error: { code: 'internal_error', message: 'Something went wrong on the server. Please try again.', requestId },
    });
  };
}

export default AppError;
