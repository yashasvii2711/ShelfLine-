# Inventory & Order Tracking API

A production-style REST backend that tracks products, stores, stock levels and orders for a multi-store retail chain (Vadodara, Surat, Ahmedabad) in near real time. It replaces shared spreadsheets and **guarantees stock can never go negative, even when many orders arrive at once**.

**Stack:** Node.js 20 · Express · TypeScript · PostgreSQL 15 · Zod · Pino · express-rate-limit · swagger-jsdoc / swagger-ui-express · Jest + Supertest · Docker · GitHub Actions

## Features

| Brief | Implemented |
|---|---|
| FR-01 Products | CRUD, unique SKU, **soft delete** when the product has order history (hard delete otherwise) |
| FR-02 Stores | CRUD; stores with order history cannot be deleted (409) |
| FR-03 Stock levels | Set/view quantity + low-stock threshold per product per store (unique pair) |
| FR-04 / FR-05 Orders | Multi-item orders, all-or-nothing, atomic and **concurrency-safe** |
| FR-06 Cancellation | Cancel a CONFIRMED order, items return to stock, cannot cancel twice |
| FR-07 Low-stock alerts | Opened at `quantity <= threshold`, never duplicated, auto-resolved on replenishment |
| FR-08 Lists | `page`/`size` (max 100), filtering and keyword search on every list endpoint |
| FR-09 Errors | One JSON error format, correct 400/404/409/422/429/500 |
| FR-10 Logging | Structured JSON logs, a request ID on every request and every stock-change log line |
| FR-11 Audit trail | Every stock change stored in `stock_movements` (old qty, new qty, reason, time) |
| Accounts | Sign-up / sign-in, httpOnly session cookie or Bearer token, **manager** and **staff** roles enforced by the API |
| Extras | Swagger UI, exported OpenAPI file, Postman collection, health check, graceful shutdown, Docker |

## Quick start

### Option A: Docker (easiest)

```bash
docker compose up --build
```

API on <http://localhost:3000>, Swagger UI on <http://localhost:3000/api-docs>. Migrations run automatically on startup.
Optional demo data (3 stores, 5 products, starting stock):

```bash
docker compose exec api node dist/db/seed.js
```

Sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `docker-compose.yml` (default `admin@example.com` / `ChangeMe123`: change it). In production mode the seed does not create demo accounts.

### Option B: Local Node + Postgres

Requirements: Node.js 20+, PostgreSQL 15+.

```bash
cp .env.example .env            # adjust DATABASE_URL if needed
createdb inventory              # or: psql -c "CREATE DATABASE inventory"
npm install
npm run migrate                 # create tables
npm run seed                    # optional demo data
npm run dev                     # http://localhost:3000  (hot reload)
```

Production build: `npm run build && npm start` (migrations also run on startup).

## Accounts and access

Every `/api` endpoint needs a signed-in user. `/health`, `/api-docs`, the web app itself and `/api/auth/*` are public.

| Role | Can do |
|---|---|
| **Manager** | Everything: products, stores, stock levels, cancel orders, manage the team |
| **Staff** | View everything and place orders |

- **First account = manager.** After that, new sign-ups are staff. Managers change roles in the **Team** tab (`PUT /api/users/{id}/role`); the last manager can never be demoted.
- **Local demo:** `npm run seed` also creates `manager@shelfline.test` / `Manager#2026` and `staff@shelfline.test` / `Staff#2026`. **Local use only, delete them before a real deployment.**
- **Deployment:** set `ADMIN_EMAIL` + `ADMIN_PASSWORD` to create the first manager on startup, and set `SIGNUP_CODE` so only people you invite can create accounts (they enter the code on the sign-up form).
- **Security notes:** passwords are hashed with scrypt (salted), never stored or returned; session tokens are random, only their SHA-256 hash is stored, they last 7 days and sign-out ends them immediately; the web app uses an `httpOnly`, `SameSite=Lax` cookie (not readable by page scripts); sign-in and sign-up are limited to 20 attempts per 15 minutes per IP; wrong email and wrong password give the same message. Serve it over **HTTPS** in production.
- **API clients:** `POST /api/auth/login` returns `{ user, token }`; send `Authorization: Bearer <token>`. In Swagger click **Authorize** and paste the token.

## Web interface

Open **<http://localhost:3000>**: the staff app (**Shelfline**), served by the API itself with no extra setup. You will see a sign-in / create-account page first.

| Tab | What you can do |
|---|---|
| Shelf watch | Low-stock items shown as shelf-edge labels (yellow = running low, red = sold out) with a stock-health bar. Refreshes every 10 s. One-click **Restock** |
| New order | Build a multi-item order and place it. Stock is deducted atomically; a shortage shows a clear message and changes nothing |
| Orders | Filter by status, see details, **cancel** an order (stock returns) |
| Stock | Edit quantity and restock level per product, search, low-stock filter, add a product to the store |
| Products / Stores | Create, edit, delete, search (managers) |
| Team | See accounts and change roles (managers) |

