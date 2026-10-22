'use strict';
/* Inventory & Order Tracking: single-page UI. Talks to the REST API under /api. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (s) => (s ? new Date(s).toLocaleString() : '');

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const state = {
  stores: [], products: [], storeId: Number(store.get('storeId')) || null,
  tab: 'dashboard', timer: null, animated: false, cart: [], invMap: {},
  page: { orders: 1, products: 1 }, ordersStatus: '', productSearch: '', invSearch: '', invLow: false,
};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data && data.error ? data.error : { message: res.statusText };
    if (res.status === 401 && !path.startsWith('/auth/') && $('#gate').hidden) showAuth();
    throw Object.assign(new Error(e.message), { status: res.status, code: e.code, details: e.details });
  }
  return data;
}

function errMsg(e) {
  let m = e.message || 'Something went wrong';
  if (e.details && e.details.available !== undefined) m += ` (requested ${e.details.requested}, only ${e.details.available} available)`;
  if (Array.isArray(e.details)) m += ': ' + e.details.map((d) => `${d.field} ${d.message}`).join('; ');
  return m;
}
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 5000);
}
const run = async (fn) => { try { await fn(); } catch (e) { if (e.status !== 401) toast(errMsg(e), 'err'); } };
const isManager = () => state.user && state.user.role === 'manager';

function table(headers, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th class="${h.r ? 'r' : ''}">${esc(h.t ?? h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function pager(p, key) {
  if (p.totalPages <= 1) return `<div class="pager">${p.totalItems} item(s)</div>`;
  return `<div class="pager"><span>Page ${p.page} of ${p.totalPages}, ${p.totalItems} items</span>
    <button data-action="page" data-key="${key}" data-page="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>← Prev</button>
    <button data-action="page" data-key="${key}" data-page="${p.page + 1}" ${p.page >= p.totalPages ? 'disabled' : ''}>Next →</button></div>`;
}
const orderBadge = (s) => `<span class="badge ${s === 'CANCELLED' ? 'cancelled' : 'ok'}">${esc(s)}</span>`;
const noStore = () => ($('#view').innerHTML = '<div class="card"><h2>No stores yet</h2><p class="muted">Create your first store in the <b>Stores</b> tab to get started.</p></div>');

function formDialog({ title, fields, values = {}, submitLabel = 'Save', hint, onSubmit }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form id="dlgForm"><h3>${esc(title)}</h3>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}` +
    fields.map((f) => `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.required === false ? '' : 'required'} value="${esc(values[f.name] ?? '')}"></label>`).join('') +
    `<p class="err" id="dlgErr"></p><div class="row end"><button type="button" class="ghost" id="dlgCancel">Cancel</button><button class="primary">${esc(submitLabel)}</button></div></form>`;
  $('#dlgCancel').onclick = () => dlg.close();
  $('#dlgForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const data = {};
    for (const f of fields) {
      const raw = form.elements[f.name].value;
      if (raw === '' && f.required === false) continue;
      data[f.name] = f.type === 'number' ? Number(raw) : raw.trim();
    }
    try { await onSubmit(data); dlg.close(); } catch (e) { $('#dlgErr').textContent = errMsg(e); }
  };
  dlg.showModal();
}
function infoDialog(html) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<div>${html}<div class="row end" style="margin-top:14px"><button class="primary" id="dlgClose">Close</button></div></div>`;
  $('#dlgClose').onclick = () => dlg.close();
  dlg.showModal();
}

/* ---------- Views ---------- */
const views = {};

