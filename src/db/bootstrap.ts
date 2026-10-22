import { ensureAdminFromEnv } from '../services/authService';
import { logger } from '../utils/logger';
import { runMigrations } from './migrate';
import { closePool } from './pool';

/**
 * One-time setup for a hosted database (e.g. before the first Vercel deploy):
 * creates the tables and the first manager from ADMIN_EMAIL / ADMIN_PASSWORD (/ ADMIN_NAME).
 * Safe to re-run. Does NOT create demo data or demo accounts.
 */
(async () => {
  const applied = await runMigrations();
  await ensureAdminFromEnv();
  logger.info({ applied }, 'Bootstrap complete');
})()
  .catch((err) => { logger.error({ err }, 'Bootstrap failed'); process.exitCode = 1; })
  .finally(closePool);
