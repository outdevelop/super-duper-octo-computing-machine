'use strict';

const express = require('express');
const T = require('../public/tariffs.js');
const { hashPassword, verifyPassword, DUMMY_HASH, createRateLimiter } = require('./auth');
const { tx } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function str(value, { max = 200, required = false, field = 'Поле' } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new HttpError(400, `${field}: обязательное поле`);
  if (s.length > max) throw new HttpError(400, `${field}: не длиннее ${max} символов`);
  return s;
}

function normalizePhone(value, { required = false } = {}) {
  const raw = str(value, { max: 32, required, field: 'Телефон' });
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits.length !== 11 || digits[0] !== '7') throw new HttpError(400, 'Телефон: формат +7 (XXX) XXX-XX-XX');
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'Пароль: минимум 8 символов');
  if (value.length > 128) throw new HttpError(400, 'Пароль: не длиннее 128 символов');
  return value;
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, createdAt: u.created_at };
}

function orderNumber(id) {
  return 'КЭ-' + String(id).padStart(5, '0');
}

function publicOrder(o) {
  return {
    id: o.id,
    number: orderNumber(o.id),
    origin: T.ORIGIN,
    city: o.city,
    carType: o.car_type,
    carModel: o.car_model,
    vin: o.vin,
    options: JSON.parse(o.options),
    pickupAddress: o.pickup_address,
    comment: o.comment,
    price: o.price,
    km: o.km,
    days: [o.days_min, o.days_max],
    status: o.status,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    ...(o.client_name !== undefined && {
      client: { name: o.client_name, email: o.client_email, phone: o.client_phone }
    })
  };
}

