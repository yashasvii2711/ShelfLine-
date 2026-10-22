import { query, withTransaction } from '../db/pool';
import { getLogger } from '../utils/logger';
import { notFound, unprocessable } from '../utils/errors';
import { buildPage } from '../utils/pagination';
import { likePattern } from '../utils/validation';
import { syncAlert } from './alertService';
import { getStore } from './storeService';

const SELECT = `SELECT i.product_id AS "productId", p.sku, p.name, p.category, p.price,
       i.store_id AS "storeId", i.quantity, i.low_stock_threshold AS "lowStockThreshold",
       (i.quantity <= i.low_stock_threshold) AS "isLowStock", i.updated_at AS "updatedAt"
  FROM inventory i JOIN products p ON p.id = i.product_id`;

export async function listInventory(
  storeId: number,
  f: { lowStock?: boolean; search?: string; category?: string; page: number; size: number },
) {
  await getStore(storeId);
  const where = ['i.store_id = $1', 'p.is_deleted = FALSE'];
  const params: unknown[] = [storeId];
  if (f.lowStock === true) where.push('i.quantity <= i.low_stock_threshold');
  if (f.lowStock === false) where.push('i.quantity > i.low_stock_threshold');
  if (f.search) { params.push(likePattern(f.search)); where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
  if (f.category) { params.push(f.category); where.push(`lower(p.category) = lower($${params.length})`); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (
    await query<{ count: number }>(`SELECT COUNT(*) AS count FROM inventory i JOIN products p ON p.id = i.product_id ${clause}`, params)
  ).rows[0].count;
  params.push(f.size, (f.page - 1) * f.size);
  const rows = (
    await query(`${SELECT} ${clause} ORDER BY p.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
  ).rows;
  return buildPage(rows, f.page, f.size, total);
}

export async function getInventoryItem(storeId: number, productId: number) {
  const { rows } = await query(`${SELECT} WHERE i.store_id = $1 AND i.product_id = $2 AND p.is_deleted = FALSE`, [storeId, productId]);
  if (!rows[0]) throw notFound('Inventory record', `${storeId}/${productId}`);
  return rows[0];
}

/** Creates or updates the stock record of one product in one store (FR-03). */
export async function setStock(
  storeId: number,
  productId: number,
  input: { quantity: number; lowStockThreshold?: number },
) {
  await withTransaction(async (client) => {
    const store = await client.query('SELECT 1 FROM stores WHERE id = $1', [storeId]);
    if (!store.rowCount) throw notFound('Store', storeId);
    const product = await client.query('SELECT 1 FROM products WHERE id = $1 AND is_deleted = FALSE', [productId]);
    if (!product.rowCount) throw unprocessable('PRODUCT_NOT_FOUND', `Product ${productId} does not exist`);

    // Make sure the row exists, then lock it so the read-modify-write below is race free.
    const created = await client.query(
      `INSERT INTO inventory (product_id, store_id, quantity, low_stock_threshold)
       VALUES ($1, $2, 0, COALESCE($3, 10)) ON CONFLICT (product_id, store_id) DO NOTHING RETURNING id`,
      [productId, storeId, input.lowStockThreshold ?? null],
    );
    const current = (
      await client.query('SELECT id, quantity FROM inventory WHERE product_id = $1 AND store_id = $2 FOR UPDATE', [productId, storeId])
    ).rows[0];
    const updated = (
      await client.query(
        `UPDATE inventory SET quantity = $1, low_stock_threshold = COALESCE($2, low_stock_threshold), updated_at = now()
         WHERE id = $3 RETURNING quantity, low_stock_threshold`,
        [input.quantity, input.lowStockThreshold ?? null, current.id],
      )
    ).rows[0];

    if (created.rowCount || current.quantity !== updated.quantity) {
      const reason = created.rowCount ? 'INITIAL_STOCK' : 'MANUAL_ADJUSTMENT';
      await client.query(
        'INSERT INTO stock_movements (inventory_id, old_qty, new_qty, reason) VALUES ($1,$2,$3,$4)',
        [current.id, current.quantity, updated.quantity, reason],
      );
      getLogger().info(
        { event: 'stock_change', reason, productId, storeId, oldQuantity: current.quantity, newQuantity: updated.quantity },
        'Stock changed',
      );
    }
    await syncAlert(client, productId, storeId, updated.quantity, updated.low_stock_threshold);
  });
  return getInventoryItem(storeId, productId);
}

export async function listMovements(storeId: number, productId: number, f: { page: number; size: number }) {
  await getInventoryItem(storeId, productId);
  const base = `FROM stock_movements m JOIN inventory i ON i.id = m.inventory_id WHERE i.store_id = $1 AND i.product_id = $2`;
  const total = (await query<{ count: number }>(`SELECT COUNT(*) AS count ${base}`, [storeId, productId])).rows[0].count;
  const rows = (
    await query(
      `SELECT m.id, m.order_id AS "orderId", m.old_qty AS "oldQuantity", m.new_qty AS "newQuantity", m.reason, m.created_at AS "createdAt"
       ${base} ORDER BY m.id DESC LIMIT $3 OFFSET $4`,
      [storeId, productId, f.size, (f.page - 1) * f.size],
    )
  ).rows;
  return buildPage(rows, f.page, f.size, total);
}
