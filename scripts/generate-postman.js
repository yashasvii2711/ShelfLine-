/* Generates postman/inventory-api.postman_collection.json and the environment file.
   Run: npm run postman:generate */
const fs = require('fs');
const path = require('path');

const j = (o) => JSON.stringify(o, null, 2);
const test = (...lines) => ({ listen: 'test', script: { type: 'text/javascript', exec: lines } });
const status = (code) => `pm.test('Status is ${code}', () => pm.response.to.have.status(${code}));`;

function req(name, method, url, { body, tests = [], query, description, auth } = {}) {
  const path = url.split('/').filter(Boolean);
  return {
    name,
    event: [test(...tests)],
    request: {
      ...(auth && { auth }),
      method,
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      ...(body && { body: { mode: 'raw', raw: j(body) } }),
      url: {
        raw: `{{baseUrl}}${url}` + (query ? '?' + query.map((q) => `${q.key}=${q.value}`).join('&') : ''),
        host: ['{{baseUrl}}'],
        path,
        ...(query && { query }),
      },
      description,
    },
  };
}
const save = (varName, expr) => `pm.collectionVariables.set('${varName}', ${expr});`;
const q = (key, value, disabled) => ({ key, value, ...(disabled && { disabled: true }) });

const login = (name, email, password, varName) => req(name, 'POST', '/api/auth/login', {
  body: { email, password }, auth: { type: 'noauth' },
  tests: [status(200), save(varName, 'pm.response.json().token')],
});
const folders = [
  {
    name: '0a. Sign in (run `npm run seed` first for the demo accounts)',
    item: [
      login('Log in as manager', 'manager@shelfline.test', 'Manager#2026', 'token'),
      login('Log in as staff', 'staff@shelfline.test', 'Staff#2026', 'staffToken'),
      req('Current user (manager)', 'GET', '/api/auth/me', { tests: [status(200), "pm.test('is manager', () => pm.expect(pm.response.json().user.role).to.eql('manager'));"] }),
      req('Wrong password (401)', 'POST', '/api/auth/login', { body: { email: 'manager@shelfline.test', password: 'nope-Wrong1' }, auth: { type: 'noauth' }, tests: [status(401)] }),
      req('Invalid token (401)', 'GET', '/api/products', { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'not-a-real-token', type: 'string' }] }, tests: [status(401)] }),
      req('Staff cannot create a product (403)', 'POST', '/api/products', {
        body: { sku: 'NOPE', name: 'x', category: 'x', price: 1 },
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{staffToken}}', type: 'string' }] },
        tests: [status(403)],
      }),
      req('Staff can view stock (200)', 'GET', '/api/products', { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{staffToken}}', type: 'string' }] }, tests: [status(200)] }),
      req('List team (manager)', 'GET', '/api/users', { tests: [status(200)] }),
    ],
  },
  {
    name: '0. System',
    item: [
      req('Health check', 'GET', '/health', { tests: [status(200), "pm.test('status ok', () => pm.expect(pm.response.json().status).to.eql('ok'));"] }),
    ],
  },
  {
    name: '1. Stores',
    item: [
      req('Create store', 'POST', '/api/stores', {
        body: { name: 'Postman Store', city: 'Vadodara' },
        tests: [status(201), save('storeId', 'pm.response.json().id')],
      }),
      req('Create second store', 'POST', '/api/stores', {
        body: { name: 'Postman Store 2', city: 'Surat' },
        tests: [status(201), save('storeId2', 'pm.response.json().id')],
      }),
      req('List stores (search + filter + pagination)', 'GET', '/api/stores', {
        query: [q('search', 'Postman'), q('city', 'Vadodara', true), q('page', '1'), q('size', '20')],
        tests: [status(200), "pm.test('has pagination', () => pm.expect(pm.response.json().pagination).to.have.property('totalItems'));"],
      }),
      req('Get store', 'GET', '/api/stores/{{storeId}}', { tests: [status(200)] }),
      req('Update store', 'PUT', '/api/stores/{{storeId}}', { body: { name: 'Postman Store (renamed)' }, tests: [status(200)] }),
    ],
  },
  {
    name: '2. Products',
    item: [
      req('Create product', 'POST', '/api/products', {
        body: { sku: 'PM-{{$timestamp}}', name: 'Postman Widget', category: 'Demo', price: 199.5 },
        tests: [status(201), save('productId', 'pm.response.json().id'), save('lastSku', 'pm.response.json().sku')],
      }),
      req('Create second product', 'POST', '/api/products', {
        body: { sku: 'PM2-{{$timestamp}}', name: 'Postman Gadget', category: 'Demo', price: 50 },
        tests: [status(201), save('productId2', 'pm.response.json().id')],
      }),
      req('Create product - duplicate SKU (409)', 'POST', '/api/products', {
        body: { sku: '{{lastSku}}', name: 'dup', category: 'Demo', price: 1 },
        tests: [status(409), "pm.test('SKU_EXISTS', () => pm.expect(pm.response.json().error.code).to.eql('SKU_EXISTS'));"],
        description: 'Re-uses the SKU of the first product created above.',
      }),
      req('Create product - invalid (400)', 'POST', '/api/products', { body: { sku: '', price: -5 }, tests: [status(400)] }),
      req('List products (search + filter + pagination)', 'GET', '/api/products', {
        query: [q('search', 'Postman'), q('category', 'Demo'), q('page', '1'), q('size', '10')],
        tests: [status(200)],
      }),
      req('Get product', 'GET', '/api/products/{{productId}}', { tests: [status(200)] }),
      req('Update product', 'PUT', '/api/products/{{productId}}', { body: { price: 210 }, tests: [status(200)] }),
    ],
  },
  {
    name: '3. Inventory',
    item: [
      req('Set stock (product 1)', 'PUT', '/api/stores/{{storeId}}/inventory/{{productId}}', {
        body: { quantity: 12, lowStockThreshold: 5 },
        tests: [status(200), "pm.test('quantity set', () => pm.expect(pm.response.json().quantity).to.eql(12));"],
      }),
      req('Set stock (product 2)', 'PUT', '/api/stores/{{storeId}}/inventory/{{productId2}}', { body: { quantity: 30, lowStockThreshold: 5 }, tests: [status(200)] }),
      req("View store's stock", 'GET', '/api/stores/{{storeId}}/inventory', {
        query: [q('lowStock', 'true', true), q('search', ''), q('category', '', true), q('page', '1'), q('size', '20')],
        tests: [status(200)],
      }),
      req('Get one stock record', 'GET', '/api/stores/{{storeId}}/inventory/{{productId}}', { tests: [status(200)] }),
      req('Stock audit trail', 'GET', '/api/stores/{{storeId}}/inventory/{{productId}}/movements', { tests: [status(200)] }),
    ],
  },
  {
    name: '4. Orders',
    item: [
      req('Place order (multi-item)', 'POST', '/api/orders', {
        body: { storeId: '{{storeId}}', items: [{ productId: '{{productId}}', quantity: 3 }, { productId: '{{productId2}}', quantity: 2 }] },
        tests: [status(201), save('orderId', 'pm.response.json().id'), "pm.test('CONFIRMED', () => pm.expect(pm.response.json().status).to.eql('CONFIRMED'));"],
        description: 'Numbers in the body are quoted so Postman can substitute variables; the collection pre-request script converts them to integers.',
      }),
      req('Place order - insufficient stock (409)', 'POST', '/api/orders', {
        body: { storeId: '{{storeId}}', items: [{ productId: '{{productId}}', quantity: 9999 }] },
        tests: [status(409), "pm.test('INSUFFICIENT_STOCK', () => pm.expect(pm.response.json().error.code).to.eql('INSUFFICIENT_STOCK'));"],
      }),
      req('Place order - duplicate product (400)', 'POST', '/api/orders', {
        body: { storeId: '{{storeId}}', items: [{ productId: '{{productId}}', quantity: 1 }, { productId: '{{productId}}', quantity: 1 }] },
        tests: [status(400)],
      }),
      req('Place order - unknown product (422)', 'POST', '/api/orders', {
        body: { storeId: '{{storeId}}', items: [{ productId: 999999, quantity: 1 }] },
        tests: [status(422)],
      }),
      req('List orders (filters + pagination)', 'GET', '/api/orders', {
        query: [q('storeId', '{{storeId}}'), q('status', 'CONFIRMED'), q('from', '2020-01-01'), q('to', '2100-01-01'), q('page', '1'), q('size', '20')],
        tests: [status(200)],
      }),
      req('Get order', 'GET', '/api/orders/{{orderId}}', { tests: [status(200)] }),
      req('Cancel order (restocks)', 'POST', '/api/orders/{{orderId}}/cancel', { tests: [status(200), "pm.test('CANCELLED', () => pm.expect(pm.response.json().status).to.eql('CANCELLED'));"] }),
      req('Cancel order again (409)', 'POST', '/api/orders/{{orderId}}/cancel', { tests: [status(409)] }),
    ],
  },
  {
    name: '5. Low-stock alerts',
    item: [
      req('Drop stock to threshold (creates alert)', 'PUT', '/api/stores/{{storeId}}/inventory/{{productId}}', { body: { quantity: 4, lowStockThreshold: 5 }, tests: [status(200)] }),
      req('List open alerts', 'GET', '/api/alerts', {
        query: [q('resolved', 'false'), q('storeId', '{{storeId}}'), q('page', '1'), q('size', '20')],
        tests: [status(200), "pm.test('has an open alert', () => pm.expect(pm.response.json().data.length).to.be.above(0));"],
      }),
      req('Replenish stock (auto-resolves alert)', 'PUT', '/api/stores/{{storeId}}/inventory/{{productId}}', { body: { quantity: 100 }, tests: [status(200)] }),
      req('List resolved alerts', 'GET', '/api/alerts', { query: [q('resolved', 'true'), q('storeId', '{{storeId}}')], tests: [status(200)] }),
    ],
  },
  {
    name: '6. Cleanup & errors',
    item: [
      req('Get unknown product (404)', 'GET', '/api/products/999999', { tests: [status(404), "pm.test('error format', () => pm.expect(pm.response.json().error).to.include.keys('code', 'message', 'requestId'));"] }),
      req('Delete product (soft: has orders)', 'DELETE', '/api/products/{{productId}}', { tests: [status(200), "pm.test('soft delete', () => pm.expect(pm.response.json().mode).to.eql('soft'));"] }),
      req('Delete product 2 (soft: has orders)', 'DELETE', '/api/products/{{productId2}}', { tests: [status(200)] }),
      req('Delete store with orders (409)', 'DELETE', '/api/stores/{{storeId}}', { tests: [status(409)] }),
      req('Delete empty store', 'DELETE', '/api/stores/{{storeId2}}', { tests: [status(200)] }),
    ],
  },
];

