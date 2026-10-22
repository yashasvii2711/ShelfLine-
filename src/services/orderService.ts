import { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { getLogger } from '../utils/logger';
import { buildPage } from '../utils/pagination';
import { syncAlert } from './alertService';

export interface OrderItemInput { productId: number; quantity: number }

interface StockChange { productId: number; storeId: number; oldQuantity: number; newQuantity: number; reason: string; orderId: number }

const ORDER_COLS = `o.id, o.store_id AS "storeId", o.status, o.total_amount AS "totalAmount",
  o.created_at AS "createdAt", o.cancelled_at AS "cancelledAt"`;

/**
 * Places an order. All items are decremented in ONE transaction using a conditional UPDATE
 * (`... WHERE quantity >= :qty`). Postgres row-locks the inventory row for the duration of the
 * transaction, so concurrent orders for the same item queue up and each sees the committed
 * result of the previous one: stock can never go negative. Items are processed in ascending
 * product-id order so two multi-item orders can never deadlock each other.
 */
export async function placeOrder(storeId: number, items: OrderItemInput[]) {
  const changes: StockChange[] = [];

  const orderId = await withTransaction(async (client) => {
    changes.length = 0; // in case the transaction is retried
    const store = await client.query('SELECT 1 FROM stores WHERE id = $1', [storeId]);
    if (!store.rowCount) throw unprocessable('STORE_NOT_FOUND', `Store ${storeId} does not exist`);

    const sorted = [...items].sort((a, b) => a.productId - b.productId);
    const ids = sorted.map((i) => i.productId);
    const products = (
      await client.query<{ id: number; price: number }>(
        'SELECT id, price FROM products WHERE id = ANY($1::int[]) AND is_deleted = FALSE',
        [ids],
      )
    ).rows;
    const priceById = new Map(products.map((p) => [p.id, p.price]));
    const missing = ids.filter((id) => !priceById.has(id));
    if (missing.length) throw unprocessable('PRODUCT_NOT_FOUND', `Unknown or deleted product(s): ${missing.join(', ')}`, { productIds: missing });

    const totalCents = sorted.reduce((sum, i) => sum + Math.round(priceById.get(i.productId)! * 100) * i.quantity, 0);
    const order = (
      await client.query<{ id: number }>(
        `INSERT INTO orders (store_id, status, total_amount) VALUES ($1, 'CONFIRMED', $2) RETURNING id`,
        [storeId, totalCents / 100],
      )
    ).rows[0];

    for (const item of sorted) {
      const upd = await client.query<{ id: number; quantity: number; low_stock_threshold: number }>(
        `UPDATE inventory SET quantity = quantity - $1, updated_at = now()
         WHERE product_id = $2 AND store_id = $3 AND quantity >= $1
         RETURNING id, quantity, low_stock_threshold`,
        [item.quantity, item.productId, storeId],
      );
      if (!upd.rowCount) {
        const cur = await client.query<{ quantity: number }>(
          'SELECT quantity FROM inventory WHERE product_id = $1 AND store_id = $2',
          [item.productId, storeId],
        );
        throw conflict('INSUFFICIENT_STOCK', `Insufficient stock for product ${item.productId} in store ${storeId}`, {
          productId: item.productId,
          requested: item.quantity,
          available: cur.rows[0]?.quantity ?? 0,
        });
      }
      const row = upd.rows[0];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`,
        [order.id, item.productId, item.quantity, priceById.get(item.productId)],
      );
      await client.query(
        `INSERT INTO stock_movements (inventory_id, order_id, old_qty, new_qty, reason) VALUES ($1,$2,$3,$4,'ORDER_PLACED')`,
        [row.id, order.id, row.quantity + item.quantity, row.quantity],
      );
      await syncAlert(client, item.productId, storeId, row.quantity, row.low_stock_threshold);
      changes.push({ productId: item.productId, storeId, oldQuantity: row.quantity + item.quantity, newQuantity: row.quantity, reason: 'ORDER_PLACED', orderId: order.id });
    }
    return order.id;
  });

  logChanges(changes);
  return getOrder(orderId);
}

/** Cancels a CONFIRMED order and returns its items to stock (FR-06, BR-5). */
export async function cancelOrder(orderId: number) {
  const changes: StockChange[] = [];
  await withTransaction(async (client) => {
    changes.length = 0;
    const order = (
      await client.query<{ id: number; store_id: number; status: string }>(
        'SELECT id, store_id, status FROM orders WHERE id = $1 FOR UPDATE',
        [orderId],
      )
    ).rows[0];
    if (!order) throw notFound('Order', orderId);
    if (order.status !== 'CONFIRMED') {
      throw conflict('ORDER_NOT_CANCELLABLE', `Order ${orderId} is ${order.status} and cannot be cancelled`);
    }
    await client.query(`UPDATE orders SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [orderId]);

    const items = (
      await client.query<{ product_id: number; quantity: number }>(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id',
        [orderId],
      )
    ).rows;
    for (const item of items) {
      const row = await restock(client, item.product_id, order.store_id, item.quantity);
      await client.query(
        `INSERT INTO stock_movements (inventory_id, order_id, old_qty, new_qty, reason) VALUES ($1,$2,$3,$4,'ORDER_CANCELLED')`,
        [row.id, orderId, row.quantity - item.quantity, row.quantity],
      );
      await syncAlert(client, item.product_id, order.store_id, row.quantity, row.low_stock_threshold);
      changes.push({ productId: item.product_id, storeId: order.store_id, oldQuantity: row.quantity - item.quantity, newQuantity: row.quantity, reason: 'ORDER_CANCELLED', orderId });
    }
  });
  logChanges(changes);
  return getOrder(orderId);
}

async function restock(client: PoolClient, productId: number, storeId: number, qty: number) {
  // Upsert so restocking still works if the inventory row was removed in the meantime
  const res = await client.query<{ id: number; quantity: number; low_stock_threshold: number }>(
    `INSERT INTO inventory (product_id, store_id, quantity) VALUES ($1,$2,$3)
     ON CONFLICT (product_id, store_id)
     DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = now()
     RETURNING id, quantity, low_stock_threshold`,
    [productId, storeId, qty],
  );
  return res.rows[0];
}

function logChanges(changes: StockChange[]) {
  const log = getLogger();
  for (const c of changes) log.info({ event: 'stock_change', ...c }, 'Stock changed');
}

export async function getOrder(id: number) {
  const order = (await query(`SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1`, [id])).rows[0];
  if (!order) throw notFound('Order', id);
  const items = (
    await query(
      `SELECT oi.product_id AS "productId", p.sku, p.name, oi.quantity, oi.unit_price AS "unitPrice",
              ROUND(oi.quantity * oi.unit_price, 2)::float8 AS "lineTotal"
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.product_id`,
      [id],
    )
  ).rows;
  return { ...order, items };
}

export interface OrderFilters { storeId?: number; status?: string; from?: string; to?: string; page: number; size: number }

export async function listOrders(f: OrderFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.storeId) { params.push(f.storeId); where.push(`o.store_id = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`o.status = $${params.length}`); }
  if (f.from) { params.push(f.from); where.push(`o.created_at >= $${params.length}::timestamptz`); }
  if (f.to) {
    params.push(f.to);
    // a date-only "to" includes that whole day
    where.push(/^\d{4}-\d{2}-\d{2}$/.test(f.to)
      ? `o.created_at < ($${params.length}::date + 1)::timestamptz`
      : `o.created_at <= $${params.length}::timestamptz`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query<{ count: number }>(`SELECT COUNT(*) AS count FROM orders o ${clause}`, params)).rows[0].count;
  params.push(f.size, (f.page - 1) * f.size);
  const rows = (
    await query(
      `SELECT ${ORDER_COLS}, (SELECT COALESCE(SUM(quantity),0)::int FROM order_items WHERE order_id = o.id) AS "itemCount"
       FROM orders o ${clause} ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
  ).rows;
  return buildPage(rows, f.page, f.size, total);
}
