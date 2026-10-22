import request from 'supertest';
import { createApp } from '../src/app';
import { query } from '../src/db/pool';
import { ADMIN, api, app, authHeader, bearer, makeProduct, makeStore, placeOrder, rawApi, resetDb, setStock, setupDb, staffToken, teardownDb } from './helpers';

beforeAll(setupDb);
afterAll(teardownDb);
beforeEach(resetDb);

describe('Sign up & sign in', () => {
  it('makes the first account a manager and later accounts staff', async () => {
    const me = await rawApi().get('/api/auth/me').set('Authorization', authHeader());
    expect(me.body.user).toMatchObject({ email: ADMIN.email, role: 'manager' });
    const second = await rawApi().post('/api/auth/signup').send({ name: 'Sam', email: 'sam@test.dev', password: 'Passw0rd!3' });
    expect(second.status).toBe(201);
    expect(second.body.user.role).toBe('staff');
    expect(second.body.token).toBeTruthy();
    expect(JSON.stringify(second.body)).not.toMatch(/password/i);
  });

  it('validates signup input and rejects duplicate emails (case-insensitive)', async () => {
    const bad = [
      { name: 'A', email: 'nope', password: 'Passw0rd!' },
      { name: 'A', email: 'a@test.dev', password: 'short1' },
      { name: 'A', email: 'a@test.dev', password: 'onlyletters' },
      { name: 'A', email: 'a@test.dev', password: '12345678' },
      { name: '', email: 'a@test.dev', password: 'Passw0rd!' },
      { name: 'A', email: 'a@test.dev', password: 'Passw0rd!', role: 'manager' },
    ];
    for (const body of bad) expect((await rawApi().post('/api/auth/signup').send(body)).status).toBe(400);
    const dup = await rawApi().post('/api/auth/signup').send({ ...ADMIN, email: ADMIN.email.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_EXISTS');
  });

  it('stores only a salted hash, never the password', async () => {
    const row = (await query('SELECT password_hash FROM users WHERE email = $1', [ADMIN.email])).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(row.password_hash).not.toContain(ADMIN.password);
  });

  it('logs in with correct credentials; wrong password and unknown email give the same 401', async () => {
    const ok = await rawApi().post('/api/auth/login').send({ email: ADMIN.email.toUpperCase(), password: ADMIN.password });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('manager');
    const wrong = await rawApi().post('/api/auth/login').send({ email: ADMIN.email, password: 'Wrong#Pass1' });
    const unknown = await rawApi().post('/api/auth/login').send({ email: 'ghost@test.dev', password: 'Wrong#Pass1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect((await rawApi().post('/api/auth/login').send({ email: ADMIN.email })).status).toBe(400);
  });

  it('sets an httpOnly session cookie that works without an Authorization header, and logout ends the session', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: ADMIN.email, password: ADMIN.password });
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await agent.get('/api/products')).status).toBe(200);
    expect((await agent.post('/api/auth/logout')).status).toBe(200);
    expect((await agent.get('/api/products')).status).toBe(401);
    // the bearer token from the same login is dead as well
    expect((await rawApi().get('/api/products').set('Authorization', bearer(login.body.token))).status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    await query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    const res = await rawApi().get('/api/products').set('Authorization', authHeader());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('rate limits sign-in attempts', async () => {
    const strict = request(createApp({ authRateLimit: { windowMs: 60_000, max: 3 } }));
    for (let i = 0; i < 3; i++) expect((await strict.post('/api/auth/login').send({ email: ADMIN.email, password: 'Wrong#Pass1' })).status).toBe(401);
    expect((await strict.post('/api/auth/login').send({ email: ADMIN.email, password: ADMIN.password })).status).toBe(429);
  });
});

describe('Protected API and roles', () => {
  it('requires a session for every /api endpoint but keeps health, docs and the UI public', async () => {
    for (const [method, url] of [['get', '/api/products'], ['get', '/api/stores'], ['get', '/api/orders'], ['get', '/api/alerts'], ['post', '/api/orders'], ['get', '/api/users']] as const) {
      const res = await (rawApi() as any)[method](url);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect((await rawApi().get('/api/products').set('Authorization', 'Bearer garbage')).status).toBe(401);
    expect((await rawApi().get('/health')).status).toBe(200);
    expect((await rawApi().get('/')).status).toBe(200);
    expect((await rawApi().get('/api/auth/config')).status).toBe(200);
  });

  it('lets staff view data and place orders, but not change catalogue, stock levels or cancel orders', async () => {
    const store = await makeStore();
    const product = await makeProduct();
    await setStock(store.id, product.id, 20, 2);
    const t = bearer(await staffToken());
    const as = (m: 'get' | 'post' | 'put' | 'delete', u: string) => (request(app) as any)[m](u).set('Authorization', t);

    expect((await as('get', '/api/products')).status).toBe(200);
    expect((await as('get', `/api/stores/${store.id}/inventory`)).status).toBe(200);
    const order = await as('post', '/api/orders').send({ storeId: store.id, items: [{ productId: product.id, quantity: 1 }] });
    expect(order.status).toBe(201);

    const forbidden = [
      as('post', '/api/products').send({ sku: 'X', name: 'x', category: 'y', price: 1 }),
      as('put', `/api/products/${product.id}`).send({ price: 5 }),
      as('delete', `/api/products/${product.id}`),
      as('post', '/api/stores').send({ name: 'x', city: 'y' }),
      as('put', `/api/stores/${store.id}`).send({ name: 'x' }),
      as('delete', `/api/stores/${store.id}`),
      as('put', `/api/stores/${store.id}/inventory/${product.id}`).send({ quantity: 999 }),
      as('post', `/api/orders/${order.body.id}/cancel`),
      as('get', '/api/users'),
    ];
    for (const res of await Promise.all(forbidden)) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect((await api().get(`/api/stores/${store.id}/inventory/${product.id}`)).body.quantity).toBe(19);
  });
});

describe('Invite code and team management', () => {
  it('requires the invite code for new accounts once one is configured', async () => {
    const { config } = await import('../src/config');
    config.signupCode = 'SHELF-2026';
    try {
      expect((await rawApi().get('/api/auth/config')).body).toEqual({ firstUser: false, inviteRequired: true });
      const body = { name: 'New', email: 'new@test.dev', password: 'Passw0rd!4' };
      const missing = await rawApi().post('/api/auth/signup').send(body);
      expect(missing.status).toBe(403);
      expect(missing.body.error.code).toBe('INVALID_INVITE');
      expect((await rawApi().post('/api/auth/signup').send({ ...body, inviteCode: 'nope' })).status).toBe(403);
      expect((await rawApi().post('/api/auth/signup').send({ ...body, inviteCode: 'SHELF-2026' })).status).toBe(201);
    } finally { config.signupCode = ''; }
  });

  it('lets a manager list users and change roles, but never remove the last manager', async () => {
    await staffToken();
    const users = (await api().get('/api/users')).body.data;
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users)).not.toMatch(/password|hash/i);
    const staff = users.find((u: any) => u.role === 'staff');
    const manager = users.find((u: any) => u.role === 'manager');

    expect((await api().put(`/api/users/${manager.id}/role`).send({ role: 'staff' })).body.error.code).toBe('LAST_MANAGER');
    expect((await api().put(`/api/users/${staff.id}/role`).send({ role: 'manager' })).body.role).toBe('manager');
    expect((await api().put(`/api/users/${manager.id}/role`).send({ role: 'staff' })).status).toBe(200); // now allowed
    expect((await api().put('/api/users/999/role').send({ role: 'staff' })).status).toBe(403); // demoted: still signed in, but no longer a manager
  });
});
