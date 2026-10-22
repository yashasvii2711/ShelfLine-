import request from 'supertest';
import { createApp } from '../src/app';
import { api, authHeader, setupDb, teardownDb } from './helpers';
import { buildPage, MAX_PAGE_SIZE } from '../src/utils/pagination';
import { idParam, likePattern } from '../src/utils/validation';
import { runMigrations } from '../src/db/migrate';

beforeAll(setupDb);
afterAll(teardownDb);

describe('Error handling & request ids (FR-09, FR-10)', () => {
  it('returns the standard JSON error shape with a request id', async () => {
    const res = await api().get('/api/products/9999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('honours an incoming X-Request-Id and generates one otherwise', async () => {
    const withId = await api().get('/health').set('X-Request-Id', 'abc-123');
    expect(withId.headers['x-request-id']).toBe('abc-123');
    const without = await api().get('/health');
    expect(without.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const evil = await api().get('/health').set('X-Request-Id', 'bad id with spaces!');
    expect(evil.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('handles malformed JSON (400), unknown routes (404) and bad ids (400)', async () => {
    const bad = await api().post('/api/products').set('Content-Type', 'application/json').send('{"sku": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    expect((await api().get('/api/nope')).status).toBe(404);
    expect((await api().get('/nope')).body.error.code).toBe('NOT_FOUND');
    expect((await api().get('/api/products/0')).status).toBe(400);
    expect((await api().get('/api/products/1.5')).status).toBe(400);
    expect((await api().get('/api/products/99999999999')).status).toBe(400);
  });

  it('returns 413 for oversized bodies', async () => {
    const res = await api().post('/api/products').send({ sku: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
  });

  it('serves the web UI at / and its assets', async () => {
    const home = await api().get('/');
    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toMatch(/html/);
    expect(home.text).toContain('Shelfline');
    expect((await api().get('/app.js')).status).toBe(200);
    expect((await api().get('/styles.css')).status).toBe(200);
  });

  it('health check reports ok and the OpenAPI document is served', async () => {
    expect((await api().get('/health')).body.status).toBe('ok');
    const spec = await api().get('/api-docs.json');
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/api/orders/{id}/cancel');
    expect((await api().get('/api-docs/')).status).toBe(200);
  });
});

describe('Rate limiting', () => {
  it('returns 429 in the standard error format once the limit is exceeded', async () => {
    const limited = request(createApp({ rateLimit: { windowMs: 60_000, max: 3 } }));
    for (let i = 0; i < 3; i++) expect((await limited.get('/api/stores').set('Authorization', authHeader())).status).toBe(200);
    const res = await limited.get('/api/stores').set('Authorization', authHeader());
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['ratelimit']).toBeDefined();
    // health stays reachable for orchestrators
    expect((await limited.get('/health')).status).toBe(200);
  });
});

describe('Utilities', () => {
  it('buildPage computes totalPages', () => {
    expect(buildPage([], 1, 20, 0).pagination.totalPages).toBe(0);
    expect(buildPage([1], 1, 20, 41).pagination.totalPages).toBe(3);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
  it('idParam validates path ids', () => {
    expect(idParam('12')).toBe(12);
    expect(() => idParam('-1')).toThrow();
    expect(() => idParam(undefined)).toThrow();
  });
  it('likePattern escapes wildcards', () => {
    expect(likePattern('50%_a\\')).toBe('%50\\%\\_a\\\\%');
  });
  it('migrations are idempotent', async () => {
    expect(await runMigrations()).toEqual([]);
  });
});
