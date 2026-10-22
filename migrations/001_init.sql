-- Inventory & Order Tracking API: initial schema

CREATE TABLE products (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         VARCHAR(64)    NOT NULL UNIQUE,
  name        VARCHAR(200)   NOT NULL,
  category    VARCHAR(100)   NOT NULL,
  price       NUMERIC(12,2)  NOT NULL CHECK (price >= 0),
  is_deleted  BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_category ON products (lower(category));
CREATE INDEX idx_products_name ON products (lower(name));

CREATE TABLE stores (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  city        VARCHAR(100) NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id           INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id             INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  quantity             INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),          -- BR-1, second line of defence
  low_stock_threshold  INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, store_id)
);
CREATE INDEX idx_inventory_store ON inventory (store_id);

CREATE TABLE orders (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  status        VARCHAR(16) NOT NULL CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  total_amount  NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ
);
CREATE INDEX idx_orders_store_created ON orders (store_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_created ON orders (created_at DESC);

CREATE TABLE order_items (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),   -- BR-3: snapshot of product price
  UNIQUE (order_id, product_id)                                  -- BR-6
);
CREATE INDEX idx_order_items_product ON order_items (product_id);

CREATE TABLE alerts (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id           INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  quantity_at_alert  INTEGER NOT NULL,
  resolved           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
-- BR-4: only one OPEN alert per product per store (enforced by the database)
CREATE UNIQUE INDEX uq_open_alert ON alerts (product_id, store_id) WHERE resolved = FALSE;
CREATE INDEX idx_alerts_store ON alerts (store_id, resolved);

CREATE TABLE stock_movements (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_id  INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  old_qty       INTEGER NOT NULL,
  new_qty       INTEGER NOT NULL,
  reason        VARCHAR(32) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_inventory ON stock_movements (inventory_id, created_at DESC);
