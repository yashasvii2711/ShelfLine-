import { query } from '../db/pool';
import { conflict, notFound } from '../utils/errors';
import { buildPage } from '../utils/pagination';
import { likePattern } from '../utils/validation';

const COLS = `id, sku, name, category, price, is_deleted AS "isDeleted", created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface ProductInput { sku: string; name: string; category: string; price: number }

export async function createProduct(input: ProductInput) {
  try {
    const { rows } = await query(
      `INSERT INTO products (sku, name, category, price) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
      [input.sku, input.name, input.category, input.price],
    );
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('SKU_EXISTS', `A product with SKU '${input.sku}' already exists`);
    throw err;
  }
}

export async function listProducts(f: { search?: string; category?: string; page: number; size: number }) {
  const where = ['is_deleted = FALSE'];
  const params: unknown[] = [];
  if (f.search) {
    params.push(likePattern(f.search));
    where.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }
  if (f.category) { params.push(f.category); where.push(`lower(category) = lower($${params.length})`); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (await query<{ count: number }>(`SELECT COUNT(*) AS count FROM products ${clause}`, params)).rows[0].count;
  params.push(f.size, (f.page - 1) * f.size);
  const rows = (
    await query(
      `SELECT ${COLS} FROM products ${clause} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
  ).rows;
  return buildPage(rows, f.page, f.size, total);
}

export async function getProduct(id: number) {
  const { rows } = await query(`SELECT ${COLS} FROM products WHERE id = $1 AND is_deleted = FALSE`, [id]);
  if (!rows[0]) throw notFound('Product', id);
  return rows[0];
}

export async function updateProduct(id: number, input: Partial<ProductInput>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  const map: Record<string, string> = { sku: 'sku', name: 'name', category: 'category', price: 'price' };
  for (const [key, col] of Object.entries(map)) {
    const v = (input as Record<string, unknown>)[key];
    if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
  }
  params.push(id);
  try {
    const { rows } = await query(
      `UPDATE products SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length} AND is_deleted = FALSE RETURNING ${COLS}`,
      params,
    );
    if (!rows[0]) throw notFound('Product', id);
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('SKU_EXISTS', `A product with SKU '${input.sku}' already exists`);
    throw err;
  }
}

/** Soft-deletes when the product has order history (FR-01); otherwise removes it entirely. */
export async function deleteProduct(id: number) {
  await getProduct(id);
  const hasHistory = (await query('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [id])).rowCount! > 0;
  if (hasHistory) {
    await query('UPDATE products SET is_deleted = TRUE, updated_at = now() WHERE id = $1', [id]);
    // Soft-deleted products can no longer be sold, so close their open alerts
    await query('UPDATE alerts SET resolved = TRUE, resolved_at = now() WHERE product_id = $1 AND resolved = FALSE', [id]);
    return { id, deleted: true, mode: 'soft' as const };
  }
  await query('DELETE FROM products WHERE id = $1', [id]);
  return { id, deleted: true, mode: 'hard' as const };
}