views.dashboard = async () => {
  if (!state.storeId) return noStore();
  const sid = state.storeId;
  const [all, low, alerts, orders] = await Promise.all([
    api(`/stores/${sid}/inventory?size=1`),
    api(`/stores/${sid}/inventory?lowStock=true&size=100`),
    api(`/alerts?resolved=false&storeId=${sid}&size=100`),
    api(`/orders?storeId=${sid}&size=5`),
  ]);
  const total = all.pagination.totalItems, lowN = low.pagination.totalItems;
  const out = low.data.filter((i) => i.quantity === 0).length;
  const since = Object.fromEntries(alerts.data.map((a) => [a.productId, a.createdAt]));
  const st = state.stores.find((s) => s.id === sid);
  const w = (n) => (total ? (n / total) * 100 : 0);
  const headline = !total ? 'No stock recorded yet' : lowN ? `${lowN} ${lowN === 1 ? 'item needs' : 'items need'} restocking` : 'Everything is stocked';
  const labels = low.data.map((i, k) => `<article class="label ${i.quantity === 0 ? 'out' : ''}" style="--i:${k}"><span class="hole"></span>
      <h3>${esc(i.name)}</h3><p class="sku">${esc(i.sku)}</p>
      <div class="qty"><b>${i.quantity}</b><span>${i.quantity === 0 ? 'sold out' : 'left'}, restock at ${i.lowStockThreshold}</span></div>
      <div class="gauge"><i style="width:${Math.min(100, (i.quantity / Math.max(i.lowStockThreshold, 1)) * 100)}%"></i></div>
      ${since[i.productId] ? `<p class="sku">Flagged ${when(since[i.productId])}</p>` : ''}
      <button class="restock" data-action="restock" data-pid="${i.productId}" data-name="${esc(i.name)}" data-qty="${i.quantity}" data-th="${i.lowStockThreshold}">Restock</button></article>`).join('');
  const orderRows = orders.data.map((o) => `<tr><td>#${o.id}</td><td>${when(o.createdAt)}</td><td class="r">${o.itemCount}</td><td class="r">${money(o.totalAmount)}</td><td>${orderBadge(o.status)}</td></tr>`);
  const anim = state.animated ? '' : 'rise';
  state.animated = true;
  $('#view').innerHTML = `<section class="hero"><h1>${esc(headline)}</h1>
      <p>${esc(st ? `${st.name}, ${st.city}. Refreshes every 10 seconds.` : '')}</p>
      <div class="health" role="img" aria-label="${total - lowN} well stocked, ${lowN - out} running low, ${out} sold out">
        <i class="g" style="width:${w(total - lowN)}%"></i><i class="y" style="width:${w(lowN - out)}%"></i><i class="r" style="width:${w(out)}%"></i></div>
      <div class="legend"><span style="--c:var(--green)"><b>${total - lowN}</b> well stocked</span><span style="--c:var(--sticker)"><b>${lowN - out}</b> running low</span><span style="--c:var(--red)"><b>${out}</b> sold out</span></div></section>
    ${lowN ? `<div class="shelf ${anim}">${labels}</div>` : '<p class="allgood">Nothing is running low. A label appears here the moment an item reaches its restock level.</p>'}
    <section class="card" style="margin-top:38px"><h2>Latest orders</h2>${table(['Order', 'Placed', { t: 'Items', r: 1 }, { t: 'Total', r: 1 }, 'Status'], orderRows, 'No orders yet. Place the first one from New order.')}</section>`;
  state.timer = setTimeout(() => { if (state.tab === 'dashboard') show('dashboard'); }, 10000);
};

