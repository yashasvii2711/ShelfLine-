import { closePool, query, withTransaction } from './pool';
import { runMigrations } from './migrate';
import { signup } from '../services/authService';
import { logger } from '../utils/logger';

/** Seeds the three stores from the brief, a handful of products and starting stock. Safe to re-run. */
async function seed() {
  await runMigrations();
  await withTransaction(async (c) => {
    for (const [name, city] of [['Vadodara Central', 'Vadodara'], ['Surat Mall Outlet', 'Surat'], ['Ahmedabad Flagship', 'Ahmedabad']]) {
      await c.query('INSERT INTO stores (name, city) SELECT $1::varchar, $2::varchar WHERE NOT EXISTS (SELECT 1 FROM stores WHERE name = $1::varchar)', [name, city]);
    }
    const products: [string, string, string, number][] = [
      ['TSH-BLK-M', 'Black T-Shirt (M)', 'Apparel', 499],
      ['JNS-BLU-32', 'Blue Jeans (32)', 'Apparel', 1499],
      ['SNK-WHT-9', 'White Sneakers (9)', 'Footwear', 2999],
      ['BAG-LEA-01', 'Leather Backpack', 'Accessories', 3499],
      ['WTR-BTL-1L', 'Steel Water Bottle 1L', 'Home', 599],
    ];
    for (const [sku, name, category, price] of products) {
      await c.query('INSERT INTO products (sku, name, category, price) VALUES ($1,$2,$3,$4) ON CONFLICT (sku) DO NOTHING', [sku, name, category, price]);
    }
    await c.query(`
      INSERT INTO inventory (product_id, store_id, quantity, low_stock_threshold)
      SELECT p.id, s.id, 20 + (p.id * 7 + s.id * 11) % 40, 10 FROM products p CROSS JOIN stores s
      ON CONFLICT (product_id, store_id) DO NOTHING`);
  });
  // Demo accounts for local use ONLY. Skipped when NODE_ENV=production unless SEED_DEMO_ACCOUNTS=true.
  const demo = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_ACCOUNTS === 'true';
  if (!demo) logger.info('Production mode: skipping demo accounts (set SEED_DEMO_ACCOUNTS=true to create them)');
  for (const [name, email, password, role] of [
    ['Demo Manager', 'manager@shelfline.test', 'Manager#2026', 'manager'],
    ['Demo Staff', 'staff@shelfline.test', 'Staff#2026', 'staff'],
  ] as const) {
    if (!demo) break;
    await signup({ name, email, password }, role).catch((e) => { if (e.code !== 'EMAIL_EXISTS') throw e; });
  }
  const counts = (await query('SELECT (SELECT COUNT(*) FROM stores) AS stores, (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM inventory) AS inventory')).rows[0];
  logger.info(counts, 'Seed complete');
}

seed().catch((e) => { logger.error({ err: e }, 'Seed failed'); process.exitCode = 1; }).finally(closePool);
