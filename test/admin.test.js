'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, addStaff } = require('./helpers');
const T = require('../public/tariffs.js');

const client = { name: 'Иван Петров', email: 'ivan@example.com', phone: '+7 900 123-45-67', password: 'secret123' };

async function world(t) {
  const env = setup();
  t.after(() => env.server.close());
  const adminCreds = addStaff(env.db, 'admin', 'admin@example.com', 'adminpass1', 'Админ');
  const managerCreds = addStaff(env.db, 'manager', 'manager@example.com', 'managerpass1', 'Анна');
  const a = env.client();
  const m = env.client();
  const c = env.client();
  assert.equal((await a('POST', '/api/auth/login', adminCreds)).status, 200);
  assert.equal((await m('POST', '/api/auth/login', managerCreds)).status, 200);
  assert.equal((await c('POST', '/api/auth/register', client)).status, 201);
  return { ...env, a, m, c };
}

test('доступ по ролям', async (t) => {
  const { a, m, c, client: mk } = await world(t);
  const anon = mk();
  assert.equal((await anon('GET', '/api/admin/dashboard')).status, 401);
  assert.equal((await c('GET', '/api/admin/dashboard')).status, 403);
  assert.equal((await m('GET', '/api/admin/dashboard')).status, 200);
  assert.equal((await a('GET', '/api/admin/dashboard')).status, 200);

  for (const [method, path] of [['GET', '/api/admin/staff'], ['PUT', '/api/admin/tariffs'], ['PUT', '/api/admin/settings'], ['GET', '/api/admin/audit']]) {
    assert.equal((await m(method, path, method === 'GET' ? undefined : {})).status, 403, path);
  }
});

test('заказы: поиск, фильтры, редактирование, статус, CSV, удаление', async (t) => {
  const { a, m, c, base } = await world(t);
  const o1 = (await c('POST', '/api/orders', { city: 'Москва', carType: 'sedan', carModel: 'Toyota Camry' })).data.order;
  await c('POST', '/api/orders', { city: 'Иркутск', carType: 'suv', carModel: 'Lexus LX' });

  const byName = await m('GET', '/api/admin/orders?q=' + encodeURIComponent('ПЕТРОВ'));
  assert.equal(byName.data.total, 2, 'поиск по кириллице без учёта регистра');
  assert.equal((await m('GET', '/api/admin/orders?q=' + encodeURIComponent('кэ-00001'))).data.orders[0].id, o1.id);
  assert.equal((await m('GET', '/api/admin/orders?q=1234567')).data.total, 2, 'поиск по цифрам телефона');
  assert.equal((await m('GET', '/api/admin/orders?q=lexus')).data.total, 1);
  assert.equal((await m('GET', '/api/admin/orders?status=new')).data.total, 2);
  assert.equal((await m('GET', '/api/admin/orders?from=bad')).status, 400);

  const upd = await m('PATCH', `/api/admin/orders/${o1.id}`, {
    price: 120000, driver: 'Сергей', truck: 'А123ВС 125', eta: '2026-10-05', paymentStatus: 'prepaid', paidAmount: 12000, managerNote: 'VIP', city: 'Казань'
  });
  assert.equal(upd.status, 200);
  const o = upd.data.order;
  assert.equal(o.price, 120000);
  assert.equal(o.city, 'Казань');
  assert.equal(o.km, T.findCity(T.DEFAULTS, 'Казань').km, 'расстояние обновилось вместе с городом');
  assert.equal(o.driver, 'Сергей');
  assert.equal(o.paymentStatus, 'prepaid');
  assert.equal(o.client.email, client.email);
  assert.equal((await m('PATCH', `/api/admin/orders/${o1.id}`, { paymentStatus: 'free' })).status, 400);
  assert.equal((await m('PATCH', `/api/admin/orders/${o1.id}`, { eta: '05.10.2026' })).status, 400);

  // Клиент видит ETA и оплату, но не внутренние поля.
  const seen = (await c('GET', `/api/orders/${o1.id}`)).data.order;
  assert.equal(seen.eta, '2026-10-05');
  assert.equal(seen.paymentStatus, 'prepaid');
  assert.equal(seen.managerNote, undefined);
  assert.equal(seen.driver, undefined);

  const st = await m('POST', `/api/admin/orders/${o1.id}/status`, { status: 'in_transit', note: 'Выехали' });
  assert.equal(st.data.order.status, 'in_transit');
  assert.equal(st.data.order.events.at(-1).note, 'Выехали');
  assert.equal((await m('GET', '/api/admin/orders?status=active')).data.total, 1);

  const csv = await fetch(base + '/api/admin/orders.csv', { headers: { Cookie: (await loginCookie(base, 'manager@example.com', 'managerpass1')) } });
  const bytes = Buffer.from(await csv.arrayBuffer());
  const text = bytes.toString('utf8');
  assert.equal(csv.status, 200);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM для Excel');
  assert.ok(text.startsWith('﻿Номер;'));
  assert.ok(text.includes('КЭ-00001'));

  assert.equal((await m('DELETE', `/api/admin/orders/${o1.id}`)).status, 403, 'менеджер не удаляет');
  assert.equal((await a('DELETE', `/api/admin/orders/${o1.id}`)).status, 200);
  assert.equal((await c('GET', `/api/orders/${o1.id}`)).status, 404);
});