views.inventory = async () => {
  if (!state.storeId) return noStore();
  const q = new URLSearchParams({ size: 100 });
  if (state.invSearch) q.set('search', state.invSearch);
  if (state.invLow) q.set('lowStock', 'true');
  const inv = await api(`/stores/${state.storeId}/inventory?${q}`);
  const rows = inv.data.map((i) => `<tr data-pid="${i.productId}"><td>${esc(i.sku)}</td><td>${esc(i.name)}<div class="muted">${esc(i.category)}</div></td>
    <td class="r">${money(i.price)}</td>
    <td><input class="num" type="number" min="0" step="1" data-f="quantity" value="${i.quantity}"></td>
    <td><input class="num" type="number" min="0" step="1" data-f="threshold" value="${i.lowStockThreshold}"></td>
    <td>${i.isLowStock ? '<span class="badge low">Low</span>' : '<span class="badge ok">OK</span>'}</td>
    <td class="r"><button data-action="saveStock" data-pid="${i.productId}">Save</button></td></tr>`);
  const options = state.products.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.sku)})</option>`).join('');
  $('#view').innerHTML = `
    <div class="card"><h2>Stock in this store</h2>
      <form data-form="invFilter" class="row" style="margin-bottom:12px">
        <label class="grow">Search<input name="search" placeholder="Name or SKU" value="${esc(state.invSearch)}"></label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="low" ${state.invLow ? 'checked' : ''}> Low stock only</label>
        <button class="primary">Apply</button></form>
      <p class="hint">Edit quantity or minimum level and press Save. A low-stock alert opens automatically when quantity ≤ minimum, and closes when restocked.</p>
      ${table(['SKU', 'Product', { t: 'Price', r: 1 }, 'Quantity', 'Min level', 'Status', ''], rows, 'No stock records. Add a product below.')}
      ${inv.pagination.totalItems > 100 ? '<p class="muted">Showing the first 100 items, use search to narrow down.</p>' : ''}</div>
    <div class="card mgr"><h2>Add a product to this store</h2>
      ${state.products.length ? `<form data-form="addStock" class="row">
        <label class="grow">Product<select name="productId">${options}</select></label>
        <label>Quantity<input class="num" name="quantity" type="number" min="0" step="1" value="10" required></label>
        <label>Min level<input class="num" name="threshold" type="number" min="0" step="1" value="10" required></label>
        <button class="primary">Add / set stock</button></form>` : '<p class="muted">Create products first in the Products tab.</p>'}</div>`;
  if (!isManager()) $('#view').querySelectorAll('[data-f]').forEach((i) => { i.disabled = true; });
};

views.neworder = async () => {
  if (!state.storeId) return noStore();
  const inv = await api(`/stores/${state.storeId}/inventory?size=100`);
  state.invMap = Object.fromEntries(inv.data.map((i) => [i.productId, i]));
  const avail = inv.data.filter((i) => i.quantity > 0);
  $('#view').innerHTML = `
    <div class="card"><h2>Place an order</h2>
      <p class="hint">Stock is deducted for all items in one step. If any item is short, the whole order is rejected and nothing changes.</p>
      ${avail.length ? `<div class="row">
        <label class="grow">Product<select id="ordProduct">${avail.map((i) => `<option value="${i.productId}">${esc(i.name)} (${esc(i.sku)}), ${i.quantity} in stock, ${money(i.price)}</option>`).join('')}</select></label>
        <label>Quantity<input class="num" id="ordQty" type="number" min="1" step="1" value="1"></label>
        <button class="primary" data-action="cartAdd">Add to order</button></div>` : '<p class="muted">No products have stock in this store. Add stock in the Stock tab.</p>'}
    </div>
    <div class="card"><h2>Current order</h2><div id="cart"></div></div>`;
  renderCart();
};
function renderCart() {
  const el = $('#cart');
  if (!el) return;
  const total = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const rows = state.cart.map((c) => `<tr><td>${esc(c.name)} <span class="muted">${esc(c.sku)}</span></td><td class="r">${c.qty}</td><td class="r">${money(c.price)}</td><td class="r">${money(c.price * c.qty)}</td><td class="r"><button class="danger" data-action="cartRemove" data-pid="${c.productId}">Remove</button></td></tr>`);
  el.innerHTML = table(['Item', { t: 'Qty', r: 1 }, { t: 'Price', r: 1 }, { t: 'Line total', r: 1 }, ''], rows, 'Your order is empty.') +
    (rows.length ? `<div class="row end" style="margin-top:12px"><b>Total: ${money(total)}</b><button class="primary" data-action="placeOrder">Place order</button></div>` : '');
}

views.orders = async () => {
  if (!state.storeId) return noStore();
  const q = new URLSearchParams({ size: 10, page: state.page.orders, storeId: state.storeId });
  if (state.ordersStatus) q.set('status', state.ordersStatus);
  const res = await api(`/orders?${q}`);
  const rows = res.data.map((o) => `<tr><td>#${o.id}</td><td>${when(o.createdAt)}</td><td class="r">${o.itemCount}</td><td class="r">${money(o.totalAmount)}</td><td>${orderBadge(o.status)}</td>
    <td class="r"><button data-action="viewOrder" data-id="${o.id}">Details</button>
    ${o.status === 'CONFIRMED' ? `<button class="danger" data-action="cancelOrder" data-id="${o.id}">Cancel</button>` : ''}</td></tr>`);
  $('#view').innerHTML = `<div class="card"><h2>Orders</h2>
    <div class="row" style="margin-bottom:12px"><label>Status<select data-change="ordersStatus">
      ${['', 'CONFIRMED', 'CANCELLED'].map((s) => `<option value="${s}" ${state.ordersStatus === s ? 'selected' : ''}>${s || 'All'}</option>`).join('')}</select></label></div>
    ${table(['Order', 'Placed', { t: 'Items', r: 1 }, { t: 'Total', r: 1 }, 'Status', ''], rows, 'No orders match.')}${pager(res.pagination, 'orders')}</div>`;
};

views.products = async () => {
  const q = new URLSearchParams({ size: 10, page: state.page.products });
  if (state.productSearch) q.set('search', state.productSearch);
  const res = await api(`/products?${q}`);
  const rows = res.data.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td class="r">${money(p.price)}</td>
    <td class="r"><button data-action="editProduct" data-id="${p.id}">Edit</button> <button class="danger" data-action="deleteProduct" data-id="${p.id}" data-name="${esc(p.name)}">Delete</button></td></tr>`);
  $('#view').innerHTML = `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Products</h2><button class="primary" data-action="newProduct">+ New product</button></div>
    <form data-form="productSearch" class="row" style="margin-bottom:12px"><label class="grow">Search<input name="search" placeholder="Name or SKU" value="${esc(state.productSearch)}"></label><button>Search</button></form>
    ${table(['SKU', 'Name', 'Category', { t: 'Price', r: 1 }, ''], rows, 'No products found.')}${pager(res.pagination, 'products')}</div>`;
};

