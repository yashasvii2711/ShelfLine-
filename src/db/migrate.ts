import fs from 'node:fs';
import path from 'node:path';
import { closePool, pool } from './pool';
import { logger } from '../utils/logger';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const LOCK_KEY = 727001; // advisory lock so concurrent runners (e.g. several containers) don't collide

export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.info({ migration: file }, 'Applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

if (require.main === module) {
  runMigrations()
    .then((a) => logger.info({ applied: a }, a.length ? 'Migrations complete' : 'Database already up to date'))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exitCode = 1;
    })
    .finally(closePool);
}
