// Loaded by Jest before any test module (see jest.config.js `setupFiles`)
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/inventory_test';
process.env.RATE_LIMIT_MAX = '100000';
process.env.DB_POOL_MAX = '20';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.SIGNUP_CODE = '';
