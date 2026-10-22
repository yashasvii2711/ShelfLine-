import { api, makeProduct, makeStore, placeOrder, resetDb, setStock, setupDb, teardownDb } from './helpers';

beforeAll(setupDb);
afterAll(teardownDb);
beforeEach(resetDb);

const openAlerts = async (storeId: number) => (await api().get(`/api/alerts?resolved=false&storeId=${storeId}`)).body.data;

describe('Low-stock alerts (FR-07, BR-4)', () => {
  it('opens an alert when stock drops to the threshold, only once, and resolves on replenishment', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 12, 5);
    expect(await openAlerts(store.id)).toHaveLength(0);

    await placeOrder(store.id, [{ productId: p.id, quantity: 6 }]); // 6 > 5: no alert
    expect(await openAlerts(store.id)).toHaveLength(0);

    await placeOrder(store.id, [{ productId: p.id, quantity: 1 }]); // 5 <= 5: alert
    let open = await openAlerts(store.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ productId: p.id, storeId: store.id, quantityAtAlert: 5, resolved: false, resolvedAt: null });

    await placeOrder(store.id, [{ productId: p.id, quantity: 2 }]); // still low: no duplicate
    await placeOrder(store.id, [{ productId: p.id, quantity: 1 }]);
    open = await openAlerts(store.id);
    expect(open).toHaveLength(1);
    expect(open[0].quantityAtAlert).toBe(5);

    await setStock(store.id, p.id, 50); // replenish above threshold -> auto-resolve
    expect(await openAlerts(store.id)).toHaveLength(0);
    const resolved = (await api().get('/api/alerts?resolved=true')).body.data;
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolvedAt).toBeTruthy();

    await setStock(store.id, p.id, 3); // drops again -> a new alert
    expect(await openAlerts(store.id)).toHaveLength(1);
    expect((await api().get('/api/alerts')).body.pagination.totalItems).toBe(2);
  });

  it('raises an alert immediately when stock is set at or below the threshold', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 10); // default threshold is 10 -> 10 <= 10
    const open = await openAlerts(store.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ sku: p.sku, storeName: 'Test Store' });
  });

  it('reacts to threshold changes', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 20, 5);
    await setStock(store.id, p.id, 20, 25); // threshold above stock -> alert
    expect(await openAlerts(store.id)).toHaveLength(1);
    await setStock(store.id, p.id, 20, 5); // threshold lowered -> resolved
    expect(await openAlerts(store.id)).toHaveLength(0);
  });

  it('resolves the alert when a cancelled order restores stock above the threshold', async () => {
    const store = await makeStore();
    const p = await makeProduct();
    await setStock(store.id, p.id, 20, 5);
    const order = (await placeOrder(store.id, [{ productId: p.id, quantity: 18 }])).body;
    expect(await openAlerts(store.id)).toHaveLength(1);
    await api().post(`/api/orders/${order.id}/cancel`);
    expect(await openAlerts(store.id)).toHaveLength(0);
  });

  it('exposes low stock via the inventory lowStock filter and filters alerts', async () => {
    const s1 = await makeStore();
    const s2 = await makeStore();
    const low = await makeProduct();
    const ok = await makeProduct();
    await setStock(s1.id, low.id, 2, 5);
    await setStock(s1.id, ok.id, 100, 5);
    await setStock(s2.id, low.id, 1, 5);

    const lowList = (await api().get(`/api/stores/${s1.id}/inventory?lowStock=true`)).body.data;
    expect(lowList).toHaveLength(1);
    expect(lowList[0]).toMatchObject({ productId: low.id, isLowStock: true });
    expect((await api().get(`/api/stores/${s1.id}/inventory?lowStock=false`)).body.data[0].productId).toBe(ok.id);

    expect((await api().get(`/api/alerts?storeId=${s2.id}`)).body.data).toHaveLength(1);
    expect((await api().get(`/api/alerts?productId=${low.id}&resolved=false`)).body.pagination.totalItems).toBe(2);
    expect((await api().get('/api/alerts?resolved=maybe')).status).toBe(400);
  });
});
