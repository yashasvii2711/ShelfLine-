import { NextFunction, Request, RequestHandler, Response } from 'express';
import { getUserByToken, AuthUser, Role } from '../services/authService';
import { AppError } from '../utils/errors';
import { asyncHandler } from './errorHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: AuthUser; authToken?: string } }
}

export const COOKIE = 'sid';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  const m = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) || null : null;
}

export const setSessionCookie = (req: Request, res: Response, token: string) =>
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE_MS, path: '/' });
export const clearSessionCookie = (res: Response) => res.clearCookie(COOKIE, { path: '/' });

/** Requires a valid session (Authorization: Bearer <token> or the httpOnly `sid` cookie). */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = readToken(req);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const user = await getUserByToken(token);
  if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired, please sign in again');
  req.user = user;
  req.authToken = token;
  next();
});

export const requireRole = (...roles: Role[]): RequestHandler => (req: Request, _res: Response, next: NextFunction) =>
  roles.includes(req.user!.role) ? next() : next(new AppError(403, 'FORBIDDEN', 'Your role does not allow this action'));
