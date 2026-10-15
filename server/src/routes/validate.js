/**
 * Request validation helper.
 *
 * Every mutating endpoint validates its input with a zod schema before any
 * business logic runs, and returns 400 with field-level detail on failure. This
 * is the server-side half of the "validate input on the server" requirement -
 * the frontend performing the same checks is a convenience, never a guarantee.
 */
import AppError from '../errors.js';

export function parseBody(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw AppError.badRequest('The request body is not valid.', {
      fields: result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function parseQuery(schema, query) {
  const result = schema.safeParse(query ?? {});
  if (!result.success) {
    throw AppError.badRequest('The query string is not valid.', {
      fields: result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export default { parseBody, parseQuery };
