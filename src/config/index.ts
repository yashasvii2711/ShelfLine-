import 'dotenv/config';

const int = (value: string | undefined, fallback: number): number => {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/inventory',
  dbPoolMax: int(process.env.DB_POOL_MAX, 20),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  signupCode: process.env.SIGNUP_CODE ?? '',
  authRateLimit: {
    windowMs: int(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60_000),
    max: int(process.env.AUTH_RATE_LIMIT_MAX, 20),
  },
  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: int(process.env.RATE_LIMIT_MAX, 100),
  },
};