views.stores = async () => {
  const res = await api('/stores?size=100');
  const rows = res.data.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.city)}</td>
    <td class="r"><button data-action="editStore" data-id="${s.id}">Edit</button> <button class="danger" data-action="deleteStore" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button></td></tr>`);
  $('#view').innerHTML = `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Stores</h2><button class="primary" data-action="newStore">+ New store</button></div>
    ${table(['Name', 'City', ''], rows, 'No stores yet.')}</div>`;
};

views.team = async () => {
  const { data } = await api('/users');
  const rows = data.map((u) => `<tr><td>${esc(u.name)}${u.id === state.user.id ? ' <span class="muted">(you)</span>' : ''}</td><td>${esc(u.email)}</td>
    <td><select data-change="role" data-id="${u.id}">${['manager', 'staff'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td><td>${when(u.createdAt)}</td></tr>`);
  $('#view').innerHTML = `<div class="card"><h2>Team</h2><p class="hint">Everyone with an account. Managers can edit products, stores and stock levels, and cancel orders. Staff can view stock and place orders. New accounts start as staff.</p>${table(['Name', 'Email', 'Role', 'Joined'], rows)}</div>`;
};

/* ---------- Sign in / sign up ---------- */
async function showAuth(mode = 'signin') {
  clearTimeout(state.timer);
  state.user = null;
  document.body.classList.add('gated');
  document.body.removeAttribute('data-role');
  const cfg = state.authCfg || (state.authCfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({})));
  const up = mode === 'signup';
  const needsInvite = up && cfg.inviteRequired;
  $('#gate').hidden = false;
  $('#gate').innerHTML = `<div class="gatecard"><span class="hole"></span>
    <div class="brand"><span class="mark"></span>Shelfline</div>
    <h1>${up ? 'Create your account' : 'Sign in'}</h1>
    <p class="hint">${up ? (cfg.firstUser ? 'You are the first person here, so this account will be the manager.' : 'New accounts start as staff. A manager can change your role later.') : 'Use the email and password for your store account.'}</p>
    <form id="authForm" novalidate>
      ${up ? '<label>Your name<input name="name" autocomplete="name" required></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required></label>
      ${up ? '<p class="hint" style="margin:-6px 0 0">At least 8 characters, with a letter and a number.</p>' : ''}
      ${needsInvite ? '<label>Invite code<input name="inviteCode" required></label>' : ''}
      <p class="err" id="authErr" role="alert"></p>
      <button class="primary">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="switch">${up ? 'Already have an account?' : 'New here?'} <button type="button" class="link" id="authSwitch">${up ? 'Sign in' : 'Create an account'}</button></p></div>`;
  $('#authSwitch').onclick = () => showAuth(up ? 'signin' : 'signup');
  $('#authForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      const r = await api(up ? '/auth/signup' : '/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      state.authCfg = null;
      await enter(r.user);
    } catch (err) { $('#authErr').textContent = errMsg(err); btn.disabled = false; }
  };
  $('#authForm input').focus();
}
async function enter(user) {
  state.user = user; state.animated = false; state.cart = [];
  document.body.dataset.role = user.role;
  document.body.classList.remove('gated');
  $('#gate').hidden = true; $('#gate').innerHTML = '';
  $('#meName').textContent = user.name;
  $('#meRole').textContent = user.role === 'manager' ? 'Manager' : 'Staff';
  try { await refreshRefs(); } catch (e) { if (e.status !== 401) toast(errMsg(e), 'err'); }
  show('dashboard');
}

async function show(tab) {
  clearTimeout(state.timer);
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  try { await views[tab](); } catch (e) { $('#view').innerHTML = `<div class="card"><h2>Could not load</h2><p class="err">${esc(errMsg(e))}</p></div>`; }
}
async function refreshRefs() {
  state.stores = (await api('/stores?size=100')).data;
  state.products = (await api('/products?size=100')).data;
  if (!state.stores.some((s) => s.id === state.storeId)) state.storeId = state.stores[0] ? state.stores[0].id : null;
  if (state.storeId) store.set('storeId', state.storeId);
  $('#storeSelect').innerHTML = state.stores.map((s) => `<option value="${s.id}" ${s.id === state.storeId ? 'selected' : ''}>${esc(s.name)} (${esc(s.city)})</option>`).join('') || '<option>(no stores)</option>';
}

/* ---------- Actions (event delegation) ---------- */
const productFields = [
  { name: 'sku', label: 'SKU (unique)' }, { name: 'name', label: 'Name' }, { name: 'category', label: 'Category' },
  { name: 'price', label: 'Price (₹)', type: 'number', step: '0.01', min: 0 },
];
const storeFields = [{ name: 'name', label: 'Store name' }, { name: 'city', label: 'City' }];
const stockPut = (pid, quantity, lowStockThreshold) =>
  api(`/stores/${state.storeId}/inventory/${pid}`, { method: 'PUT', body: { quantity, ...(lowStockThreshold !== undefined && { lowStockThreshold }) } });

const actions = {
  logout: () => run(async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { showAuth(); } }),
  page: (b) => { state.page[b.dataset.key] = Number(b.dataset.page); show(state.tab); },
  restock: (b) => formDialog({
    title: `Restock: ${b.dataset.name}`, hint: `Currently ${b.dataset.qty} in stock. Enter the NEW total quantity.`,
    fields: [{ name: 'quantity', label: 'New total quantity', type: 'number', min: 0, step: '1' }],
    values: { quantity: Number(b.dataset.th) + 20 },
    onSubmit: async (d) => { await stockPut(b.dataset.pid, d.quantity); toast('Stock updated'); show('dashboard'); },
  }),
  saveStock: (b) => run(async () => {
    const tr = b.closest('tr');
    await stockPut(b.dataset.pid, Number(tr.querySelector('[data-f=quantity]').value), Number(tr.querySelector('[data-f=threshold]').value));
    toast('Stock saved'); show('inventory');
  }),
  cartAdd: () => {
    const pid = Number($('#ordProduct').value), qty = Number($('#ordQty').value);
    const item = state.invMap[pid];
    if (!item || !Number.isInteger(qty) || qty < 1) return toast('Enter a whole number of at least 1', 'err');
    const existing = state.cart.find((c) => c.productId === pid);
    if (existing) existing.qty += qty;
    else state.cart.push({ productId: pid, name: item.name, sku: item.sku, price: item.price, qty });
    renderCart();
  },
  cartRemove: (b) => { state.cart = state.cart.filter((c) => c.productId !== Number(b.dataset.pid)); renderCart(); },
  placeOrder: (b) => run(async () => {
    b.disabled = true;
    try {
      const order = await api('/orders', { method: 'POST', body: { storeId: state.storeId, items: state.cart.map((c) => ({ productId: c.productId, quantity: c.qty })) } });
      toast(`Order #${order.id} placed: ${money(order.totalAmount)}`);
      state.cart = []; show('neworder');
    } finally { b.disabled = false; }
  }),
  viewOrder: (b) => run(async () => {
    const o = await api(`/orders/${b.dataset.id}`);
    infoDialog(`<h3>Order #${o.id} ${orderBadge(o.status)}</h3><p class="muted">Placed ${when(o.createdAt)}${o.cancelledAt ? ', cancelled ' + when(o.cancelledAt) : ''}</p>` +
      table(['Item', { t: 'Qty', r: 1 }, { t: 'Unit price', r: 1 }, { t: 'Total', r: 1 }],
        o.items.map((i) => `<tr><td>${esc(i.name)}<div class="muted">${esc(i.sku)}</div></td><td class="r">${i.quantity}</td><td class="r">${money(i.unitPrice)}</td><td class="r">${money(i.lineTotal)}</td></tr>`)) +
      `<p style="text-align:right"><b>Total ${money(o.totalAmount)}</b></p>`);
  }),
  cancelOrder: (b) => run(async () => {
    if (!confirm(`Cancel order #${b.dataset.id}? Its items will be returned to stock.`)) return;
    await api(`/orders/${b.dataset.id}/cancel`, { method: 'POST' });
    toast(`Order #${b.dataset.id} cancelled and stock restored`); show('orders');
  }),
  newProduct: () => formDialog({ title: 'New product', fields: productFields, onSubmit: async (d) => { await api('/products', { method: 'POST', body: d }); await refreshRefs(); toast('Product created'); show('products'); } }),
  editProduct: (b) => run(async () => {
    const p = await api(`/products/${b.dataset.id}`);
    formDialog({ title: `Edit ${p.name}`, fields: productFields, values: p, onSubmit: async (d) => { await api(`/products/${p.id}`, { method: 'PUT', body: d }); await refreshRefs(); toast('Product updated'); show('products'); } });
  }),
  deleteProduct: (b) => run(async () => {
    if (!confirm(`Delete "${b.dataset.name}"? Products with order history are archived (hidden) rather than erased.`)) return;
    const r = await api(`/products/${b.dataset.id}`, { method: 'DELETE' });
    await refreshRefs(); toast(r.mode === 'soft' ? 'Product archived (it has order history)' : 'Product deleted'); show('products');
  }),
  newStore: () => formDialog({ title: 'New store', fields: storeFields, onSubmit: async (d) => { await api('/stores', { method: 'POST', body: d }); await refreshRefs(); toast('Store created'); show('stores'); } }),
  editStore: (b) => run(async () => {
    const s = await api(`/stores/${b.dataset.id}`);
    formDialog({ title: `Edit ${s.name}`, fields: storeFields, values: s, onSubmit: async (d) => { await api(`/stores/${s.id}`, { method: 'PUT', body: d }); await refreshRefs(); toast('Store updated'); show('stores'); } });
  }),
  deleteStore: (b) => run(async () => {
    if (!confirm(`Delete store "${b.dataset.name}"?`)) return;
    await api(`/stores/${b.dataset.id}`, { method: 'DELETE' });
    await refreshRefs(); toast('Store deleted'); show('stores');
  }),
};

