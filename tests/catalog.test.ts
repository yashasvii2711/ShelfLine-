import { api, makeProduct, makeStore, placeOrder, resetDb, setStock, setupDb, teardownDb } from './helpers';

beforeAll(setupDb);
afterAll(teardownDb);
beforeEach(resetDb);

describe('Products', () => {
  it('supports full CRUD', async () => {
    const created = await api().post('/api/products').send({ sku: 'A-1', name: 'Widget', category: 'Tools', price: 19.99 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sku: 'A-1', price: 19.99, isDeleted: false });
    const id = created.body.id;

    expect((await api().get(`/api/products/${id}`)).body.name).toBe('Widget');
    const upd = await api().put(`/api/products/${id}`).send({ name: 'Widget v2', price: 25 });
    expect(upd.body).toMatchObject({ name: 'Widget v2', price: 25, sku: 'A-1' });

    const del = await api().delete(`/api/products/${id}`);
    expect(del.body).toMatchObject({ deleted: true, mode: 'hard' });
    expect((await api().get(`/api/products/${id}`)).status).toBe(404);
  });

  it('enforces unique SKU with 409 and validates input', async () => {
    await makeProduct({ sku: 'DUP' });
    const dup = await api().post('/api/products').send({ sku: 'DUP', name: 'x', category: 'y', price: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SKU_EXISTS');

    const other = await makeProduct({ sku: 'OTHER' });
    expect((await api().put(`/api/products/${other.id}`).send({ sku: 'DUP' })).status).toBe(409);

    for (const body of [{}, { sku: '', name: 'x', category: 'y', price: 1 }, { sku: 'a', name: 'x', category: 'y', price: -1 },
      { sku: 'a', name: 'x', category: 'y', price: 1.234 }, { sku: 'a', name: 'x', category: 'y', price: '5' },
      { sku: 'a', name: 'x', category: 'y', price: 1, extra: true }]) {
      expect((await api().post('/api/products').send(body)).status).toBe(400);
    }
    expect((await api().put(`/api/products/${other.id}`).send({})).status).toBe(400);
    expect((await api().put('/api/products/9999').send({ name: 'x' })).status).toBe(404);
  });

  it('soft-deletes products that have order history (FR-01) and hides them', async () => {
    const store = await makeStore();
    const p = await makeProduct({ sku: 'KEEP' });
    await setStock(store.id, p.id, 5, 10); // below threshold -> open alert
    expect((await placeOrder(store.id, [{ productId: p.id, quantity: 1 }])).status).toBe(201);

    const del = await api().delete(`/api/products/${p.id}`);
    expect(del.body.mode).toBe('soft');
    expect((await api().get(`/api/products/${p.id}`)).status).toBe(404);
    expect((await api().get('/api/products')).body.data).toHaveLength(0);
    expect((await api().get(`/api/stores/${store.id}/inventory`)).body.data).toHaveLength(0);
    // the order history is intact and the open alert was closed
    expect((await api().get('/api/orders')).body.pagination.totalItems).toBe(1);
    expect((await api().get('/api/alerts?resolved=false')).body.data).toHaveLength(0);
    // SKU stays reserved
    expect((await api().post('/api/products').send({ sku: 'KEEP', name: 'n', category: 'c', price: 1 })).status).toBe(409);
  });

  it('paginates, filters by category and searches name/SKU (literal wildcards)', async () => {
    await makeProduct({ sku: 'SH-1', name: 'Red Shirt', category: 'Apparel' });
    await makeProduct({ sku: 'SH-2', name: 'Blue Shirt', category: 'Apparel' });
    await makeProduct({ sku: 'MUG-1', name: '100% Cotton Mug', category: 'Home' });

    expect((await api().get('/api/products?category=apparel')).body.pagination.totalItems).toBe(2);
    expect((await api().get('/api/products?search=shirt')).body.pagination.totalItems).toBe(2);
    expect((await api().get('/api/products?search=mug-1')).body.data[0].sku).toBe('MUG-1');
    expect((await api().get('/api/products?search=100%25')).body.pagination.totalItems).toBe(1);
    expect((await api().get('/api/products?search=%25')).body.pagination.totalItems).toBe(1); // matches the literal "%"
    expect((await api().get('/api/products?search=shirt&category=home')).body.data).toHaveLength(0);

    const p1 = await api().get('/api/products?size=2&page=1');
    const p2 = await api().get('/api/products?size=2&page=2');
    expect(p1.body.data).toHaveLength(2);
    expect(p2.body.data).toHaveLength(1);
    expect(p1.body.pagination).toEqual({ page: 1, size: 2, totalItems: 3, totalPages: 2 });
    expect((await api().get('/api/products?size=100')).status).toBe(200);
    expect((await api().get('/api/products?size=101')).status).toBe(400);
  });
});

describe('Stores', () => {
  it('supports CRUD, search and city filter', async () => {
    const s = await api().post('/api/stores').send({ name: 'Vadodara Central', city: 'Vadodara' });
    expect(s.status).toBe(201);
    await makeStore({ name: 'Surat Outlet', city: 'Surat' });

    expect((await api().get('/api/stores')).body.pagination.totalItems).toBe(2);
    expect((await api().get('/api/stores?city=surat')).body.data).toHaveLength(1);
    expect((await api().get('/api/stores?search=central')).body.data[0].id).toBe(s.body.id);
    expect((await api().put(`/api/stores/${s.body.id}`).send({ city: 'Baroda' })).body.city).toBe('Baroda');
    expect((await api().put(`/api/stores/${s.body.id}`).send({})).status).toBe(400);
    expect((await api().post('/api/stores').send({ name: 'x' })).status).toBe(400);
    expect((await api().get('/api/stores/9999')).status).toBe(404);
    expect((await api().put('/api/stores/9999').send({ name: 'x' })).status).toBe(404);

    expect((await api().delete(`/api/stores/${s.body.id}`)).status).toBe(200);
    expect((await api().delete(`/api/stores/${s.body.id}`)).status).toBe(404);
  });

  it('refuses to delete a store with order history', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 5, 0);
    await placeOrder(store.id, [{ productId: p.id, quantity: 1 }]);
    const res = await api().delete(`/api/stores/${store.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STORE_HAS_ORDERS');
  });

  it('deleting a store without orders removes its stock records', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 5, 10);
    expect((await api().delete(`/api/stores/${store.id}`)).status).toBe(200);
    expect((await api().get('/api/alerts')).body.data).toHaveLength(0);
  });
});

describe('Inventory', () => {
  it('sets, updates and views stock per product per store (FR-03)', async () => {
    const s1 = await makeStore();
    const s2 = await makeStore();
    const p = await makeProduct({ category: 'Apparel', name: 'Hat' });

    const first = await api().put(`/api/stores/${s1.id}/inventory/${p.id}`).send({ quantity: 30 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ quantity: 30, lowStockThreshold: 10, isLowStock: false, storeId: s1.id });

    // threshold survives when omitted; one record per product-store pair
    await api().put(`/api/stores/${s1.id}/inventory/${p.id}`).send({ quantity: 40, lowStockThreshold: 15 });
    const kept = await api().put(`/api/stores/${s1.id}/inventory/${p.id}`).send({ quantity: 41 });
    expect(kept.body).toMatchObject({ quantity: 41, lowStockThreshold: 15 });
    expect((await api().get(`/api/stores/${s1.id}/inventory`)).body.pagination.totalItems).toBe(1);
    expect((await api().get(`/api/stores/${s2.id}/inventory`)).body.pagination.totalItems).toBe(0);

    expect((await api().get(`/api/stores/${s1.id}/inventory?search=hat&category=apparel`)).body.data).toHaveLength(1);
    expect((await api().get(`/api/stores/${s1.id}/inventory/${p.id}`)).status).toBe(200);
    expect((await api().get(`/api/stores/${s2.id}/inventory/${p.id}`)).status).toBe(404);
  });

  it('validates input and references', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    for (const body of [{}, { quantity: -1 }, { quantity: 1.5 }, { quantity: 'a' }, { quantity: 1, lowStockThreshold: -2 }, { quantity: 1, foo: 1 }]) {
      expect((await api().put(`/api/stores/${store.id}/inventory/${p.id}`).send(body)).status).toBe(400);
    }
    expect((await api().put(`/api/stores/9999/inventory/${p.id}`).send({ quantity: 1 })).status).toBe(404);
    expect((await api().put(`/api/stores/${store.id}/inventory/9999`).send({ quantity: 1 })).status).toBe(422);
    expect((await api().get('/api/stores/9999/inventory')).status).toBe(404);
    expect((await api().get(`/api/stores/${store.id}/inventory?lowStock=maybe`)).status).toBe(400);
  });

  it('records an audit trail of every stock change (FR-11)', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 10, 0);
    await setStock(store.id, p.id, 15);
    await setStock(store.id, p.id, 15); // no change -> no movement
    const order = (await placeOrder(store.id, [{ productId: p.id, quantity: 5 }])).body;
    await api().post(`/api/orders/${order.id}/cancel`);

    const res = await api().get(`/api/stores/${store.id}/inventory/${p.id}/movements`);
    expect(res.status).toBe(200);
    const rows = res.body.data.map((m: any) => [m.reason, m.oldQuantity, m.newQuantity]);
    expect(rows).toEqual([
      ['ORDER_CANCELLED', 10, 15],
      ['ORDER_PLACED', 15, 10],
      ['MANUAL_ADJUSTMENT', 10, 15],
      ['INITIAL_STOCK', 0, 10],
    ]);
    expect(res.body.data[0].orderId).toBe(order.id);
  });
});
