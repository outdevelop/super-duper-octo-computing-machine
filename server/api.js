'use strict';

// API сайта и личного кабинета клиента.

const express = require('express');
const T = require('../public/tariffs.js');
const v = require('./validate');
const { hashPassword, verifyPassword, DUMMY_HASH, createRateLimiter } = require('./auth');
const { tx } = require('./db');
const { serializeOrder, createOrderQueries, withEvents } = require('./orders');

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, createdAt: u.created_at };
}

function createApi(db, auth, store) {
  const router = express.Router();
  const perMinute = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
  const byIp = (req) => req.ip;
  const oq = createOrderQueries(db);

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, name, phone) VALUES (?, ?, ?, ?)'),
    updateProfile: db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    ordersByUser: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC'),
    insertLead: db.prepare('INSERT INTO leads (name, phone, company, email, message, route, estimate, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  };

  function ownOrder(req) {
    const order = oq.byId.get(v.id(req.params.id));
    // Чужой заказ отдаём как «не найден», чтобы не раскрывать существование id.
    if (!order || order.user_id !== req.user.id) throw new v.HttpError(404, 'Заказ не найден');
    return order;
  }

  function clientOrder(order) {
    return withEvents(oq, order, serializeOrder(order, store.labelTariffs()));
  }

  /* ---------- Справочники ---------- */

  router.get('/tariffs', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(store.publicTariffs());
  });

  router.get('/settings', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ settings: store.settings() });
  });

  /* ---------- Auth ---------- */

  router.post('/auth/register', perMinute(byIp), (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { max: 100, required: true, field: 'Имя' });
    const email = v.email(b.email);
    const phone = v.phone(b.phone, { required: true });
    const pass = v.password(b.password);

    const existing = q.userByEmail.get(email);
    if (existing) {
      throw new v.HttpError(409, existing.password_hash
        ? 'Пользователь с таким email уже зарегистрирован'
        : 'Аккаунт с этим email создал менеджер. Позвоните нам — поможем задать пароль.');
    }
    const { lastInsertRowid } = q.insertUser.run(email, hashPassword(pass), name, phone);
    const user = q.userById.get(Number(lastInsertRowid));
    auth.startSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/auth/login', perMinute(byIp), (req, res) => {
    const b = req.body || {};
    const email = v.str(b.email, { max: 200, field: 'Email' }).toLowerCase();
    const pass = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
    const user = email ? q.userByEmail.get(email) : null;
    const ok = verifyPassword(pass, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new v.HttpError(401, 'Неверный email или пароль');
    if (user.blocked) throw new v.HttpError(403, 'Аккаунт заблокирован. Свяжитесь с нами.');
    auth.startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/auth/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  /* ---------- Профиль ---------- */

  router.get('/me', auth.requireUser, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  router.patch('/me', auth.requireUser, (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { max: 100, required: true, field: 'Имя' });
    const phone = v.phone(b.phone, { required: true });
    q.updateProfile.run(name, phone, req.user.id);
    res.json({ user: publicUser(q.userById.get(req.user.id)) });
  });

  router.post('/me/password', auth.requireUser, perMinute((req) => 'pw:' + req.user.id), (req, res) => {
    const b = req.body || {};
    const user = q.userById.get(req.user.id);
    if (!verifyPassword(String(b.current || '').slice(0, 128), user.password_hash)) {
      throw new v.HttpError(400, 'Текущий пароль указан неверно');
    }
    q.updatePassword.run(hashPassword(v.password(b.next)), user.id);
    auth.endOtherSessions(req, user.id);
    res.json({ ok: true });
  });

  /* ---------- Заказы клиента ---------- */

  router.get('/orders', auth.requireUser, (req, res) => {
    const tariffs = store.labelTariffs();
    res.json({ orders: q.ordersByUser.all(req.user.id).map((o) => serializeOrder(o, tariffs)) });
  });

  router.post('/orders', auth.requireUser, perMinute((req) => 'order:' + req.user.id), (req, res) => {
    const b = req.body || {};
    // Откуда не указано — старые клиенты API: считаем, что из города тарифов.
    const origin = v.str(b.origin, { max: 100, field: 'Откуда' }) || T.ORIGIN;
    const city = v.str(b.city, { max: 100, required: true, field: 'Куда' });
    const carType = v.str(b.carType, { max: 40, required: true, field: 'Тип авто' });
    const options = Array.isArray(b.options) ? b.options.filter((o) => typeof o === 'string') : [];
    const quote = store.routeQuote(origin, city, carType, options);
    if (!quote) throw new v.HttpError(400, 'Неизвестный тип автомобиля');

    const carModel = v.str(b.carModel, { max: 120, required: true, field: 'Марка и модель' });
    const vin = v.vin(b.vin);
    const pickupAddress = v.str(b.pickupAddress, { max: 300, field: 'Адрес забора' });
    const comment = v.str(b.comment, { max: 1000, field: 'Комментарий' });

    const order = tx(db, () => {
      const { lastInsertRowid } = oq.insert.run(
        req.user.id, origin, city, carType, carModel, vin, JSON.stringify(quote.options),
        pickupAddress, comment, quote.price, quote.km, quote.days[0], quote.days[1]
      );
      const id = Number(lastInsertRowid);
      oq.insertEvent.run(id, 'new', quote.priced ? 'Заявка создана в личном кабинете' : 'Заявка создана в личном кабинете. Стоимость рассчитает менеджер');
      return oq.byId.get(id);
    });
    res.status(201).json({ order: clientOrder(order) });
  });

  router.get('/orders/:id', auth.requireUser, (req, res) => {
    res.json({ order: clientOrder(ownOrder(req)) });
  });

  router.post('/orders/:id/cancel', auth.requireUser, (req, res) => {
    const order = ownOrder(req);
    if (order.status !== 'new') throw new v.HttpError(409, 'Отменить можно только новую заявку. Свяжитесь с менеджером.');
    tx(db, () => {
      oq.setStatus.run('cancelled', order.id);
      oq.insertEvent.run(order.id, 'cancelled', 'Отменён клиентом');
    });
    res.json({ order: clientOrder(oq.byId.get(order.id)) });
  });

  /* ---------- Заявки с сайта ---------- */

  router.post('/leads', perMinute(byIp), (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { max: 100, required: true, field: 'Имя' });
    const phone = v.phone(b.phone, { required: true });
    const company = v.str(b.company, { max: 200, field: 'Компания' });
    const email = v.email(b.email, { required: false });
    const message = v.str(b.message, { max: 2000, field: 'Задача' });
    const route = v.str(b.route, { max: 300, field: 'Направление' });
    const estimate = v.str(b.estimate, { max: 50, field: 'Оценка' });
    q.insertLead.run(name, phone, company, email, message, route, estimate, req.user ? req.user.id : null);
    res.status(201).json({ ok: true });
  });

  return router;
}

module.exports = { createApi, publicUser };