const collection = {
  info: {
    name: 'Inventory & Order Tracking API',
    description: 'Run the folders in order (Collection Runner) for an end-to-end flow. IDs are saved to collection variables automatically.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          '// Turn quoted "{{var}}" placeholders inside JSON bodies into real integers',
          "if (pm.request.body && pm.request.body.mode === 'raw') {",
          '  let raw = pm.request.body.raw;',
          "  raw = raw.replace(/\"\\{\\{(storeId2?|productId2?)\\}\\}\"/g, (_, v) => pm.collectionVariables.get(v) || pm.environment.get(v) || '0');",
          '  pm.request.body.raw = raw;',
          '}',
        ],
      },
    },
  ],
  variable: ['token', 'staffToken', 'storeId', 'storeId2', 'productId', 'productId2', 'orderId', 'lastSku'].map((key) => ({ key, value: '' })),
  item: folders,
};

const environment = {
  id: 'inventory-api-local',
  name: 'Inventory API - Local',
  values: [{ key: 'baseUrl', value: 'http://localhost:3000', enabled: true }],
  _postman_variable_scope: 'environment',
};

const dir = path.resolve(__dirname, '../postman');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'inventory-api.postman_collection.json'), j(collection) + '\n');
fs.writeFileSync(path.join(dir, 'local.postman_environment.json'), j(environment) + '\n');
console.log('Postman collection + environment written to postman/');
