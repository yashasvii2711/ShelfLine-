import rateLimit from 'express-rate-limit';
import { sendError } from './errorHandler';

export function createRateLimiter(opts: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) =>
      sendError(res, req, 429, 'RATE_LIMITED', 'Too many requests, please slow down and retry later'),
  });
}
