import { Router } from 'express';
import { z } from 'zod';
import { authenticate, clearSessionCookie, setSessionCookie } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import * as auth from '../services/authService';
import { parse } from '../utils/validation';

const email = z.string().trim().toLowerCase().email('must be a valid email').max(254);
const signupBody = z.object({
  name: z.string().trim().min(1, 'is required').max(100),
  email,
  password: z.string().min(8, 'must be at least 8 characters').max(128)
    .regex(/[A-Za-z]/, 'must contain a letter').regex(/\d/, 'must contain a number'),
  inviteCode: z.string().max(100).optional(),
}).strict();
const loginBody = z.object({ email, password: z.string().min(1, 'is required').max(128) }).strict();

export const authRouter = Router();

authRouter.get('/config', asyncHandler(async (_req, res) => { res.json(await auth.publicConfig()); }));

authRouter.post('/signup', asyncHandler(async (req, res) => {
  const user = await auth.signup(parse(signupBody, req.body));
  const token = await auth.createSession(user.id);
  setSessionCookie(req, res, token);
  res.status(201).json({ user, token });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const body = parse(loginBody, req.body);
  const { user, token } = await auth.login(body.email, body.password);
  setSessionCookie(req, res, token);
  res.json({ user, token });
}));

authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await auth.destroySession(req.authToken!);
  clearSessionCookie(res);
  res.json({ loggedOut: true });
}));

authRouter.get('/me', authenticate, (req, res) => { res.json({ user: req.user }); });
