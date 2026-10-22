import { api, makeProduct, makeStore, placeOrder, resetDb, setStock, setupDb, teardownDb } from './helpers';
import { query } from '../src/db/pool';

beforeAll(setupDb);
afterAll(teardownDb);
beforeEach(resetDb);

describe('Concurrency safety (FR-05)', () => {
  it('50 concurrent single-unit orders against 10 units: exactly 10 succeed, 40 get 409, stock ends at 0', async () => {
    const store = await makeStore();
    const product = await makeProduct();
    await setStock(store.id, product.id, 10, 2);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => placeOrder(store.id, [{ productId: product.id, quantity: 1 }])),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(10);
    expect(conflicts).toHaveLength(40);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    conflicts.forEach((r) => expect(r.body.error.code).toBe('INSUFFICIENT_STOCK'));

    const stock = await api().get(`/api/stores/${store.id}/inventory/${product.id}`);
    expect(stock.body.quantity).toBe(0);

    // Exactly 10 persisted orders, no orphan data from the 40 failed ones
    expect((await query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n).toBe(10);
    expect((await query('SELECT COUNT(*)::int AS n FROM order_items')).rows[0].n).toBe(10);
    // Audit trail: 1 initial + 10 order movements, and a single open alert
    expect((await query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE reason = 'ORDER_PLACED'`)).rows[0].n).toBe(10);
    const alerts = await api().get(`/api/alerts?resolved=false&storeId=${store.id}`);
    expect(alerts.body.data).toHaveLength(1);
  });

  it('concurrent multi-item orders with opposite item order do not deadlock and never oversell', async () => {
    const store = await makeStore();
    const a = await makeProduct();
    const b = await makeProduct();
    await setStock(store.id, a.id, 20, 0);
    await setStock(store.id, b.id, 20, 0);

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        placeOrder(store.id, i % 2 === 0
          ? [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }]
          : [{ productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }]),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(results.filter((r) => r.status === 409)).toHaveLength(20);
    expect(results.some((r) => r.status === 500)).toBe(false);

    for (const p of [a, b]) {
      const s = await api().get(`/api/stores/${store.id}/inventory/${p.id}`);
      expect(s.body.quantity).toBe(0);
    }
  });

  it('a multi-item order where only the last item lacks stock rolls back the earlier items', async () => {
    const store = await makeStore();
    const a = await makeProduct();
    const b = await makeProduct();
    await setStock(store.id, a.id, 5, 0);
    await setStock(store.id, b.id, 1, 0);

    const res = await placeOrder(store.id, [{ productId: a.id, quantity: 3 }, { productId: b.id, quantity: 2 }]);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ productId: b.id, requested: 2, available: 1 });

    expect((await api().get(`/api/stores/${store.id}/inventory/${a.id}`)).body.quantity).toBe(5);
    expect((await api().get('/api/orders')).body.pagination.totalItems).toBe(0);
  });

  it('concurrent cancel requests for the same order restock exactly once', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 10, 0);
    const order = (await placeOrder(store.id, [{ productId: p.id, quantity: 4 }])).body;

    const results = await Promise.all(Array.from({ length: 10 }, () => api().post(`/api/orders/${order.id}/cancel`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await api().get(`/api/stores/${store.id}/inventory/${p.id}`)).body.quantity).toBe(10);
  });
});