function createApi(db, auth) {
  const router = express.Router();
  const perMinute = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
  const byIp = (req) => req.ip;

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, name, phone) VALUES (?, ?, ?, ?)'),
    updateProfile: db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),

    insertOrder: db.prepare(`
      INSERT INTO orders (user_id, city, car_type, car_model, vin, options, pickup_address, comment, price, km, days_min, days_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    ordersByUser: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC'),
    allOrders: db.prepare(`
      SELECT o.*, u.name AS client_name, u.email AS client_email, u.phone AS client_phone
      FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 500`),
    allOrdersByStatus: db.prepare(`
      SELECT o.*, u.name AS client_name, u.email AS client_email, u.phone AS client_phone
      FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.id DESC LIMIT 500`),
    orderWithClient: db.prepare(`
      SELECT o.*, u.name AS client_name, u.email AS client_email, u.phone AS client_phone
      FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`),
    setStatus: db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?"),
    insertEvent: db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)'),
    eventsByOrder: db.prepare('SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id'),

    insertLead: db.prepare('INSERT INTO leads (name, phone, route, estimate, user_id) VALUES (?, ?, ?, ?, ?)'),
    leads: db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 500'),
    markLead: db.prepare('UPDATE leads SET processed = ? WHERE id = ?'),
    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM orders) AS orders,
        (SELECT COUNT(*) FROM orders WHERE status NOT IN ('delivered', 'cancelled')) AS active,
        (SELECT COUNT(*) FROM users WHERE role = 'client') AS clients,
        (SELECT COUNT(*) FROM leads WHERE processed = 0) AS newLeads`)
  };

  function loadOrderFor(req) {
    const id = Number(req.params.id);
    const order = Number.isInteger(id) ? q.orderWithClient.get(id) : null;
    // Чужой заказ отдаём как «не найден», чтобы не раскрывать существование id.
    if (!order || (req.user.role !== 'manager' && order.user_id !== req.user.id)) {
      throw new HttpError(404, 'Заказ не найден');
    }
    return order;
  }

  function orderDetails(order, role) {
    const data = publicOrder(order);
    if (role !== 'manager') delete data.client;
    data.events = q.eventsByOrder.all(order.id).map((e) => ({ status: e.status, note: e.note, createdAt: e.created_at }));
    return data;
  }

  /* ---------- Auth ---------- */

  router.post('/auth/register', perMinute(byIp), (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 100, required: true, field: 'Имя' });
    const email = str(b.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email: некорректный адрес');
    const phone = normalizePhone(b.phone, { required: true });
    const pass = password(b.password);

    if (q.userByEmail.get(email)) throw new HttpError(409, 'Пользователь с таким email уже зарегистрирован');
    const { lastInsertRowid } = q.insertUser.run(email, hashPassword(pass), name, phone);
    const user = q.userById.get(Number(lastInsertRowid));
    auth.startSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/auth/login', perMinute(byIp), (req, res) => {
    const b = req.body || {};
    const email = str(b.email, { max: 200, field: 'Email' }).toLowerCase();
    const pass = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
    const user = email ? q.userByEmail.get(email) : null;
    const ok = verifyPassword(pass, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Неверный email или пароль');
    auth.startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/auth/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  /* ---------- Profile ---------- */

  router.get('/me', auth.requireUser, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  router.patch('/me', auth.requireUser, (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 100, required: true, field: 'Имя' });
    const phone = normalizePhone(b.phone, { required: true });
    q.updateProfile.run(name, phone, req.user.id);
    res.json({ user: publicUser(q.userById.get(req.user.id)) });
  });

  router.post('/me/password', auth.requireUser, perMinute((req) => 'pw:' + req.user.id), (req, res) => {
    const b = req.body || {};
    const user = q.userById.get(req.user.id);
    if (!verifyPassword(String(b.current || '').slice(0, 128), user.password_hash)) {
      throw new HttpError(400, 'Текущий пароль указан неверно');
    }
    q.updatePassword.run(hashPassword(password(b.next)), user.id);
    auth.endOtherSessions(req, user.id);
    res.json({ ok: true });
  });

  /* ---------- Orders ---------- */

  router.get('/orders', auth.requireUser, (req, res) => {
    let rows;
    if (req.user.role === 'manager') {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      rows = status && T.STATUSES[status] ? q.allOrdersByStatus.all(status) : q.allOrders.all();
    } else {
      rows = q.ordersByUser.all(req.user.id);
    }
    res.json({ orders: rows.map(publicOrder) });
  });

  router.post('/orders', auth.requireUser, perMinute((req) => 'order:' + req.user.id), (req, res) => {
    const b = req.body || {};
    const city = str(b.city, { max: 100, required: true, field: 'Город' });
    const carType = str(b.carType, { max: 20, required: true, field: 'Тип авто' });
    const options = Array.isArray(b.options) ? b.options.filter((o) => typeof o === 'string') : [];
    const quote = T.quote(city, carType, options);
    if (!quote) throw new HttpError(400, 'Неизвестный город или тип автомобиля');

    const carModel = str(b.carModel, { max: 120, required: true, field: 'Марка и модель' });
    const vin = str(b.vin, { max: 17, field: 'VIN' }).toUpperCase();
    if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new HttpError(400, 'VIN: 17 символов, латиница и цифры');
    const pickupAddress = str(b.pickupAddress, { max: 300, field: 'Адрес забора' });
    const comment = str(b.comment, { max: 1000, field: 'Комментарий' });

    const order = tx(db, () => {
      const { lastInsertRowid } = q.insertOrder.run(
        req.user.id, city, carType, carModel, vin, JSON.stringify(quote.options),
        pickupAddress, comment, quote.price, quote.km, quote.days[0], quote.days[1]
      );
      const id = Number(lastInsertRowid);
      q.insertEvent.run(id, 'new', 'Заявка создана в личном кабинете');
      return q.orderWithClient.get(id);
    });
    res.status(201).json({ order: orderDetails(order, req.user.role) });
  });

  router.get('/orders/:id', auth.requireUser, (req, res) => {
    res.json({ order: orderDetails(loadOrderFor(req), req.user.role) });
  });

  router.post('/orders/:id/cancel', auth.requireUser, (req, res) => {
    const order = loadOrderFor(req);
    if (order.status !== 'new') throw new HttpError(409, 'Отменить можно только новую заявку. Свяжитесь с менеджером.');
    tx(db, () => {
      q.setStatus.run('cancelled', order.id);
      q.insertEvent.run(order.id, 'cancelled', 'Отменён клиентом');
    });
    res.json({ order: orderDetails(q.orderWithClient.get(order.id), req.user.role) });
  });

  router.patch('/orders/:id/status', auth.requireManager, (req, res) => {
    const order = loadOrderFor(req);
    const b = req.body || {};
    const status = str(b.status, { max: 20, required: true, field: 'Статус' });
    if (!T.STATUSES[status]) throw new HttpError(400, 'Неизвестный статус');
    const note = str(b.note, { max: 500, field: 'Комментарий' });
    tx(db, () => {
      q.setStatus.run(status, order.id);
      q.insertEvent.run(order.id, status, note);
    });
    res.json({ order: orderDetails(q.orderWithClient.get(order.id), req.user.role) });
  });

  /* ---------- Leads (форма на лендинге) ---------- */

  router.post('/leads', perMinute(byIp), (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 100, required: true, field: 'Имя' });
    const phone = normalizePhone(b.phone, { required: true });
    const route = str(b.route, { max: 300, field: 'Направление' });
    const estimate = str(b.estimate, { max: 50, field: 'Оценка' });
    q.insertLead.run(name, phone, route, estimate, req.user ? req.user.id : null);
    res.status(201).json({ ok: true });
  });

  router.get('/leads', auth.requireManager, (req, res) => {
    res.json({
      leads: q.leads.all().map((l) => ({
        id: l.id, name: l.name, phone: l.phone, route: l.route, estimate: l.estimate,
        processed: !!l.processed, createdAt: l.created_at
      }))
    });
  });

  router.patch('/leads/:id', auth.requireManager, (req, res) => {
    const id = Number(req.params.id);
    const { changes } = q.markLead.run(req.body && req.body.processed ? 1 : 0, Number.isInteger(id) ? id : -1);
    if (!changes) throw new HttpError(404, 'Заявка не найдена');
    res.json({ ok: true });
  });

  router.get('/stats', auth.requireManager, (req, res) => {
    res.json({ stats: { ...q.stats.get() } });
  });

  router.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

  return router;
}

module.exports = { createApi, HttpError };
