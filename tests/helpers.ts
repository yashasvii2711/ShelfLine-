import request from 'supertest';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { closePool, query } from '../src/db/pool';

export const app = createApp();

export const ADMIN = { name: 'Test Manager', email: 'manager@test.dev', password: 'Passw0rd!1' };
let token = '';
export const authHeader = () => `Bearer ${token}`;
export const bearer = (t: string) => `Bearer ${t}`;

/** Supertest client that is signed in as the manager. Use rawApi() for unauthenticated calls. */
export const api = () => ({
  get: (u: string) => request(app).get(u).set('Authorization', authHeader()),
  post: (u: string) => request(app).post(u).set('Authorization', authHeader()),
  put: (u: string) => request(app).put(u).set('Authorization', authHeader()),
  delete: (u: string) => request(app).delete(u).set('Authorization', authHeader()),
});
export const rawApi = () => request(app);

/** Creates a staff account (the manager must already exist) and returns its bearer token. */
export async function staffToken(email = 'staff@test.dev'): Promise<string> {
  const res = await request(app).post('/api/auth/signup').send({ name: 'Test Staff', email, password: 'Passw0rd!2' });
  if (res.status !== 201) throw new Error(`staffToken failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

export async function setupDb() {
  await runMigrations();
  await resetDb();
}

export async function resetDb() {
  await query(
    'TRUNCATE sessions, users, stock_movements, alerts, order_items, orders, inventory, products, stores RESTART IDENTITY CASCADE',
  );
  // The first account created is always the manager
  const res = await request(app).post('/api/auth/signup').send(ADMIN);
  if (res.status !== 201) throw new Error(`admin signup failed: ${JSON.stringify(res.body)}`);
  token = res.body.token;
}

export const teardownDb = () => closePool();

let counter = 0;
export async function makeProduct(overrides: Record<string, unknown> = {}) {
  counter++;
  const res = await api()
    .post('/api/products')
    .send({ sku: `SKU-${Date.now()}-${counter}`, name: `Product ${counter}`, category: 'General', price: 100, ...overrides });
  if (res.status !== 201) throw new Error(`makeProduct failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: number; sku: string; price: number };
}

export async function makeStore(overrides: Record<string, unknown> = {}) {
  const res = await api().post('/api/stores').send({ name: 'Test Store', city: 'Surat', ...overrides });
  if (res.status !== 201) throw new Error(`makeStore failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: number };
}

export async function setStock(storeId: number, productId: number, quantity: number, lowStockThreshold?: number) {
  const res = await api()
    .put(`/api/stores/${storeId}/inventory/${productId}`)
    .send({ quantity, ...(lowStockThreshold !== undefined && { lowStockThreshold }) });
  if (res.status !== 200) throw new Error(`setStock failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export const placeOrder = (storeId: number, items: { productId: number; quantity: number }[]) =>
  api().post('/api/orders').send({ storeId, items });
