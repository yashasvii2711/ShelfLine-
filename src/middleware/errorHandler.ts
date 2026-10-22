import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function sendError(res: Response, req: Request, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ error: { code, message, ...(details !== undefined && { details }), requestId: String(req.id) } });
}

export function notFoundHandler(req: Request, res: Response) {
  sendError(res, req, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    log.info({ code: err.code, status: err.status }, err.message);
    return sendError(res, req, err.status, err.code, err.message, err.details);
  }

  const e = err as { type?: string; status?: number; code?: string; constraint?: string };
  if (e.type === 'entity.parse.failed') return sendError(res, req, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (e.type === 'entity.too.large') return sendError(res, req, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

  // Database constraint violations that slipped past service-level checks
  if (e.code === '23505') return sendError(res, req, 409, 'CONFLICT', 'Resource already exists', { constraint: e.constraint });
  if (e.code === '23503') return sendError(res, req, 409, 'CONFLICT', 'Operation violates a reference constraint', { constraint: e.constraint });
  if (e.code === '23514') return sendError(res, req, 409, 'CONSTRAINT_VIOLATION', 'Operation violates a data constraint', { constraint: e.constraint });

  log.error({ err }, 'Unhandled error');
  return sendError(res, req, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
