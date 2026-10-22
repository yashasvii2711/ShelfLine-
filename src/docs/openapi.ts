import swaggerJsdoc from 'swagger-jsdoc';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const resp = (description: string, schema?: object) => ({ description, ...(schema && { content: json(schema) }) });
const err = (description: string) => resp(description, ref('Error'));
const idParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } });
const q = (name: string, schema: object, description?: string) => ({ name, in: 'query', required: false, schema, description });
const page = [
  q('page', { type: 'integer', minimum: 1, default: 1 }),
  q('size', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, 'Page size (max 100)'),
];
const paged = (item: string) => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: ref(item) },
    pagination: ref('Pagination'),
  },
});
const e400 = err('Validation error');
const e404 = err('Not found');
const e409 = err('Conflict');
const e422 = err('Unprocessable (references a missing resource)');
const e429 = err('Rate limit exceeded');

export const openapiSpec = swaggerJsdoc({
  apis: [],
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Inventory & Order Tracking API',
      version: '1.0.0',
      description:
        'Tracks products, stores, stock levels and orders for a multi-store retail chain. ' +
        'Orders decrement stock atomically; concurrent orders can never oversell. ' +
        'Every response carries an `X-Request-Id` header; send your own to correlate logs.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    tags: [{ name: 'Auth' }, { name: 'Users' }, { name: 'Products' }, { name: 'Stores' }, { name: 'Inventory' }, { name: 'Orders' }, { name: 'Alerts' }, { name: 'System' }],
    paths: {
      '/api/auth/config': { get: { tags: ['Auth'], summary: 'Sign-up options (is this the first account? invite code needed?)', security: [], responses: { 200: resp('OK') } } },
      '/api/auth/signup': { post: { tags: ['Auth'], summary: 'Create an account (first account becomes manager, later ones staff)', security: [], requestBody: { required: true, content: json(ref('SignupInput')) }, responses: { 201: resp('Created. Returns {user, token} and sets the session cookie', ref('AuthResult')), 400: e400, 403: err('Invite code required/invalid'), 409: e409, 429: e429 } } },
      '/api/auth/login': { post: { tags: ['Auth'], summary: 'Sign in', security: [], requestBody: { required: true, content: json(ref('LoginInput')) }, responses: { 200: resp('OK. Returns {user, token} and sets the session cookie', ref('AuthResult')), 401: err('Email or password is incorrect'), 429: e429 } } },
      '/api/auth/logout': { post: { tags: ['Auth'], summary: 'Sign out (ends the session)', responses: { 200: resp('OK'), 401: err('Not signed in') } } },
      '/api/auth/me': { get: { tags: ['Auth'], summary: 'Current user', responses: { 200: resp('OK'), 401: err('Not signed in') } } },
      '/api/users': { get: { tags: ['Users'], summary: 'List accounts (manager only)', responses: { 200: resp('OK'), 403: err('Managers only') } } },
      '/api/users/{id}/role': { parameters: [idParam('id')], put: { tags: ['Users'], summary: 'Change a role (manager only; the last manager cannot be demoted)', requestBody: { required: true, content: json({ type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['manager', 'staff'] } } }) }, responses: { 200: resp('OK'), 403: err('Managers only'), 404: e404, 409: e409 } } },
      '/health': { get: { tags: ['System'], summary: 'Liveness + database check', security: [], responses: { 200: resp('Healthy'), 503: resp('Database unreachable') } } },
      '/api/products': {
        post: { tags: ['Products'], summary: 'Create product', requestBody: { required: true, content: json(ref('ProductInput')) }, responses: { 201: resp('Created', ref('Product')), 400: e400, 409: e409, 429: e429 } },
        get: { tags: ['Products'], summary: 'List / search products', parameters: [q('search', { type: 'string' }, 'Matches name or SKU'), q('category', { type: 'string' }), ...page], responses: { 200: resp('OK', paged('Product')), 400: e400, 429: e429 } },
      },
      '/api/products/{id}': {
        parameters: [idParam('id')],
        get: { tags: ['Products'], summary: 'Get product', responses: { 200: resp('OK', ref('Product')), 404: e404 } },
        put: { tags: ['Products'], summary: 'Update product (any subset of fields)', requestBody: { required: true, content: json(ref('ProductInput')) }, responses: { 200: resp('OK', ref('Product')), 400: e400, 404: e404, 409: e409 } },
        delete: { tags: ['Products'], summary: 'Delete product (soft delete if it has order history)', responses: { 200: resp('Deleted', { type: 'object', properties: { id: { type: 'integer' }, deleted: { type: 'boolean' }, mode: { type: 'string', enum: ['soft', 'hard'] } } }), 404: e404 } },
      },
      '/api/stores': {
        post: { tags: ['Stores'], summary: 'Create store', requestBody: { required: true, content: json(ref('StoreInput')) }, responses: { 201: resp('Created', ref('Store')), 400: e400 } },
        get: { tags: ['Stores'], summary: 'List / search stores', parameters: [q('search', { type: 'string' }, 'Matches name or city'), q('city', { type: 'string' }), ...page], responses: { 200: resp('OK', paged('Store')), 400: e400 } },
      },
      '/api/stores/{id}': {
        parameters: [idParam('id')],
        get: { tags: ['Stores'], summary: 'Get store', responses: { 200: resp('OK', ref('Store')), 404: e404 } },
        put: { tags: ['Stores'], summary: 'Update store', requestBody: { required: true, content: json(ref('StoreInput')) }, responses: { 200: resp('OK', ref('Store')), 400: e400, 404: e404 } },
        delete: { tags: ['Stores'], summary: 'Delete store (409 if it has orders)', responses: { 200: resp('Deleted'), 404: e404, 409: e409 } },
      },
      '/api/stores/{id}/inventory': {
        parameters: [idParam('id')],
        get: { tags: ['Inventory'], summary: "View a store's stock", parameters: [q('lowStock', { type: 'boolean' }, 'true = only items at/below threshold'), q('search', { type: 'string' }), q('category', { type: 'string' }), ...page], responses: { 200: resp('OK', paged('InventoryItem')), 400: e400, 404: e404 } },
      },
      '/api/stores/{id}/inventory/{productId}': {
        parameters: [idParam('id'), idParam('productId')],
        get: { tags: ['Inventory'], summary: 'Get one stock record', responses: { 200: resp('OK', ref('InventoryItem')), 404: e404 } },
        put: { tags: ['Inventory'], summary: 'Set stock quantity and threshold (creates the record if needed)', requestBody: { required: true, content: json(ref('StockInput')) }, responses: { 200: resp('OK', ref('InventoryItem')), 400: e400, 404: e404, 422: e422 } },
      },
      '/api/stores/{id}/inventory/{productId}/movements': {
        parameters: [idParam('id'), idParam('productId')],
        get: { tags: ['Inventory'], summary: 'Stock audit trail', parameters: page, responses: { 200: resp('OK', paged('StockMovement')), 404: e404 } },
      },
      '/api/orders': {
        post: { tags: ['Orders'], summary: 'Place an order (atomic, multi-item)', requestBody: { required: true, content: json(ref('OrderInput')) }, responses: { 201: resp('Order confirmed', ref('Order')), 400: e400, 409: err('INSUFFICIENT_STOCK for at least one item; nothing was changed'), 422: e422, 429: e429 } },
        get: { tags: ['Orders'], summary: 'List / filter orders', parameters: [q('storeId', { type: 'integer' }), q('status', { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED'] }), q('from', { type: 'string' }, 'ISO date or date-time (inclusive)'), q('to', { type: 'string' }, 'ISO date or date-time (inclusive; a date covers the whole day)'), ...page], responses: { 200: resp('OK', paged('OrderSummary')), 400: e400 } },
      },
      '/api/orders/{id}': {
        parameters: [idParam('id')],
        get: { tags: ['Orders'], summary: 'Order details', responses: { 200: resp('OK', ref('Order')), 404: e404 } },
      },
      '/api/orders/{id}/cancel': {
        parameters: [idParam('id')],
        post: { tags: ['Orders'], summary: 'Cancel a CONFIRMED order and restock', responses: { 200: resp('Cancelled', ref('Order')), 404: e404, 409: err('Order already cancelled / not cancellable') } },
      },
      '/api/alerts': {
        get: { tags: ['Alerts'], summary: 'List low-stock alerts', parameters: [q('resolved', { type: 'boolean' }), q('storeId', { type: 'integer' }), q('productId', { type: 'integer' }), ...page], responses: { 200: resp('OK', paged('Alert')), 400: e400 } },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token from /api/auth/login. The web app uses an httpOnly cookie instead. Staff can read and place orders; changes to products, stores, stock levels, cancellations and users need the manager role.' } },
      schemas: {
        SignupInput: { type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string', example: 'Asha Patel' }, email: { type: 'string', example: 'asha@store.com' }, password: { type: 'string', description: '8+ characters with a letter and a number', example: 'Shelf#2026' }, inviteCode: { type: 'string' } } },
        LoginInput: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } },
        AuthResult: { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ['manager', 'staff'] } } }, token: { type: 'string' } } },
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', example: 'INSUFFICIENT_STOCK' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } },
        Pagination: { type: 'object', properties: { page: { type: 'integer' }, size: { type: 'integer' }, totalItems: { type: 'integer' }, totalPages: { type: 'integer' } } },
        ProductInput: { type: 'object', required: ['sku', 'name', 'category', 'price'], properties: { sku: { type: 'string', example: 'TSHIRT-BLK-M' }, name: { type: 'string', example: 'Black T-Shirt (M)' }, category: { type: 'string', example: 'Apparel' }, price: { type: 'number', example: 499.5 } } },
        Product: { allOf: [ref('ProductInput'), { type: 'object', properties: { id: { type: 'integer' }, isDeleted: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } }] },
        StoreInput: { type: 'object', required: ['name', 'city'], properties: { name: { type: 'string', example: 'Vadodara Central' }, city: { type: 'string', example: 'Vadodara' } } },
        Store: { allOf: [ref('StoreInput'), { type: 'object', properties: { id: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } }] },
        StockInput: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 0, example: 50 }, lowStockThreshold: { type: 'integer', minimum: 0, example: 10, description: 'Defaults to 10 for new records; unchanged on update if omitted' } } },
        InventoryItem: { type: 'object', properties: { productId: { type: 'integer' }, storeId: { type: 'integer' }, sku: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, quantity: { type: 'integer' }, lowStockThreshold: { type: 'integer' }, isLowStock: { type: 'boolean' }, updatedAt: { type: 'string', format: 'date-time' } } },
        StockMovement: { type: 'object', properties: { id: { type: 'integer' }, orderId: { type: 'integer', nullable: true }, oldQuantity: { type: 'integer' }, newQuantity: { type: 'integer' }, reason: { type: 'string', enum: ['INITIAL_STOCK', 'MANUAL_ADJUSTMENT', 'ORDER_PLACED', 'ORDER_CANCELLED'] }, createdAt: { type: 'string', format: 'date-time' } } },
        OrderInput: { type: 'object', required: ['storeId', 'items'], properties: { storeId: { type: 'integer', example: 1 }, items: { type: 'array', minItems: 1, items: { type: 'object', required: ['productId', 'quantity'], properties: { productId: { type: 'integer', example: 1 }, quantity: { type: 'integer', minimum: 1, example: 2 } } } } } },
        OrderSummary: { type: 'object', properties: { id: { type: 'integer' }, storeId: { type: 'integer' }, status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED'] }, totalAmount: { type: 'number' }, itemCount: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, cancelledAt: { type: 'string', format: 'date-time', nullable: true } } },
        Order: { allOf: [ref('OrderSummary'), { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { productId: { type: 'integer' }, sku: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' }, unitPrice: { type: 'number' }, lineTotal: { type: 'number' } } } } } }] },
        Alert: { type: 'object', properties: { id: { type: 'integer' }, productId: { type: 'integer' }, sku: { type: 'string' }, productName: { type: 'string' }, storeId: { type: 'integer' }, storeName: { type: 'string' }, quantityAtAlert: { type: 'integer' }, resolved: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, resolvedAt: { type: 'string', format: 'date-time', nullable: true } } },
      },
    },
  },
});
