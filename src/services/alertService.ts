import { PoolClient } from 'pg';
import { query } from '../db/pool';
import { getLogger } from '../utils/logger';
import { buildPage } from '../utils/pagination';

/**
 * Keeps the alerts table consistent with an inventory row. Must be called inside the same
 * transaction that changed the inventory quantity or threshold.
 *  - quantity <= threshold: open an alert (a partial unique index guarantees at most one open
 *    alert per product/store, so concurrent callers cannot create duplicates)
 *  - quantity >  threshold: resolve any open alert
 */
export async function syncAlert(
  client: PoolClient,
  productId: number,
  storeId: number,
  quantity: number,
  threshold: number,
): Promise<void> {
  if (quantity <= threshold) {
    const res = await client.query(
      `INSERT INTO alerts (product_id, store_id, quantity_at_alert)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, store_id) WHERE resolved = FALSE DO NOTHING`,
      [productId, storeId, quantity],
    );
    if (res.rowCount) {
      getLogger().warn({ event: 'low_stock_alert_created', productId, storeId, quantity, threshold }, 'Low stock alert created');
    }
  } else {
    const res = await client.query(
      `UPDATE alerts SET resolved = TRUE, resolved_at = now()
       WHERE product_id = $1 AND store_id = $2 AND resolved = FALSE`,
      [productId, storeId],
    );
    if (res.rowCount) {
      getLogger().info({ event: 'low_stock_alert_resolved', productId, storeId, quantity, threshold }, 'Low stock alert resolved');
    }
  }
}

export interface AlertFilters {
  resolved?: boolean;
  storeId?: number;
  productId?: number;
  page: number;
  size: number;
}

export async function listAlerts(f: AlertFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.resolved !== undefined) { params.push(f.resolved); where.push(`a.resolved = $${params.length}`); }
  if (f.storeId) { params.push(f.storeId); where.push(`a.store_id = $${params.length}`); }
  if (f.productId) { params.push(f.productId); where.push(`a.product_id = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (await query<{ count: number }>(`SELECT COUNT(*) AS count FROM alerts a ${clause}`, params)).rows[0].count;
  params.push(f.size, (f.page - 1) * f.size);
  const rows = (
    await query(
      `SELECT a.id, a.product_id AS "productId", p.sku, p.name AS "productName",
              a.store_id AS "storeId", s.name AS "storeName",
              a.quantity_at_alert AS "quantityAtAlert", a.resolved,
              a.created_at AS "createdAt", a.resolved_at AS "resolvedAt"
       FROM alerts a
       JOIN products p ON p.id = a.product_id
       JOIN stores s ON s.id = a.store_id
       ${clause}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
  ).rows;
  return buildPage(rows, f.page, f.size, total);
}
