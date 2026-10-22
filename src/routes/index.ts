import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import * as auth from '../services/authService';
import * as alerts from '../services/alertService';
import * as inventory from '../services/inventoryService';
import * as orders from '../services/orderService';
import * as products from '../services/productService';
import * as stores from '../services/storeService';
import { badRequest } from '../utils/errors';
import { paginationSchema } from '../utils/pagination';
import { idParam, money, optionalBool, parse, searchText } from '../utils/validation';

const text = (max: number) => z.string().trim().min(1, 'must not be empty').max(max);
const intId = z.number().int().min(1).max(2_147_483_647);

const productBody = z.object({ sku: text(64), name: text(200), category: text(100), price: money }).strict();
const productPatch = productBody.partial().refine((v) => Object.keys(v).length > 0, 'at least one field is required');
const storeBody = z.object({ name: text(200), city: text(100) }).strict();
const storePatch = storeBody.partial().refine((v) => Object.keys(v).length > 0, 'at least one field is required');
const stockBody = z
  .object({ quantity: z.number().int().min(0).max(1_000_000_000), lowStockThreshold: z.number().int().min(0).max(1_000_000_000).optional() })
  .strict();
const orderBody = z
  .object({
    storeId: intId,
    items: z.array(z.object({ productId: intId, quantity: z.number().int().min(1).max(1_000_000) }).strict()).min(1, 'an order must contain at least one item').max(100),
  })
  .strict();

const isoDate = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(v) && !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 date or date-time');

export const router = Router();
/** Managers only. Staff can read everything and place orders. */
const mgr = requireRole('manager');

// ---------- Products ----------
router.post('/products', mgr, asyncHandler(async (req, res) => {
  res.status(201).json(await products.createProduct(parse(productBody, req.body)));
}));
router.get('/products', asyncHandler(async (req, res) => {
  const q = parse(z.object({ search: searchText, category: searchText, ...paginationSchema }), req.query);
  res.json(await products.listProducts(q));
}));
router.get('/products/:id', asyncHandler(async (req, res) => {
  res.json(await products.getProduct(idParam(req.params.id)));
}));
router.put('/products/:id', mgr, asyncHandler(async (req, res) => {
  res.json(await products.updateProduct(idParam(req.params.id), parse(productPatch, req.body)));
}));
router.delete('/products/:id', mgr, asyncHandler(async (req, res) => {
  res.json(await products.deleteProduct(idParam(req.params.id)));
}));

// ---------- Stores ----------
router.post('/stores', mgr, asyncHandler(async (req, res) => {
  res.status(201).json(await stores.createStore(parse(storeBody, req.body)));
}));
router.get('/stores', asyncHandler(async (req, res) => {
  const q = parse(z.object({ search: searchText, city: searchText, ...paginationSchema }), req.query);
  res.json(await stores.listStores(q));
}));
router.get('/stores/:id', asyncHandler(async (req, res) => {
  res.json(await stores.getStore(idParam(req.params.id)));
}));
router.put('/stores/:id', mgr, asyncHandler(async (req, res) => {
  res.json(await stores.updateStore(idParam(req.params.id), parse(storePatch, req.body)));
}));
router.delete('/stores/:id', mgr, asyncHandler(async (req, res) => {
  res.json(await stores.deleteStore(idParam(req.params.id)));
}));

// ---------- Inventory ----------
router.get('/stores/:id/inventory', asyncHandler(async (req, res) => {
  const q = parse(z.object({ lowStock: optionalBool, search: searchText, category: searchText, ...paginationSchema }), req.query);
  res.json(await inventory.listInventory(idParam(req.params.id), q));
}));
router.get('/stores/:id/inventory/:productId', asyncHandler(async (req, res) => {
  res.json(await inventory.getInventoryItem(idParam(req.params.id), idParam(req.params.productId, 'productId')));
}));
router.put('/stores/:id/inventory/:productId', mgr, asyncHandler(async (req, res) => {
  res.json(await inventory.setStock(idParam(req.params.id), idParam(req.params.productId, 'productId'), parse(stockBody, req.body)));
}));
router.get('/stores/:id/inventory/:productId/movements', asyncHandler(async (req, res) => {
  const q = parse(z.object(paginationSchema), req.query);
  res.json(await inventory.listMovements(idParam(req.params.id), idParam(req.params.productId, 'productId'), q));
}));

// ---------- Orders ----------
router.post('/orders', asyncHandler(async (req, res) => {
  const body = parse(orderBody, req.body);
  const ids = body.items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) {
    throw badRequest('The same product cannot appear twice in one order', { duplicates: ids.filter((id, i) => ids.indexOf(id) !== i) }, 'DUPLICATE_PRODUCT');
  }
  res.status(201).json(await orders.placeOrder(body.storeId, body.items));
}));
router.get('/orders', asyncHandler(async (req, res) => {
  const q = parse(
    z.object({ storeId: z.coerce.number().int().min(1).optional(), status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED']).optional(), from: isoDate.optional(), to: isoDate.optional(), ...paginationSchema }),
    req.query,
  );
  res.json(await orders.listOrders(q));
}));
router.get('/orders/:id', asyncHandler(async (req, res) => {
  res.json(await orders.getOrder(idParam(req.params.id)));
}));
router.post('/orders/:id/cancel', mgr, asyncHandler(async (req, res) => {
  res.json(await orders.cancelOrder(idParam(req.params.id)));
}));

// ---------- Alerts ----------
router.get('/alerts', asyncHandler(async (req, res) => {
  const q = parse(
    z.object({ resolved: optionalBool, storeId: z.coerce.number().int().min(1).optional(), productId: z.coerce.number().int().min(1).optional(), ...paginationSchema }),
    req.query,
  );
  res.json(await alerts.listAlerts(q));
}));

// ---------- Users (managers) ----------
router.get('/users', mgr, asyncHandler(async (_req, res) => { res.json({ data: await auth.listUsers() }); }));
router.put('/users/:id/role', mgr, asyncHandler(async (req, res) => {
  const body = parse(z.object({ role: z.enum(['manager', 'staff']) }).strict(), req.body);
  res.json(await auth.setRole(idParam(req.params.id), body.role));
}));
