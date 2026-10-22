import { createApp } from './app';
import { config } from './config';
import { runMigrations } from './db/migrate';
import { closePool } from './db/pool';
import { ensureAdminFromEnv } from './services/authService';
import { logger } from './utils/logger';

async function main() {
  if (!process.env.VERCEL) {
    await runMigrations();
    await ensureAdminFromEnv();
  }
  const app = createApp();
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'Inventory API listening'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => closePool().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
