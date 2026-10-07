'use strict';

// Общие запросы и сериализация заказов для клиентского API и админки.

const T = require('../public/tariffs.js');

const ORDER_WITH_CLIENT = `
  SELECT o.*, u.name AS client_name, u.email AS client_email, u.phone AS client_phone
  FROM orders o JOIN users u ON u.id = o.user_id`;

function orderNumber(id) {
  return 'КЭ-' + String(id).padStart(5, '0');
}

// Номер из строки поиска: «КЭ-00012», «кэ12», «12» → 12.
function parseOrderNumber(query) {
  const m = /^\s*(?:кэ|ke)?\s*-?\s*0*(\d{1,9})\s*$/i.exec(query || '');
  return m ? Number(m[1]) : null;
}

function serializeOrder(o, tariffs, { staff = false } = {}) {
  const options = JSON.parse(o.options);
  const out = {
    id: o.id,
    number: orderNumber(o.id),
    origin: o.origin || T.ORIGIN,
    city: o.city,
    carType: o.car_type,
    carTypeLabel: T.carTypeLabel(tariffs, o.car_type),
    carModel: o.car_model,
    vin: o.vin,
    options,
    optionLabels: T.optionLabels(tariffs, options),
    pickupAddress: o.pickup_address,
    comment: o.comment,
    price: o.price,
    km: o.km,
    days: [o.days_min, o.days_max],
    status: o.status,
    eta: o.eta,
    paymentStatus: o.payment_status,
    paidAmount: o.paid_amount,
    createdAt: o.created_at,
    updatedAt: o.updated_at
  };
  if (staff) {
    out.userId = o.user_id;
    out.managerNote = o.manager_note;
    out.driver = o.driver;
    out.truck = o.truck;
    if (o.client_name !== undefined) out.client = { id: o.user_id, name: o.client_name, email: o.client_email, phone: o.client_phone };
  }
  return out;
}

function createOrderQueries(db) {
  return {
    byId: db.prepare(ORDER_WITH_CLIENT + ' WHERE o.id = ?'),
    events: db.prepare('SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id'),
    insert: db.prepare(`
      INSERT INTO orders (user_id, origin, city, car_type, car_model, vin, options, pickup_address, comment, price, km, days_min, days_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertEvent: db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)'),
    setStatus: db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
  };
}

function withEvents(q, order, data) {
  data.events = q.events.all(order.id).map((e) => ({ status: e.status, note: e.note, createdAt: e.created_at }));
  return data;
}

module.exports = { ORDER_WITH_CLIENT, orderNumber, parseOrderNumber, serializeOrder, createOrderQueries, withEvents };