Use **You are at** (top of the left rail) to switch stores.

**Branding for a client:** the product name is in `public/index.html` (`<title>` and `.brand`); colours and the font are the CSS variables at the top of `public/styles.css` (`--ink` navy, `--sticker` yellow, `--green`, `--red`). Developers can use `/api-docs` (Swagger).

## Deploying

- **Vercel:** step-by-step in [`docs/DEPLOY-VERCEL.md`](docs/DEPLOY-VERCEL.md) (hosted Postgres such as Neon + `npm run bootstrap` once).
- **Docker / any VPS:** `docker compose up --build` (set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SIGNUP_CODE` in a `.env` file next to `docker-compose.yml`; put it behind HTTPS).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/inventory` | PostgreSQL connection string |
| `DB_POOL_MAX` | `20` | Max DB connections |
| `LOG_LEVEL` | `info` | `trace`…`fatal`, or `silent` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `RATE_LIMIT_MAX` | `100` | Max requests per client IP per window on `/api/*` |
| `AUTH_RATE_LIMIT_MAX` | `20` | Sign-in/sign-up attempts per IP per 15 minutes |
| `SIGNUP_CODE` | (empty) | If set, required to create any account after the first |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | (empty) | If both set and no users exist, creates the first manager on startup |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/inventory_test` | Database used by the test suite (it is **truncated** on every run) |

## API overview

Interactive docs: **`/api-docs`** (Swagger UI) · raw spec: `/api-docs.json` · exported file: [`docs/openapi.json`](docs/openapi.json)

| Method | Endpoint | Purpose |
|---|---|---|
| POST / GET | `/api/products` | Create / list (`search`, `category`, `page`, `size`) |
| GET / PUT / DELETE | `/api/products/{id}` | Read / update (any subset of fields) / delete |
| POST / GET | `/api/stores` | Create / list (`search`, `city`, `page`, `size`) |
| GET / PUT / DELETE | `/api/stores/{id}` | Read / update / delete |
| GET | `/api/stores/{id}/inventory` | Store stock (`lowStock=true\|false`, `search`, `category`, `page`, `size`) |
| GET / PUT | `/api/stores/{id}/inventory/{productId}` | Read / set `{quantity, lowStockThreshold?}` |
| GET | `/api/stores/{id}/inventory/{productId}/movements` | Stock audit trail |
| POST / GET | `/api/orders` | Place order / list (`storeId`, `status`, `from`, `to`, `page`, `size`) |
| GET | `/api/orders/{id}` | Order with items |
| POST | `/api/orders/{id}/cancel` | Cancel + restock |
| GET | `/api/alerts` | Alerts (`resolved`, `storeId`, `productId`, `page`, `size`) |
| GET | `/health` | Liveness + DB check (not rate limited) |

### Example

```bash
# 1. create a store and a product
curl -X POST localhost:3000/api/stores   -H 'Content-Type: application/json' -d '{"name":"Vadodara Central","city":"Vadodara"}'
curl -X POST localhost:3000/api/products -H 'Content-Type: application/json' -d '{"sku":"TSH-1","name":"T-Shirt","category":"Apparel","price":499}'

# 2. put 10 units in stock (alert fires when quantity <= threshold)
curl -X PUT localhost:3000/api/stores/1/inventory/1 -H 'Content-Type: application/json' -d '{"quantity":10,"lowStockThreshold":3}'

# 3. place an order
curl -X POST localhost:3000/api/orders -H 'Content-Type: application/json' \
  -d '{"storeId":1,"items":[{"productId":1,"quantity":2}]}'
```

### List response shape

```json
{ "data": [ ... ], "pagination": { "page": 1, "size": 20, "totalItems": 53, "totalPages": 3 } }
```

### Error format

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Insufficient stock for product 1 in store 1",
             "details": { "productId": 1, "requested": 2, "available": 1 }, "requestId": "6465a604-…" } }
```

| Status | When |
|---|---|
| 400 | Validation failure, malformed JSON/ID, duplicate product in an order (`DUPLICATE_PRODUCT`), page size > 100 |
| 404 | Resource or route not found |
| 409 | `INSUFFICIENT_STOCK`, `SKU_EXISTS`, `ORDER_NOT_CANCELLABLE`, `STORE_HAS_ORDERS` |
| 422 | A valid request that references a missing product/store (e.g. in an order body) |
| 429 | Rate limit exceeded |
| 500 | Unexpected error (details are logged, never leaked) |

## Architecture

```
Client ─▶ Express ─▶ [helmet · pino request-id/logging · rate limiter · JSON parser]
                      └▶ routes (zod validation) ─▶ services (business rules, SQL) ─▶ PostgreSQL
                                   └▶ error handler (uniform JSON errors)
```

```
src/
  app.ts, server.ts      app factory (testable) / process entrypoint
  config/                env parsing
  db/                    pg pool + transaction helper, migration runner, seed
  routes/                HTTP layer + zod schemas
  services/              product, store, inventory, order, alert logic
  middleware/            error handler, rate limiter
  utils/                 errors, logger (request-scoped), pagination, validation
  docs/openapi.ts        OpenAPI definition (swagger-jsdoc)
public/                  web UI (index.html, app.js, styles.css), served at /
migrations/              plain SQL migrations (tracked in schema_migrations)
tests/                   Jest + Supertest integration tests (real PostgreSQL)
postman/                 collection + environment
docs/                    ER diagram, exported OpenAPI spec
```

Database schema and ER diagram: [`docs/er-diagram.md`](docs/er-diagram.md).

### How overselling is prevented

Order placement runs in a **single transaction** and, for each item, executes

```sql
UPDATE inventory SET quantity = quantity - $qty
WHERE product_id = $p AND store_id = $s AND quantity >= $qty
RETURNING ...
```

If it touches zero rows the whole transaction rolls back and the API answers `409 INSUFFICIENT_STOCK`. PostgreSQL row-locks the row until commit, so concurrent orders for the same item queue up, and each re-evaluates `quantity >= $qty` against the latest committed value.

Further safeguards:
- Items are processed in **ascending product-id order**, so two multi-item orders can never deadlock (and the transaction helper retries on deadlock/serialization errors anyway).
- `CHECK (quantity >= 0)` in the database is a second line of defence.
- Cancellation locks the order row (`SELECT … FOR UPDATE`), so concurrent cancels restock exactly once.
- At most one open alert per product/store is enforced by a **partial unique index** and `INSERT … ON CONFLICT DO NOTHING`, not just application logic.

## Testing

Tests are integration tests against a **real PostgreSQL** (mocks would not prove concurrency safety).

```bash
createdb inventory_test         # once
npm test                        # runs all suites with coverage (coverage/lcov-report/index.html)
```

Point at another database with `TEST_DATABASE_URL`. Current result: **49 tests, ~90% statement coverage.**

The required proof lives in [`tests/concurrency.test.ts`](tests/concurrency.test.ts):
- **50 concurrent 1-unit orders vs. 10 in stock → exactly 10 × `201`, 40 × `409`, final stock `0`**, exactly 10 orders persisted, one open alert
- opposite-order multi-item orders: no deadlocks, no overselling
- all-or-nothing rollback of multi-item orders
- 10 concurrent cancels of one order restock exactly once

Other suites cover sign-up/sign-in, roles and the invite code (`tests/auth.test.ts`), CRUD, validation, soft delete, pagination/filter/search, alert lifecycle, audit trail, error format, request IDs and rate limiting.

## Postman

Import [`postman/inventory-api.postman_collection.json`](postman/inventory-api.postman_collection.json) and [`postman/local.postman_environment.json`](postman/local.postman_environment.json), select the environment and run the collection (Collection Runner, in order). IDs are stored automatically between requests, and 54 assertions verify the flows, including sign-in, roles and error cases (run `npm run seed` first so the demo accounts exist). CLI: `npx newman run postman/inventory-api.postman_collection.json -e postman/local.postman_environment.json`.
The collection is generated by `npm run postman:generate`; the OpenAPI file by `npm run openapi:export`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request: starts a PostgreSQL 15 service, installs, builds (type-check), runs the tests with coverage (including the concurrency test), publishes a coverage summary + artifact, checks `docs/openapi.json` is up to date, and builds the Docker image.

## Design decisions & assumptions

- **Orders are created directly as `CONFIRMED`** (the stock reservation and confirmation are one atomic step). `PENDING` exists in the schema for future payment flows.
- **Product delete:** soft delete if the product has order history, hard delete otherwise. Soft-deleted products disappear from reads and cannot be ordered; their SKU stays reserved and their open alerts are closed.
- **A missing stock record** is treated as zero stock → `409 INSUFFICIENT_STOCK`. References to unknown stores/products inside an order body return `422`.
- **PUT is a partial update** for products/stores (send only the fields to change, at least one).
- **Setting stock** replaces the quantity (absolute value). Adjusting via orders/cancellations is relative and atomic.
- **Pricing:** money is `NUMERIC(12,2)`; order totals are computed in integer cents.
- **Auth** goes beyond the brief: accounts, two roles and protected endpoints (see *Accounts and access*). Rate limiting is per client IP (`trust proxy` is set to 1, so run it behind one reverse proxy).
- IDs are integers; migrations are plain SQL for easy review.

## Suggested 5–10 minute demo

1. `docker compose up --build`, open `http://localhost:3000` (the UI) and `/api-docs`.
2. Run the seed, show the Dashboard and Stock tabs.
3. Place a multi-item order, show stock decrease and the audit trail (`/movements`).
4. Drop stock to the threshold → `GET /api/alerts?resolved=false`; replenish → alert auto-resolves.
5. Try overselling → `409`. Cancel the order twice → `200` then `409`.
6. Run `npx jest tests/concurrency.test.ts --coverage=false` and walk through the 50-orders test.
7. Run the Postman collection and show the CI workflow.
