'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const T = require('../public/tariffs.js');

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

  assert.equal((await c('POST', '/api/auth/logout')).status, 200, 'выход без тела запроса');
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
  const expected = T.quote(T.DEFAULTS, 'Москва', 'suv', ['closed', 'door']);
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
  assert.equal((await a('POST', `/api/admin/orders/${id}/status`, { status: 'delivered' })).status, 403);
  assert.equal((await a('GET', '/api/admin/orders')).status, 403);

  // Маршрут без тарифа принимается без цены — её назначит менеджер.
  const custom = (await a('POST', '/api/orders', { origin: 'Казань', city: 'Сочи', carType: 'sedan', carModel: 'X' })).data.order;
  assert.equal(custom.origin, 'Казань');
  assert.equal(custom.city, 'Сочи');
  assert.equal(custom.price, 0);
  assert.match(custom.events[0].note, /рассчитает менеджер/);
  // Обратное направление считается по тому же тарифу.
  const back = (await a('POST', '/api/orders', { origin: 'москва', city: 'Владивосток', carType: 'sedan', carModel: 'X' })).data.order;
  assert.equal(back.price, T.quote(T.DEFAULTS, 'Москва', 'sedan', []).price);
  assert.equal((await a('POST', '/api/orders', { city: 'Москва', carType: 'boat', carModel: 'X' })).status, 400);
  assert.equal((await a('POST', '/api/orders', { origin: 'Казань', city: '', carType: 'sedan', carModel: 'X' })).status, 400);
  assert.equal((await a('POST', '/api/orders', { city: 'Москва', carType: 'sedan', carModel: '' })).status, 400);
  assert.equal((await a('POST', '/api/orders', { city: 'Москва', carType: 'sedan', carModel: 'X', vin: 'bad' })).status, 400);

  const cancelled = await a('POST', `/api/orders/${id}/cancel`);
  assert.equal(cancelled.data.order.status, 'cancelled');
  assert.equal((await a('POST', `/api/orders/${id}/cancel`, {})).status, 409);
});

test('защита: CSRF, битый JSON, заголовки, лимит входа', async (t) => {
  const { server, base, client } = setup();
  t.after(() => server.close());

  const form = await fetch(base + '/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.equal(form.status, 415);
  const plain = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(plain.status, 415);
  const noBodyCrossSite = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(noBodyCrossSite.status, 403);

  const c = client();
  assert.equal((await c('POST', '/api/leads', { name: 'X', phone: '+79140001122' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c('POST', '/api/leads', { name: 'X', phone: '+79140001122', email: 'не почта' })).status, 400);

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