const forms = {
  invFilter: (f) => { state.invSearch = f.search.value.trim(); state.invLow = f.low.checked; show('inventory'); },
  productSearch: (f) => { state.productSearch = f.search.value.trim(); state.page.products = 1; show('products'); },
  addStock: (f) => run(async () => {
    await stockPut(f.productId.value, Number(f.quantity.value), Number(f.threshold.value));
    toast('Stock set'); show('inventory');
  }),
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return show(tab.dataset.tab);
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action]) actions[b.dataset.action](b);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (f && forms[f.dataset.form]) { e.preventDefault(); forms[f.dataset.form](f); }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.change === 'ordersStatus') { state.ordersStatus = e.target.value; state.page.orders = 1; show('orders'); }
  if (e.target.dataset && e.target.dataset.change === 'role') {
    const { id } = e.target.dataset, role = e.target.value;
    run(async () => {
      try { await api(`/users/${id}/role`, { method: 'PUT', body: { role } }); toast('Role updated'); }
      finally { if (Number(id) === state.user.id) location.reload(); else show('team'); }
    });
  }
  if (e.target.id === 'storeSelect') { state.storeId = Number(e.target.value); store.set('storeId', state.storeId); state.cart = []; state.page.orders = 1; show(state.tab); }
});

(async () => {
  try { await enter((await api('/auth/me')).user); } catch { showAuth(); }
})();
