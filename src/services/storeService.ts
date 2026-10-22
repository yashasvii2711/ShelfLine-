import { query } from '../db/pool';
import { conflict, notFound } from '../utils/errors';
import { buildPage } from '../utils/pagination';
import { likePattern } from '../utils/validation';

const COLS = `id, name, city, created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface StoreInput { name: string; city: string }

export async function createStore(input: StoreInput) {
  const { rows } = await query(`INSERT INTO stores (name, city) VALUES ($1,$2) RETURNING ${COLS}`, [input.name, input.city]);
  return rows[0];
}

export async function listStores(f: { search?: string; city?: string; page: number; size: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.search) { params.push(likePattern(f.search)); where.push(`(name ILIKE $${params.length} OR city ILIKE $${params.length})`); }
  if (f.city) { params.push(f.city); where.push(`lower(city) = lower($${params.length})`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query<{ count: number }>(`SELECT COUNT(*) AS count FROM stores ${clause}`, params)).rows[0].count;
  params.push(f.size, (f.page - 1) * f.size);
  const rows = (
    await query(`SELECT ${COLS} FROM stores ${clause} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
  ).rows;
  return buildPage(rows, f.page, f.size, total);
}

export async function getStore(id: number) {
  const { rows } = await query(`SELECT ${COLS} FROM stores WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Store', id);
  return rows[0];
}

export async function updateStore(id: number, input: Partial<StoreInput>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { params.push(input.name); sets.push(`name = $${params.length}`); }
  if (input.city !== undefined) { params.push(input.city); sets.push(`city = $${params.length}`); }
  params.push(id);
  const { rows } = await query(
    `UPDATE stores SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING ${COLS}`,
    params,
  );
  if (!rows[0]) throw notFound('Store', id);
  return rows[0];
}

/** A store with order history cannot be deleted (409); otherwise its stock records are removed with it. */
export async function deleteStore(id: number) {
  await getStore(id);
  const hasOrders = (await query('SELECT 1 FROM orders WHERE store_id = $1 LIMIT 1', [id])).rowCount! > 0;
  if (hasOrders) throw conflict('STORE_HAS_ORDERS', `Store ${id} has order history and cannot be deleted`);
  await query('DELETE FROM stores WHERE id = $1', [id]);
  return { id, deleted: true };
}
