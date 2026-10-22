# Database schema (ER diagram)

Source of truth: [`migrations/001_init.sql`](../migrations/001_init.sql). The diagram renders automatically on GitHub.

```mermaid
erDiagram
    products ||--o{ inventory : "stocked as"
    stores   ||--o{ inventory : "holds"
    stores   ||--o{ orders : "receives"
    orders   ||--|{ order_items : "contains"
    products ||--o{ order_items : "sold as"
    products ||--o{ alerts : "raises"
    stores   ||--o{ alerts : "raises"
    inventory ||--o{ stock_movements : "audited by"
    orders   |o--o{ stock_movements : "caused"

    products {
        int id PK
        varchar sku UK
        varchar name
        varchar category
        numeric price "CHECK >= 0"
        boolean is_deleted "soft delete"
        timestamptz created_at
        timestamptz updated_at
    }
    stores {
        int id PK
        varchar name
        varchar city
        timestamptz created_at
        timestamptz updated_at
    }
    inventory {
        int id PK
        int product_id FK
        int store_id FK
        int quantity "CHECK >= 0"
        int low_stock_threshold "CHECK >= 0"
        timestamptz updated_at
    }
    orders {
        int id PK
        int store_id FK
        varchar status "PENDING | CONFIRMED | CANCELLED"
        numeric total_amount
        timestamptz created_at
        timestamptz cancelled_at
    }
    order_items {
        int id PK
        int order_id FK
        int product_id FK
        int quantity "CHECK > 0"
        numeric unit_price "price snapshot"
    }
    alerts {
        int id PK
        int product_id FK
        int store_id FK
        int quantity_at_alert
        boolean resolved
        timestamptz created_at
        timestamptz resolved_at
    }
    stock_movements {
        int id PK
        int inventory_id FK
        int order_id FK
        int old_qty
        int new_qty
        varchar reason
        timestamptz created_at
    }
```

## Constraints worth knowing

| Constraint | Purpose |
|---|---|
| `UNIQUE (inventory.product_id, inventory.store_id)` | One stock record per product-store pair (FR-03) |
| `CHECK (inventory.quantity >= 0)` | Second line of defence against negative stock (BR-1) |
| `UNIQUE (order_items.order_id, product_id)` | Same product cannot appear twice in an order (BR-6) |
| `UNIQUE INDEX uq_open_alert ON alerts (product_id, store_id) WHERE resolved = FALSE` | At most one open alert per product per store, even under concurrency (BR-4) |
| `products.sku UNIQUE` | SKU uniqueness (FR-01); stays reserved after a soft delete |
