import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

// NUMERIC -> number, BIGINT (COUNT) -> number
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
pool.on('error', (err) => logger.error({ err }, 'Unexpected idle database client error'));

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock detected

/**
 * Runs `fn` inside a transaction. Commits on success, rolls back on any error.
 * Retries automatically on serialization failures / deadlocks.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) {
        logger.warn({ code, attempt: attempt + 1 }, 'Retrying transaction');
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