async function loginCookie(base, email, password) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie').split(';')[0];
}

test('менеджер оформляет заказ новому клиенту из заявки', async (t) => {
  const { m, client: mk } = await world(t);
  const anon = mk();
  await anon('POST', '/api/leads', {
    name: 'Олег', phone: '+7 914 000-11-22', company: 'ООО «Автодилер»', email: 'Oleg@Dealer.ru',
    message: '20 машин в месяц, Казань → Москва', route: 'Владивосток → Омск'
  });
  const lead = (await m('GET', '/api/admin/leads?status=new')).data.leads[0];
  assert.equal(lead.company, 'ООО «Автодилер»');
  assert.equal(lead.email, 'oleg@dealer.ru');
  assert.equal((await m('GET', `/api/admin/leads?q=${encodeURIComponent('автодилер')}`)).data.leads.length, 1, 'поиск по компании');

  const res = await m('POST', '/api/admin/orders', {
    client: { name: 'Олег', phone: '+7 914 000-11-22' }, leadId: lead.id,
    city: 'Омск', carType: 'crossover', options: ['door'], carModel: 'Honda Vezel', price: 99000
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.order.price, 99000, 'ручная цена');
  assert.equal(res.data.order.client.email, null);
  assert.equal((await m('GET', `/api/admin/leads?q=${encodeURIComponent('олег')}`)).data.leads[0].status, 'done');

  const auto = await m('POST', '/api/admin/orders', { clientId: res.data.order.client.id, city: 'Омск', carType: 'sedan', carModel: 'Mazda 3' });
  assert.equal(auto.data.order.price, T.quote(T.DEFAULTS, 'Омск', 'sedan', []).price, 'цена по тарифу');
  assert.equal((await m('POST', '/api/admin/orders', { clientId: 999, city: 'Омск', carType: 'sedan', carModel: 'X' })).status, 400);
  assert.equal((await m('POST', '/api/admin/orders', { clientId: res.data.order.client.id, city: 'Омск', carType: 'sedan' })).status, 400);

  // Любой маршрут: цену без тарифа менеджер ставит сам; смена маршрута пересчитывает расстояние.
  const free = (await m('POST', '/api/admin/orders', {
    clientId: res.data.order.client.id, origin: 'Казань', city: 'Москва', carType: 'sedan', carModel: 'Geely Coolray', price: 45000
  })).data.order;
  assert.equal(free.origin, 'Казань');
  assert.equal(free.price, 45000);
  assert.equal(free.km, 0);
  const moved = (await m('PATCH', `/api/admin/orders/${free.id}`, { origin: 'Владивосток' })).data.order;
  assert.equal(moved.km, T.DEFAULTS.cities.find((x) => x.name === 'Москва').km);
  assert.equal(moved.price, 45000, 'цена при смене маршрута не меняется');

  const cl = await m('GET', `/api/admin/clients/${res.data.order.client.id}`);
  assert.equal(cl.data.orders.length, 3);
  assert.equal(cl.data.client.hasPassword, false);
});

test('клиенты: редактирование, пароль, блокировка', async (t) => {
  const { m, c, client: mk } = await world(t);
  const list = await m('GET', '/api/admin/clients?q=' + encodeURIComponent('иван'));
  assert.equal(list.data.total, 1);
  const id = list.data.clients[0].id;

  assert.equal((await m('PATCH', `/api/admin/clients/${id}`, { note: 'Постоянный клиент' })).data.client.note, 'Постоянный клиент');
  assert.equal((await m('PATCH', `/api/admin/clients/${id}`, { email: 'manager@example.com' })).status, 409);

  assert.equal((await m('PATCH', `/api/admin/clients/${id}`, { blocked: true })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401, 'сессии заблокированного завершены');
  const again = mk();
  assert.equal((await again('POST', '/api/auth/login', client)).status, 403);

  await m('PATCH', `/api/admin/clients/${id}`, { blocked: false });
  assert.equal((await m('POST', `/api/admin/clients/${id}/password`, { password: 'newpass123' })).status, 200);
  assert.equal((await again('POST', '/api/auth/login', { email: client.email, password: 'newpass123' })).status, 200);

  // Клиента без пароля, созданного менеджером, нельзя «перехватить» регистрацией.
  const created = await m('POST', '/api/admin/clients', { name: 'Без пароля', phone: '+79140000000', email: 'nopass@example.com' });
  assert.equal(created.status, 201);
  const reg = await mk()('POST', '/api/auth/register', { name: 'X', phone: '+79140000001', email: 'nopass@example.com', password: 'whatever1' });
  assert.equal(reg.status, 409);
  assert.equal((await mk()('POST', '/api/auth/login', { email: 'nopass@example.com', password: '' })).status, 401);
});

test('сотрудники: создание, роли, защита последнего админа', async (t) => {
  const { a, db, client: mk } = await world(t);
  const created = await a('POST', '/api/admin/staff', { name: 'Пётр', email: 'petr@example.com', password: 'petrpass1', role: 'manager' });
  assert.equal(created.status, 201);
  const p = mk();
  assert.equal((await p('POST', '/api/auth/login', { email: 'petr@example.com', password: 'petrpass1' })).data.user.role, 'manager');

  const staff = (await a('GET', '/api/admin/staff')).data.staff;
  const me = staff.find((s) => s.email === 'admin@example.com');
  assert.equal((await a('PATCH', `/api/admin/staff/${me.id}`, { role: 'manager' })).status, 400, 'нельзя понизить себя');
  assert.equal((await a('PATCH', `/api/admin/staff/${me.id}`, { blocked: true })).status, 400);

  const petr = created.data.user;
  await a('PATCH', `/api/admin/staff/${petr.id}`, { role: 'admin' });
  assert.equal((await p('GET', '/api/admin/staff')).status, 401, 'смена роли завершает сессии');
  assert.equal((await p('POST', '/api/auth/login', { email: 'petr@example.com', password: 'petrpass1' })).status, 200);
  assert.equal((await p('PATCH', `/api/admin/staff/${me.id}`, { blocked: true })).status, 200, 'другой админ может заблокировать');
  assert.equal((await p('PATCH', `/api/admin/staff/${petr.id}`, { role: 'manager' })).status, 400);
  db.prepare("UPDATE users SET blocked = 0 WHERE email = 'admin@example.com'").run();
});

test('тарифы и настройки влияют на сайт и расчёт', async (t) => {
  const { a, c, m } = await world(t);
  const tariffs = (await a('GET', '/api/admin/tariffs')).data;
  const moscow = tariffs.cities.find((x) => x.name === 'Москва');
  moscow.price = 200000;
  tariffs.cities.push({ name: 'Магадан', km: 3900, days: [10, 14], price: 180000, active: true });
  tariffs.cities.find((x) => x.name === 'Якутск').active = false;
  tariffs.carTypes = tariffs.carTypes.filter((x) => x.key !== 'van');
  tariffs.options.push({ label: 'Мойка перед выдачей', hint: '', percent: 0, fixed: 3000, active: true });

  const saved = await a('PUT', '/api/admin/tariffs', tariffs);
  assert.equal(saved.status, 200);

  const pub = (await c('GET', '/api/tariffs')).data;
  assert.equal(pub.cities.find((x) => x.name === 'Москва').price, 200000);
  assert.ok(pub.cities.find((x) => x.name === 'Магадан'));
  assert.equal(pub.cities.find((x) => x.name === 'Якутск'), undefined, 'отключённый город скрыт');
  assert.equal(pub.carTypes.find((x) => x.key === 'van'), undefined);
  const wash = pub.options.find((x) => x.label === 'Мойка перед выдачей');
  assert.match(wash.key, /^opt_[0-9a-f]{8}$/);

  const order = (await c('POST', '/api/orders', { city: 'Москва', carType: 'sedan', options: [wash.key], carModel: 'Kia Rio' })).data.order;
  assert.equal(order.price, 203000);
  assert.deepEqual(order.optionLabels, ['Мойка перед выдачей']);
  assert.equal((await c('POST', '/api/orders', { city: 'Якутск', carType: 'sedan', carModel: 'X' })).data.order.price, 0, 'отключённый город — без тарифа');

  // Опция, использованная в заказе, при удалении из тарифов только отключается — название в заказе сохраняется.
  const again = (await a('GET', '/api/admin/tariffs')).data;
  again.options = again.options.filter((x) => x.key !== wash.key);
  await a('PUT', '/api/admin/tariffs', again);
  assert.equal((await a('GET', '/api/admin/tariffs')).data.options.find((x) => x.key === wash.key).active, false);
  assert.deepEqual((await m('GET', `/api/admin/orders/${order.id}`)).data.order.optionLabels, ['Мойка перед выдачей']);

  assert.equal((await a('PUT', '/api/admin/tariffs', { ...again, cities: [{ name: 'А', km: 1, days: [5, 2], price: 1 }] })).status, 400);
  assert.equal((await a('PUT', '/api/admin/tariffs', { ...again, cities: again.cities.map((x) => ({ ...x, active: false })) })).status, 400);

  const s = await a('PUT', '/api/admin/settings', { phone: '84232000000', email: 'hello@cargo.ru', address: 'Владивосток', hours: '9–18', telegram: 'https://t.me/cargo', whatsapp: '', vk: '' });
  assert.equal(s.status, 200);
  assert.equal((await c('GET', '/api/settings')).data.settings.phone, '+7 (423) 200-00-00');
  assert.equal((await a('PUT', '/api/admin/settings', { phone: '84232000000', email: 'x@y.ru', telegram: 'javascript:alert(1)' })).status, 400);
  const about = await a('PUT', '/api/admin/settings', { phone: '84232000000', email: 'x@y.ru', about: 'Работаем с 2015 года.\nСвой парк.', requisites: 'ООО «Карго Экспресс», ИНН 0000000000' });
  assert.equal(about.status, 200);
  assert.equal((await c('GET', '/api/settings')).data.settings.about, 'Работаем с 2015 года.\nСвой парк.');

  const log = (await a('GET', '/api/admin/audit')).data;
  assert.ok(log.entries.some((e) => e.action === 'Обновил тарифы' && e.user === 'Админ'));
});

test('дашборд считает показатели', async (t) => {
  const { m, c } = await world(t);
  await c('POST', '/api/orders', { city: 'Москва', carType: 'sedan', carModel: 'A' });
  const o2 = (await c('POST', '/api/orders', { city: 'Иркутск', carType: 'sedan', carModel: 'B' })).data.order;
  await m('POST', `/api/admin/orders/${o2.id}/status`, { status: 'in_transit' });

  const d = (await m('GET', '/api/admin/dashboard')).data;
  assert.equal(d.kpi.ordersMonth, 2);
  assert.equal(d.kpi.revenueMonth, 135000 + 65000);
  assert.equal(d.kpi.inTransit, 1);
  assert.equal(d.kpi.newOrders, 1);
  assert.equal(d.kpi.clients, 1);
  assert.equal(d.daily.length, 30);
  assert.equal(d.daily.at(-1).orders, 2);
  assert.equal(d.cities[0].orders, 1);
  assert.equal(d.recentOrders.length, 2);
});
