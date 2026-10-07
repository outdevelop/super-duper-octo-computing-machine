'use strict';

// API админ-панели. Менеджер: дашборд, заказы, заявки, клиенты.
// Администратор дополнительно: сотрудники, тарифы, настройки, журнал, удаление.

const express = require('express');
const T = require('../public/tariffs.js');
const v = require('./validate');
const { hashPassword } = require('./auth');
const { tx } = require('./db');
const { ORDER_WITH_CLIENT, orderNumber, parseOrderNumber, serializeOrder, createOrderQueries, withEvents } = require('./orders');

const PAGE_SIZE = 25;
const STAFF_ROLES = { manager: 1, admin: 1 };

function page(req) {
  const n = Number(req.query.page);
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : 1;
}

function query(req, name, max = 100) {
  return typeof req.query[name] === 'string' ? req.query[name].trim().slice(0, max) : '';
}

function userRow(u) {
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role,
    blocked: !!u.blocked, note: u.note, hasPassword: !!u.password_hash, createdAt: u.created_at
  };
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  // Защита от формул в Excel и экранирование разделителя.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[";\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function createAdminApi(db, auth, store) {
  const router = express.Router();
  const oq = createOrderQueries(db);
  const staff = auth.requireStaff;
  const admin = auth.requireAdmin;

  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?)'),
    activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND blocked = 0"),
    ordersOfUser: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC'),
    lead: db.prepare('SELECT * FROM leads WHERE id = ?'),
    setLead: db.prepare('UPDATE leads SET status = ?, note = ? WHERE id = ?'),
    deleteLead: db.prepare('DELETE FROM leads WHERE id = ?'),
    deleteOrder: db.prepare('DELETE FROM orders WHERE id = ?')
  };

  function audit(req, action, entity, entityId, details) {
    store.audit(req.user, action, entity, entityId, details);
  }

  function loadOrder(req) {
    const order = oq.byId.get(v.id(req.params.id));
    if (!order) throw new v.HttpError(404, 'Заказ не найден');
    return order;
  }

  function orderOut(order) {
    return withEvents(oq, order, serializeOrder(order, store.labelTariffs(), { staff: true }));
  }

  function loadClient(req) {
    const user = q.userById.get(v.id(req.params.id));
    if (!user || user.role !== 'client') throw new v.HttpError(404, 'Клиент не найден');
    return user;
  }

  /* ---------- Дашборд ---------- */

  const dash = {
    kpi: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE created_at >= date('now', 'start of month')) AS ordersMonth,
        (SELECT COUNT(*) FROM orders WHERE created_at >= date('now', 'start of month', '-1 month')
                                      AND created_at <  date('now', 'start of month')) AS ordersPrevMonth,
        (SELECT COALESCE(SUM(price), 0) FROM orders WHERE status != 'cancelled'
                                      AND created_at >= date('now', 'start of month')) AS revenueMonth,
        (SELECT COALESCE(SUM(price), 0) FROM orders WHERE status != 'cancelled'
                                      AND created_at >= date('now', 'start of month', '-1 month')
                                      AND created_at <  date('now', 'start of month')) AS revenuePrevMonth,
        (SELECT COUNT(*) FROM orders WHERE status IN ('confirmed', 'pickup', 'in_transit', 'arrived')) AS active,
        (SELECT COUNT(*) FROM orders WHERE status = 'in_transit') AS inTransit,
        (SELECT COUNT(*) FROM orders WHERE status = 'new') AS newOrders,
        (SELECT COUNT(*) FROM leads WHERE status = 'new') AS newLeads,
        (SELECT COUNT(*) FROM users WHERE role = 'client') AS clients,
        (SELECT COUNT(*) FROM users WHERE role = 'client' AND created_at >= date('now', 'start of month')) AS clientsMonth,
        (SELECT COALESCE(SUM(MAX(price - paid_amount, 0)), 0) FROM orders
           WHERE status != 'cancelled' AND payment_status != 'paid') AS unpaid`),
    daily: db.prepare(`
      SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status != 'cancelled' THEN price END), 0) AS revenue
      FROM orders WHERE created_at >= date('now', '-29 days') GROUP BY day`),
    statuses: db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
    cities: db.prepare(`
      SELECT origin, city, COUNT(*) AS n, COALESCE(SUM(price), 0) AS revenue FROM orders
      WHERE status != 'cancelled' GROUP BY origin, city ORDER BY n DESC, revenue DESC LIMIT 6`),
    recentOrders: db.prepare(ORDER_WITH_CLIENT + ' ORDER BY o.id DESC LIMIT 6'),
    recentLeads: db.prepare("SELECT * FROM leads WHERE status IN ('new', 'in_work') ORDER BY id DESC LIMIT 5")
  };

  router.get('/dashboard', staff, (req, res) => {
    const byDay = new Map(dash.daily.all().map((r) => [r.day, r]));
    const days = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      days.push({ day: key, orders: row ? row.orders : 0, revenue: row ? row.revenue : 0 });
    }
    const tariffs = store.labelTariffs();
    res.json({
      kpi: { ...dash.kpi.get() },
      daily: days,
      statuses: Object.fromEntries(dash.statuses.all().map((r) => [r.status, r.n])),
      cities: dash.cities.all().map((r) => ({ city: r.origin + ' → ' + r.city, orders: r.n, revenue: r.revenue })),
      recentOrders: dash.recentOrders.all().map((o) => serializeOrder(o, tariffs, { staff: true })),
      recentLeads: dash.recentLeads.all().map(leadOut)
    });
  });

  /* ---------- Заказы ---------- */

  function orderFilters(req) {
    const where = [];
    const params = [];
    const search = query(req, 'q');
    if (search) {
      const num = parseOrderNumber(search);
      const like = '%' + search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const parts = [
        "ulower(o.city) LIKE ? ESCAPE '\\'", "ulower(o.origin) LIKE ? ESCAPE '\\'", "ulower(o.car_model) LIKE ? ESCAPE '\\'",
        "ulower(o.vin) LIKE ? ESCAPE '\\'", "ulower(u.name) LIKE ? ESCAPE '\\'", "ulower(u.email) LIKE ? ESCAPE '\\'"
      ];
      params.push(like, like, like, like, like, like);
      const digits = search.replace(/\D/g, '');
      if (digits.length >= 4) { parts.push('digits(u.phone) LIKE ?'); params.push('%' + digits + '%'); }
      if (num) { parts.push('o.id = ?'); params.push(num); }
      where.push('(' + parts.join(' OR ') + ')');
    }
    const status = query(req, 'status', 20);
    if (status && T.STATUSES[status]) { where.push('o.status = ?'); params.push(status); }
    if (query(req, 'status', 20) === 'active') where.push("o.status IN ('confirmed', 'pickup', 'in_transit', 'arrived')");
    const payment = query(req, 'payment', 20);
    if (payment && T.PAYMENT_STATUSES[payment]) { where.push('o.payment_status = ?'); params.push(payment); }
    const from = v.date(query(req, 'from', 10), { field: 'Дата с' });
    if (from) { where.push('o.created_at >= ?'); params.push(from); }
    const to = v.date(query(req, 'to', 10), { field: 'Дата по' });
    if (to) { where.push("o.created_at < date(?, '+1 day')"); params.push(to); }
    const sorts = { new: 'o.id DESC', old: 'o.id ASC', price_desc: 'o.price DESC, o.id DESC', price_asc: 'o.price ASC, o.id DESC' };
    const order = sorts[query(req, 'sort', 20)] || sorts.new;
    return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params, order };
  }

  router.get('/orders', staff, (req, res) => {
    const f = orderFilters(req);
    const p = page(req);
    const total = db.prepare('SELECT COUNT(*) AS n FROM orders o JOIN users u ON u.id = o.user_id' + f.sql).get(...f.params).n;
    const sum = db.prepare("SELECT COALESCE(SUM(o.price), 0) AS s FROM orders o JOIN users u ON u.id = o.user_id" + f.sql).get(...f.params).s;
    const rows = db.prepare(ORDER_WITH_CLIENT + f.sql + ` ORDER BY ${f.order} LIMIT ? OFFSET ?`)
      .all(...f.params, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    const tariffs = store.labelTariffs();
    res.json({ orders: rows.map((o) => serializeOrder(o, tariffs, { staff: true })), total, sum, page: p, pageSize: PAGE_SIZE });
  });

  router.get('/orders.csv', staff, (req, res) => {
    const f = orderFilters(req);
    const rows = db.prepare(ORDER_WITH_CLIENT + f.sql + ` ORDER BY ${f.order} LIMIT 10000`).all(...f.params);
    const tariffs = store.labelTariffs();
    const head = ['Номер', 'Создан', 'Статус', 'Оплата', 'Оплачено', 'Клиент', 'Телефон', 'Email', 'Откуда', 'Куда', 'Авто', 'Тип', 'VIN',
      'Опции', 'Цена', 'Км', 'Срок', 'ETA', 'Водитель', 'Автовоз', 'Комментарий клиента', 'Заметка менеджера'];
    const lines = rows.map((o) => [
      orderNumber(o.id), o.created_at, T.STATUSES[o.status] || o.status, T.PAYMENT_STATUSES[o.payment_status] || o.payment_status,
      o.paid_amount, o.client_name, o.client_phone, o.client_email, o.origin, o.city, o.car_model, T.carTypeLabel(tariffs, o.car_type), o.vin,
      T.optionLabels(tariffs, JSON.parse(o.options)).join(', '), o.price, o.km, `${o.days_min}–${o.days_max}`, o.eta,
      o.driver, o.truck, o.comment, o.manager_note
    ].map(csvCell).join(';'));
    audit(req, 'Выгрузил заказы в CSV', 'order', '', `${rows.length} шт.`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + [head.join(';'), ...lines].join('\r\n'));
  });

  router.get('/orders/:id', staff, (req, res) => {
    res.json({ order: orderOut(loadOrder(req)) });
  });

  // Поля, которые менеджер может менять в заказе.
  function orderFields(b, current) {
    const tariffs = store.labelTariffs();
    const out = {};
    if (b.origin !== undefined) out.origin = v.str(b.origin, { max: 100, required: true, field: 'Откуда' });
    if (b.city !== undefined) out.city = v.str(b.city, { max: 100, required: true, field: 'Куда' });
    // Маршрут изменился — расстояние и срок берём из тарифа, а если его нет, обнуляем.
    if (current && ((out.origin && out.origin !== current.origin) || (out.city && out.city !== current.city))) {
      const c = T.routeCity(tariffs, out.origin || current.origin, out.city || current.city);
      out.km = c ? c.km : 0;
      out.days_min = c ? c.days[0] : 0;
      out.days_max = c ? c.days[1] : 0;
    }
    if (b.carType !== undefined) {
      const key = v.str(b.carType, { max: 40, required: true, field: 'Тип авто' });
      if (!T.findCarType(tariffs, key)) throw new v.HttpError(400, 'Неизвестный тип автомобиля');
      out.car_type = key;
    }
    if (b.options !== undefined) {
      if (!Array.isArray(b.options)) throw new v.HttpError(400, 'Опции: ожидается список');
      out.options = JSON.stringify([...new Set(b.options.filter((k) => typeof k === 'string' && T.findOption(tariffs, k)))]);
    }
    if (b.carModel !== undefined) out.car_model = v.str(b.carModel, { max: 120, required: true, field: 'Марка и модель' });
    if (b.vin !== undefined) out.vin = v.vin(b.vin);
    if (b.pickupAddress !== undefined) out.pickup_address = v.str(b.pickupAddress, { max: 300, field: 'Адрес забора' });
    if (b.comment !== undefined) out.comment = v.str(b.comment, { max: 1000, field: 'Комментарий клиента' });
    if (b.managerNote !== undefined) out.manager_note = v.str(b.managerNote, { max: 2000, field: 'Заметка менеджера' });
    if (b.driver !== undefined) out.driver = v.str(b.driver, { max: 200, field: 'Водитель' });
    if (b.truck !== undefined) out.truck = v.str(b.truck, { max: 100, field: 'Автовоз' });
    if (b.eta !== undefined) out.eta = v.date(b.eta, { field: 'Дата прибытия' });
    if (b.price !== undefined) out.price = v.int(b.price, { min: 0, max: 100000000, field: 'Цена' });
    if (b.paymentStatus !== undefined) out.payment_status = v.oneOf(b.paymentStatus, T.PAYMENT_STATUSES, { field: 'Оплата' });
    if (b.paidAmount !== undefined) out.paid_amount = v.int(b.paidAmount, { min: 0, max: 100000000, field: 'Оплачено' });
    return out;
  }

  router.post('/orders', staff, (req, res) => {
    const b = req.body || {};
    let clientId = null;
    let newClient = null;
    if (b.clientId !== undefined && b.clientId !== null && b.clientId !== '') {
      const user = q.userById.get(v.id(b.clientId));
      if (!user || user.role !== 'client') throw new v.HttpError(400, 'Клиент не найден');
      clientId = user.id;
    } else {
      const c = b.client || {};
      const name = v.str(c.name, { max: 100, required: true, field: 'Имя клиента' });
      const phone = v.phone(c.phone, { required: true });
      const email = v.email(c.email, { required: false });
      if (email && q.userByEmail.get(email)) throw new v.HttpError(409, 'Клиент с таким email уже есть — выберите его из списка');
      newClient = { name, phone, email };
    }

    const origin = v.str(b.origin, { max: 100, field: 'Откуда' }) || T.ORIGIN;
    const city = v.str(b.city, { max: 100, required: true, field: 'Куда' });
    const carType = v.str(b.carType, { max: 40, required: true, field: 'Тип авто' });
    const options = Array.isArray(b.options) ? b.options.filter((o) => typeof o === 'string') : [];
    const quote = store.routeQuote(origin, city, carType, options);
    if (!quote) throw new v.HttpError(400, 'Неизвестный тип автомобиля');
    const fields = orderFields({
      carModel: b.carModel === undefined ? '' : b.carModel, vin: b.vin || '', pickupAddress: b.pickupAddress || '', comment: b.comment || '',
      managerNote: b.managerNote || '', eta: b.eta || ''
    });
    const price = b.price !== undefined && b.price !== '' && b.price !== null
      ? v.int(b.price, { min: 0, max: 100000000, field: 'Цена' }) : quote.price;
    const leadId = b.leadId ? v.id(b.leadId) : null;

    const order = tx(db, () => {
      if (newClient) {
        clientId = Number(q.insertUser.run(newClient.email || null, '', newClient.name, newClient.phone, 'client').lastInsertRowid);
        audit(req, 'Создал клиента', 'client', clientId, newClient.name);
      }
      const id = Number(oq.insert.run(
        clientId, origin, city, carType, fields.car_model, fields.vin, JSON.stringify(quote.options),
        fields.pickup_address, fields.comment, price, quote.km, quote.days[0], quote.days[1]
      ).lastInsertRowid);
      db.prepare('UPDATE orders SET manager_note = ?, eta = ? WHERE id = ?').run(fields.manager_note, fields.eta, id);
      oq.insertEvent.run(id, 'new', 'Заказ оформлен менеджером');
      if (leadId && q.lead.get(leadId)) db.prepare("UPDATE leads SET status = 'done' WHERE id = ?").run(leadId);
      audit(req, 'Создал заказ', 'order', id, orderNumber(id));
      return oq.byId.get(id);
    });
    res.status(201).json({ order: orderOut(order) });
  });

  router.patch('/orders/:id', staff, (req, res) => {
    const order = loadOrder(req);
    const fields = orderFields(req.body || {}, order);
    const keys = Object.keys(fields);
    if (!keys.length) return res.json({ order: orderOut(order) });
    db.prepare(`UPDATE orders SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), order.id);
    const changes = [];
    if (fields.price !== undefined && fields.price !== order.price) changes.push(`цена ${order.price} → ${fields.price}`);
    if (fields.payment_status && fields.payment_status !== order.payment_status) changes.push(`оплата: ${T.PAYMENT_STATUSES[fields.payment_status]}`);
    if ((fields.origin && fields.origin !== order.origin) || (fields.city && fields.city !== order.city)) {
      changes.push(`маршрут: ${fields.origin || order.origin} → ${fields.city || order.city}`);
    }
    audit(req, 'Изменил заказ', 'order', order.id, changes.join('; ') || orderNumber(order.id));
    res.json({ order: orderOut(oq.byId.get(order.id)) });
  });

  router.post('/orders/:id/status', staff, (req, res) => {
    const order = loadOrder(req);
    const b = req.body || {};
    const status = v.oneOf(b.status, T.STATUSES, { field: 'Статус' });
    const note = v.str(b.note, { max: 500, field: 'Комментарий' });
    tx(db, () => {
      oq.setStatus.run(status, order.id);
      oq.insertEvent.run(order.id, status, note);
      audit(req, 'Сменил статус', 'order', order.id, `${orderNumber(order.id)}: ${T.STATUSES[status]}`);
    });
    res.json({ order: orderOut(oq.byId.get(order.id)) });
  });

  router.delete('/orders/:id', admin, (req, res) => {
    const order = loadOrder(req);
    tx(db, () => {
      q.deleteOrder.run(order.id);
      audit(req, 'Удалил заказ', 'order', order.id, `${orderNumber(order.id)}, ${order.client_name}, ${order.city}, ${order.price} ₽`);
    });
    res.json({ ok: true });
  });

  /* ---------- Заявки с сайта ---------- */

  function leadOut(l) {
    return {
      id: l.id, name: l.name, phone: l.phone, company: l.company, email: l.email, message: l.message,
      route: l.route, estimate: l.estimate, status: l.status, note: l.note, userId: l.user_id, createdAt: l.created_at
    };
  }

  router.get('/leads', staff, (req, res) => {
    const where = [];
    const params = [];
    const search = query(req, 'q');
    if (search) {
      const like = '%' + search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const parts = ['name', 'company', 'email', 'message', 'route', 'note'].map((c) => `ulower(${c}) LIKE ? ESCAPE '\\'`);
      params.push(like, like, like, like, like, like);
      const digits = search.replace(/\D/g, '');
      if (digits.length >= 4) { parts.push('digits(phone) LIKE ?'); params.push('%' + digits + '%'); }
      where.push('(' + parts.join(' OR ') + ')');
    }
    const status = query(req, 'status', 20);
    if (status && T.LEAD_STATUSES[status]) { where.push('status = ?'); params.push(status); }
    const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const p = page(req);
    const total = db.prepare('SELECT COUNT(*) AS n FROM leads' + sql).get(...params).n;
    const rows = db.prepare('SELECT * FROM leads' + sql + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    res.json({ leads: rows.map(leadOut), total, page: p, pageSize: PAGE_SIZE });
  });

  router.patch('/leads/:id', staff, (req, res) => {
    const lead = q.lead.get(v.id(req.params.id));
    if (!lead) throw new v.HttpError(404, 'Заявка не найдена');
    const b = req.body || {};
    const status = b.status !== undefined ? v.oneOf(b.status, T.LEAD_STATUSES, { field: 'Статус' }) : lead.status;
    const note = b.note !== undefined ? v.str(b.note, { max: 1000, field: 'Комментарий' }) : lead.note;
    q.setLead.run(status, note, lead.id);
    if (status !== lead.status) audit(req, 'Сменил статус заявки', 'lead', lead.id, `${lead.name}: ${T.LEAD_STATUSES[status]}`);
    res.json({ lead: leadOut(q.lead.get(lead.id)) });
  });

  router.delete('/leads/:id', admin, (req, res) => {
    const lead = q.lead.get(v.id(req.params.id));
    if (!lead) throw new v.HttpError(404, 'Заявка не найдена');
    q.deleteLead.run(lead.id);
    audit(req, 'Удалил заявку', 'lead', lead.id, `${lead.name}, ${lead.phone}`);
    res.json({ ok: true });
  });

  /* ---------- Клиенты ---------- */

  router.get('/clients', staff, (req, res) => {
    const where = ["u.role = 'client'"];
    const params = [];
    const search = query(req, 'q');
    if (search) {
      const like = '%' + search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const parts = ["ulower(u.name) LIKE ? ESCAPE '\\'", "ulower(u.email) LIKE ? ESCAPE '\\'"];
      params.push(like, like);
      const digits = search.replace(/\D/g, '');
      if (digits.length >= 4) { parts.push('digits(u.phone) LIKE ?'); params.push('%' + digits + '%'); }
      where.push('(' + parts.join(' OR ') + ')');
    }
    if (query(req, 'blocked', 5) === '1') where.push('u.blocked = 1');
    const sql = ' WHERE ' + where.join(' AND ');
    const p = page(req);
    const total = db.prepare('SELECT COUNT(*) AS n FROM users u' + sql).get(...params).n;
    const rows = db.prepare(`
      SELECT u.*, COUNT(o.id) AS orders_count, COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.price END), 0) AS orders_sum,
             MAX(o.created_at) AS last_order
      FROM users u LEFT JOIN orders o ON o.user_id = u.id${sql}
      GROUP BY u.id ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (p - 1) * PAGE_SIZE);
    res.json({
      clients: rows.map((u) => ({ ...userRow(u), ordersCount: u.orders_count, ordersSum: u.orders_sum, lastOrder: u.last_order })),
      total, page: p, pageSize: PAGE_SIZE
    });
  });

  router.post('/clients', staff, (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { max: 100, required: true, field: 'Имя' });
    const phone = v.phone(b.phone, { required: true });
    const email = v.email(b.email, { required: false });
    if (email && q.userByEmail.get(email)) throw new v.HttpError(409, 'Пользователь с таким email уже есть');
    const id = Number(q.insertUser.run(email || null, '', name, phone, 'client').lastInsertRowid);
    audit(req, 'Создал клиента', 'client', id, name);
    res.status(201).json({ client: userRow(q.userById.get(id)) });
  });

  router.get('/clients/:id', staff, (req, res) => {
    const user = loadClient(req);
    const tariffs = store.labelTariffs();
    res.json({ client: userRow(user), orders: q.ordersOfUser.all(user.id).map((o) => serializeOrder(o, tariffs, { staff: true })) });
  });

  router.patch('/clients/:id', staff, (req, res) => {
    const user = loadClient(req);
    const b = req.body || {};
    const name = b.name !== undefined ? v.str(b.name, { max: 100, required: true, field: 'Имя' }) : user.name;
    const phone = b.phone !== undefined ? v.phone(b.phone, { required: true }) : user.phone;
    let email = user.email;
    if (b.email !== undefined) {
      email = v.email(b.email, { required: false }) || null;
      const other = email ? q.userByEmail.get(email) : null;
      if (other && other.id !== user.id) throw new v.HttpError(409, 'Этот email уже занят');
      if (!email && user.password_hash) throw new v.HttpError(400, 'У клиента есть пароль — email нужен для входа');
    }
    const note = b.note !== undefined ? v.str(b.note, { max: 2000, field: 'Заметка' }) : user.note;
    const blocked = b.blocked !== undefined ? (b.blocked ? 1 : 0) : user.blocked;
    db.prepare('UPDATE users SET name = ?, phone = ?, email = ?, note = ?, blocked = ? WHERE id = ?')
      .run(name, phone, email, note, blocked, user.id);
    if (blocked && !user.blocked) { auth.endAllSessions(user.id); audit(req, 'Заблокировал клиента', 'client', user.id, name); }
    else if (!blocked && user.blocked) audit(req, 'Разблокировал клиента', 'client', user.id, name);
    else audit(req, 'Изменил клиента', 'client', user.id, name);
    res.json({ client: userRow(q.userById.get(user.id)) });
  });

  router.post('/clients/:id/password', staff, (req, res) => {
    const user = loadClient(req);
    if (!user.email) throw new v.HttpError(400, 'Сначала укажите клиенту email — он нужен для входа');
    const pass = v.password((req.body || {}).password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pass), user.id);
    auth.endAllSessions(user.id);
    audit(req, 'Задал пароль клиенту', 'client', user.id, user.name);
    res.json({ ok: true });
  });

  /* ---------- Сотрудники ---------- */

  router.get('/staff', admin, (req, res) => {
    const rows = db.prepare("SELECT * FROM users WHERE role IN ('manager', 'admin') ORDER BY role DESC, name").all();
    res.json({ staff: rows.map(userRow) });
  });

  router.post('/staff', admin, (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { max: 100, required: true, field: 'Имя' });
    const email = v.email(b.email);
    const phone = v.phone(b.phone);
    const role = v.oneOf(b.role, STAFF_ROLES, { field: 'Роль' });
    const pass = v.password(b.password);
    if (q.userByEmail.get(email)) throw new v.HttpError(409, 'Пользователь с таким email уже есть');
    const id = Number(q.insertUser.run(email, hashPassword(pass), name, phone, role).lastInsertRowid);
    audit(req, 'Добавил сотрудника', 'staff', id, `${name} (${T.ROLES[role]})`);
    res.status(201).json({ user: userRow(q.userById.get(id)) });
  });

  router.patch('/staff/:id', admin, (req, res) => {
    const user = q.userById.get(v.id(req.params.id));
    if (!user || !STAFF_ROLES[user.role]) throw new v.HttpError(404, 'Сотрудник не найден');
    const b = req.body || {};
    const self = user.id === req.user.id;
    const name = b.name !== undefined ? v.str(b.name, { max: 100, required: true, field: 'Имя' }) : user.name;
    const phone = b.phone !== undefined ? v.phone(b.phone) : user.phone;
    const role = b.role !== undefined ? v.oneOf(b.role, STAFF_ROLES, { field: 'Роль' }) : user.role;
    const blocked = b.blocked !== undefined ? (b.blocked ? 1 : 0) : user.blocked;
    if (self && (role !== user.role || blocked)) throw new v.HttpError(400, 'Нельзя менять роль или блокировать самого себя');
    const losesAdmin = user.role === 'admin' && !user.blocked && (role !== 'admin' || blocked);
    if (losesAdmin && q.activeAdmins.get().n <= 1) throw new v.HttpError(400, 'Должен остаться хотя бы один администратор');

    tx(db, () => {
      db.prepare('UPDATE users SET name = ?, phone = ?, role = ?, blocked = ? WHERE id = ?').run(name, phone, role, blocked, user.id);
      if (b.password) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(v.password(b.password)), user.id);
      }
    });
    if (blocked || b.password || role !== user.role) {
      if (self) auth.endOtherSessions(req, user.id); else auth.endAllSessions(user.id);
    }
    const what = [];
    if (role !== user.role) what.push('роль: ' + T.ROLES[role]);
    if (blocked !== user.blocked) what.push(blocked ? 'заблокирован' : 'разблокирован');
    if (b.password) what.push('новый пароль');
    audit(req, 'Изменил сотрудника', 'staff', user.id, `${name}${what.length ? ': ' + what.join(', ') : ''}`);
    res.json({ user: userRow(q.userById.get(user.id)) });
  });

  /* ---------- Тарифы и настройки ---------- */

  router.get('/tariffs', staff, (req, res) => {
    res.json(store.allTariffs());
  });

  router.put('/tariffs', admin, (req, res) => {
    const saved = store.saveTariffs(req.body);
    audit(req, 'Обновил тарифы', 'tariffs', '', `${saved.cities.length} городов`);
    res.json(saved);
  });

  router.put('/settings', admin, (req, res) => {
    const saved = store.saveSettings(req.body);
    audit(req, 'Обновил настройки сайта', 'settings');
    res.json({ settings: saved });
  });

  /* ---------- Журнал ---------- */

  router.get('/audit', admin, (req, res) => {
    const p = page(req);
    const total = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const rows = db.prepare(`
      SELECT a.*, u.name AS user_name, u.role AS user_role FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(PAGE_SIZE, (p - 1) * PAGE_SIZE);
    res.json({
      entries: rows.map((r) => ({
        id: r.id, user: r.user_name || '—', role: r.user_role, action: r.action, entity: r.entity,
        entityId: r.entity_id, details: r.details, createdAt: r.created_at
      })),
      total, page: p, pageSize: PAGE_SIZE
    });
  });

  router.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

  return router;
}

module.exports = { createAdminApi };
