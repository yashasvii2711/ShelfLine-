import { api, makeProduct, makeStore, placeOrder, resetDb, setStock, setupDb, teardownDb } from './helpers';

beforeAll(setupDb);
afterAll(teardownDb);
beforeEach(resetDb);

describe('Order placement', () => {
  it('places a multi-item order, decrements stock and snapshots unit prices (BR-3)', async () => {
    const store = await makeStore();
    const a = await makeProduct({ price: 250.5 });
    const b = await makeProduct({ price: 10 });
    await setStock(store.id, a.id, 10, 1);
    await setStock(store.id, b.id, 10, 1);

    const res = await placeOrder(store.id, [{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 3 }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'CONFIRMED', storeId: store.id, totalAmount: 531 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ productId: a.id, quantity: 2, unitPrice: 250.5, lineTotal: 501 });

    expect((await api().get(`/api/stores/${store.id}/inventory/${a.id}`)).body.quantity).toBe(8);

    // later price change must not affect the stored order
    await api().put(`/api/products/${a.id}`).send({ price: 999 });
    const again = await api().get(`/api/orders/${res.body.id}`);
    expect(again.body.items[0].unitPrice).toBe(250.5);
    expect(again.body.totalAmount).toBe(531);
  });

  it('rejects invalid bodies with 400 (BR-2, BR-6)', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 10);
    const bad: unknown[] = [
      { storeId: store.id, items: [] },
      { storeId: store.id },
      { storeId: store.id, items: [{ productId: p.id, quantity: 0 }] },
      { storeId: store.id, items: [{ productId: p.id, quantity: -1 }] },
      { storeId: store.id, items: [{ productId: p.id, quantity: 1.5 }] },
      { storeId: store.id, items: [{ productId: p.id, quantity: '2' }] },
      { storeId: 'x', items: [{ productId: p.id, quantity: 1 }] },
    ];
    for (const body of bad) {
      const res = await api().post('/api/orders').send(body as object);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const dup = await placeOrder(store.id, [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 2 }]);
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('DUPLICATE_PRODUCT');
    expect((await api().get(`/api/stores/${store.id}/inventory/${p.id}`)).body.quantity).toBe(10);
  });

  it('returns 422 for unknown store or product, 409 when no stock record exists', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    expect((await placeOrder(9999, [{ productId: p.id, quantity: 1 }])).status).toBe(422);
    expect((await placeOrder(store.id, [{ productId: 9999, quantity: 1 }])).status).toBe(422);
    const noStock = await placeOrder(store.id, [{ productId: p.id, quantity: 1 }]);
    expect(noStock.status).toBe(409);
    expect(noStock.body.error.details.available).toBe(0);
  });

  it('cannot order a soft-deleted product', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 5);
    expect((await placeOrder(store.id, [{ productId: p.id, quantity: 1 }])).status).toBe(201);
    await api().delete(`/api/products/${p.id}`);
    expect((await placeOrder(store.id, [{ productId: p.id, quantity: 1 }])).status).toBe(422);
  });
});

describe('Order cancellation', () => {
  it('restocks on cancel and refuses a second cancel (FR-06, BR-5)', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 10, 2);
    const order = (await placeOrder(store.id, [{ productId: p.id, quantity: 9 }])).body;

    const cancelled = await api().post(`/api/orders/${order.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect((await api().get(`/api/stores/${store.id}/inventory/${p.id}`)).body.quantity).toBe(10);

    const again = await api().post(`/api/orders/${order.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    expect((await api().get(`/api/stores/${store.id}/inventory/${p.id}`)).body.quantity).toBe(10);
  });

  it('returns 404 for unknown orders and 400 for malformed ids', async () => {
    expect((await api().post('/api/orders/9999/cancel')).status).toBe(404);
    expect((await api().get('/api/orders/9999')).status).toBe(404);
    expect((await api().get('/api/orders/abc')).status).toBe(400);
  });
});

describe('Order listing', () => {
  it('filters by store, status and date range with pagination', async () => {
    const s1 = await makeStore({ name: 'S1' });
    const s2 = await makeStore({ name: 'S2' });
    const p = await makeProduct();
    await setStock(s1.id, p.id, 100, 0);
    await setStock(s2.id, p.id, 100, 0);
    const o1 = (await placeOrder(s1.id, [{ productId: p.id, quantity: 1 }])).body;
    await placeOrder(s1.id, [{ productId: p.id, quantity: 1 }]);
    await placeOrder(s2.id, [{ productId: p.id, quantity: 1 }]);
    await api().post(`/api/orders/${o1.id}/cancel`);

    expect((await api().get(`/api/orders?storeId=${s1.id}`)).body.pagination.totalItems).toBe(2);
    expect((await api().get('/api/orders?status=CANCELLED')).body.data).toHaveLength(1);
    expect((await api().get('/api/orders?status=CONFIRMED')).body.pagination.totalItems).toBe(2);

    const today = new Date().toISOString().slice(0, 10);
    expect((await api().get(`/api/orders?from=${today}&to=${today}`)).body.pagination.totalItems).toBe(3);
    expect((await api().get('/api/orders?to=2000-01-01')).body.pagination.totalItems).toBe(0);

    const page = await api().get('/api/orders?size=2&page=2');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.pagination).toEqual({ page: 2, size: 2, totalItems: 3, totalPages: 2 });
    expect(page.body.data[0].itemCount).toBe(1);
  });

  it('rejects bad filters', async () => {
    for (const qs of ['status=NOPE', 'from=yesterday', 'storeId=abc', 'size=101', 'size=0', 'page=0']) {
      expect((await api().get(`/api/orders?${qs}`)).status).toBe(400);
    }
  });
});
