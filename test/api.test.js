'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { createApp } = require('../server/index');
const { hashPassword } = require('../server/auth');
const T = require('../public/tariffs.js');

function setup() {
  const db = open(':memory:');
  const server = createApp({ db }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // Мини-клиент с собственной cookie-сессией.
  function client() {
    let cookie = '';
    return async function call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };
  }
  return { db, server, base, client };
}

const user = { name: 'Иван', email: 'ivan@example.com', phone: '8 900 123-45-67', password: 'secret123' };

test('регистрация, вход, профиль и выход', async (t) => {
  const { server, client } = setup();
  t.after(() => server.close());
  const c = client();

  assert.equal((await c('GET', '/api/me')).status, 401);

  const reg = await c('POST', '/api/auth/register', user);
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.phone, '+7 (900) 123-45-67');
  assert.equal(reg.data.user.role, 'client');
  assert.equal(reg.data.user.password_hash, undefined);

  assert.equal((await c('POST', '/api/auth/register', { ...user, email: 'IVAN@example.com' })).status, 409);
  assert.equal((await c('GET', '/api/me')).data.user.email, 'ivan@example.com');

  const upd = await c('PATCH', '/api/me', { name: 'Иван П.', phone: '+79001112233' });
  assert.equal(upd.data.user.name, 'Иван П.');

  assert.equal((await c('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401);

  assert.equal((await c('POST', '/api/auth/login', { email: user.email, password: 'wrong-pass' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'Ivan@Example.com', password: user.password })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);
});

test('валидация регистрации', async (t) => {
  const { server, client } = setup();
  t.after(() => server.close());
  const c = client();
  assert.equal((await c('POST', '/api/auth/register', { ...user, password: 'short' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { ...user, email: 'not-email' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { ...user, phone: '123' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { ...user, name: '' })).status, 400);
});

test('заказы: цена считается на сервере, чужие заказы недоступны', async (t) => {
  const { server, client } = setup();
  t.after(() => server.close());
  const a = client();
  const b = client();
  await a('POST', '/api/auth/register', user);
  await b('POST', '/api/auth/register', { ...user, email: 'petr@example.com' });

  const created = await a('POST', '/api/orders', {
    city: 'Москва', carType: 'suv', options: ['closed', 'door', 'door', 'bogus'],
    carModel: 'Toyota Land Cruiser', vin: 'jtmhv05j604123456', price: 1
  });
  assert.equal(created.status, 201);
  const expected = T.quote('Москва', 'suv', ['closed', 'door']);
  assert.equal(created.data.order.price, expected.price);
  assert.deepEqual(created.data.order.options, ['closed', 'door']);
  assert.equal(created.data.order.vin, 'JTMHV05J604123456');
  assert.equal(created.data.order.number, 'КЭ-00001');
  assert.equal(created.data.order.events.length, 1);
  assert.equal(created.data.order.client, undefined);

  const id = created.data.order.id;
  assert.equal((await a('GET', '/api/orders')).data.orders.length, 1);
  assert.equal((await b('GET', '/api/orders')).data.orders.length, 0);
  assert.equal((await b('GET', `/api/orders/${id}`)).status, 404);
  assert.equal((await b('POST', `/api/orders/${id}/cancel`, {})).status, 404);
  assert.equal((await a('PATCH', `/api/orders/${id}/status`, { status: 'delivered' })).status, 403);

  assert.equal((await a('POST', '/api/orders', { city: 'Атлантида', carType: 'sedan', carModel: 'X' })).status, 400);
  assert.equal((await a('POST', '/api/orders', { city: 'Москва', carType: 'sedan', carModel: '' })).status, 400);
  assert.equal((await a('POST', '/api/orders', { city: 'Москва', carType: 'sedan', carModel: 'X', vin: 'bad' })).status, 400);

  const cancelled = await a('POST', `/api/orders/${id}/cancel`, {});
  assert.equal(cancelled.data.order.status, 'cancelled');
  assert.equal((await a('POST', `/api/orders/${id}/cancel`, {})).status, 409);
});

test('менеджер видит все заказы, меняет статусы и заявки', async (t) => {
  const { db, server, client } = setup();
  t.after(() => server.close());
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'manager')")
    .run('boss@example.com', hashPassword('manager123'), 'Менеджер');

  const c = client();
  const m = client();
  await c('POST', '/api/auth/register', user);
  const order = (await c('POST', '/api/orders', { city: 'Иркутск', carType: 'sedan', carModel: 'Honda Fit' })).data.order;

  assert.equal((await m('POST', '/api/auth/login', { email: 'boss@example.com', password: 'manager123' })).data.user.role, 'manager');
  const all = await m('GET', '/api/orders');
  assert.equal(all.data.orders.length, 1);
  assert.equal(all.data.orders[0].client.email, user.email);

  assert.equal((await m('PATCH', `/api/orders/${order.id}/status`, { status: 'teleported' })).status, 400);
  const upd = await m('PATCH', `/api/orders/${order.id}/status`, { status: 'in_transit', note: 'Выехали из Владивостока' });
  assert.equal(upd.data.order.status, 'in_transit');
  assert.equal(upd.data.order.events.at(-1).note, 'Выехали из Владивостока');

  const seen = await c('GET', `/api/orders/${order.id}`);
  assert.equal(seen.data.order.status, 'in_transit');
  assert.equal(seen.data.order.events.length, 2);
  assert.equal((await c('POST', `/api/orders/${order.id}/cancel`, {})).status, 409);

  assert.equal((await m('GET', '/api/orders?status=in_transit')).data.orders.length, 1);
  assert.equal((await m('GET', '/api/orders?status=delivered')).data.orders.length, 0);

  const anon = client();
  assert.equal((await anon('POST', '/api/leads', { name: 'Олег', phone: '+7 (914) 000-11-22', route: 'Владивосток → Омск' })).status, 201);
  assert.equal((await anon('GET', '/api/leads')).status, 401);
  assert.equal((await c('GET', '/api/leads')).status, 403);
  const leads = await m('GET', '/api/leads');
  assert.equal(leads.data.leads.length, 1);
  assert.equal((await m('PATCH', `/api/leads/${leads.data.leads[0].id}`, { processed: true })).status, 200);
  assert.equal((await m('PATCH', '/api/leads/999', { processed: true })).status, 404);

  const stats = await m('GET', '/api/stats');
  assert.deepEqual(stats.data.stats, { orders: 1, active: 1, clients: 1, newLeads: 0 });
});

test('защита: CSRF, битый JSON, заголовки, лимит входа', async (t) => {
  const { server, base, client } = setup();
  t.after(() => server.close());

  const form = await fetch(base + '/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.equal(form.status, 415);

  const c = client();
  assert.equal((await c('POST', '/api/leads', { name: 'X', phone: '+79140001122' }, { Origin: 'https://evil.example' })).status, 403);

  const broken = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);

  const page = await fetch(base + '/account');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-powered-by'), null);

  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/auth/login', { email: 'a@b.cc', password: 'whatever1' });
  assert.equal(last.status, 429);
});
