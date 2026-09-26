'use strict';

// Демо-данные: сотрудники, клиенты, заказы за последние два месяца, заявки с сайта.
// Используются командой `npm run demo` и генератором скриншотов. Данные детерминированы
// (фиксированный seed), даты отсчитываются от текущего момента.

const { hashPassword } = require('../server/auth');
const T = require('../public/tariffs.js');

const DEMO_ACCOUNTS = {
  admin: { email: 'admin@example.com', password: 'admin12345' },
  manager: { email: 'manager@example.com', password: 'manager123' },
  client: { email: 'client0@example.com', password: 'client123' }
};

const CLIENTS = [
  ['Иван Петров', 'Toyota Land Cruiser 300', 'Москва', 'suv'],
  ['Ольга Смирнова', 'Honda Vezel', 'Москва', 'crossover'],
  ['Дмитрий Ковалёв', 'Toyota Camry', 'Новосибирск', 'sedan'],
  ['Алексей Ким', 'Lexus RX 350', 'Екатеринбург', 'crossover'],
  ['Марина Орлова', 'Mazda CX-5', 'Иркутск', 'crossover'],
  ['Павел Зуев', 'Nissan X-Trail', 'Красноярск', 'crossover'],
  ['Елена Белова', 'Toyota Prius', 'Казань', 'sedan'],
  ['Николай Жуков', 'Subaru Forester', 'Хабаровск', 'crossover'],
  ['Татьяна Лис', 'Mitsubishi Delica', 'Санкт-Петербург', 'van'],
  ['Руслан Ахметов', 'Toyota Alphard', 'Омск', 'van'],
  ['Виктор Гусев', 'Honda Fit', 'Москва', 'sedan'],
  ['Ксения Новак', 'Kia Sorento', 'Краснодар', 'suv']
];

const LEADS = [
  ['Олег', '+7 (914) 000-11-22', 'Владивосток → Омск', '92 000 ₽', 'new', ''],
  ['Светлана', '+7 (924) 321-45-67', 'Владивосток → Москва', '155 000 ₽', 'new', ''],
  ['Артём', '+7 (902) 555-66-77', 'Владивосток → Казань, Land Cruiser', '162 500 ₽', 'in_work', 'Перезвонить после 18:00'],
  ['Игорь', '+7 (999) 111-00-00', 'Владивосток → Уфа', '118 000 ₽', 'done', 'Оформлен заказ']
];

function sqlTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedDemo(db) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const now = Date.now();

  const insUser = db.prepare('INSERT INTO users (email, password_hash, name, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insUser.run(DEMO_ACCOUNTS.admin.email, hashPassword(DEMO_ACCOUNTS.admin.password), 'Сергей Админов', '+7 (914) 111-22-33', 'admin', sqlTime(new Date(now - 60 * 864e5)));
  insUser.run(DEMO_ACCOUNTS.manager.email, hashPassword(DEMO_ACCOUNTS.manager.password), 'Анна Менеджерова', '+7 (914) 222-33-44', 'manager', sqlTime(new Date(now - 58 * 864e5)));

  const clientHash = hashPassword(DEMO_ACCOUNTS.client.password);
  const ids = CLIENTS.map(([name], i) => Number(insUser.run(
    i < 9 ? `client${i}@example.com` : null,
    i < 7 ? clientHash : '',
    name,
    `+7 (9${10 + i}) ${100 + i * 7}-${10 + i}-${20 + i}`,
    'client',
    sqlTime(new Date(now - (50 - i * 4) * 864e5))
  ).lastInsertRowid));

  const insOrder = db.prepare(`
    INSERT INTO orders (user_id, city, car_type, car_model, vin, options, pickup_address, comment, price, km, days_min, days_max,
                        status, created_at, updated_at, payment_status, paid_amount, driver, truck, eta)
    VALUES (?, ?, ?, ?, '', ?, 'СВХ Владивосток', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEvent = db.prepare('INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)');

  for (let n = 0; n < 46; n++) {
    const i = Math.floor(rnd() * CLIENTS.length);
    const [, car, city, type] = CLIENTS[i];
    const daysAgo = Math.floor(rnd() * rnd() * 58);
    const created = new Date(now - daysAgo * 864e5 - rnd() * 8e7);
    const at = sqlTime(created);
    const opts = rnd() > 0.7 ? ['closed'] : rnd() > 0.5 ? ['door'] : [];
    const q = T.quote(T.DEFAULTS, city, type, opts);
    const stage = daysAgo > 20 ? 5 : daysAgo > 12 ? 3 + Math.floor(rnd() * 3) : Math.floor(rnd() * 4);
    const status = rnd() > 0.93 ? 'cancelled' : T.STATUS_FLOW[stage];
    const payment = status === 'delivered' ? 'paid' : stage >= 1 && status !== 'cancelled' ? 'prepaid' : 'unpaid';
    const paid = payment === 'paid' ? q.price : payment === 'prepaid' ? Math.round(q.price * 0.1 / 500) * 500 : 0;
    const onRoad = stage >= 3 && status !== 'cancelled';
    const eta = onRoad ? new Date(created.getTime() + q.days[1] * 864e5).toISOString().slice(0, 10) : '';

    const id = Number(insOrder.run(
      ids[i], city, type, car, JSON.stringify(opts), q.price, q.km, q.days[0], q.days[1],
      status, at, at, payment, paid, onRoad ? 'Олег, +7 914 555-12-12' : '', onRoad ? `А${100 + n}ВС 125` : '', eta
    ).lastInsertRowid);
    insEvent.run(id, 'new', 'Заявка создана в личном кабинете', at);
    if (status !== 'new') insEvent.run(id, status, status === 'in_transit' ? 'Автовоз выехал из Владивостока' : '', at);
  }

  const insLead = db.prepare('INSERT INTO leads (name, phone, route, estimate, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  LEADS.forEach((l, i) => insLead.run(...l, sqlTime(new Date(now - (LEADS.length - i) * 3.6e6))));

  const insAudit = db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at) VALUES (1, ?, ?, ?, ?, ?)');
  insAudit.run('Добавил сотрудника', 'staff', '2', 'Анна Менеджерова (Менеджер)', sqlTime(new Date(now - 58 * 864e5)));
  insAudit.run('Обновил тарифы', 'tariffs', '', '23 городов', sqlTime(new Date(now - 30 * 864e5)));
  insAudit.run('Обновил настройки сайта', 'settings', '', '', sqlTime(new Date(now - 29 * 864e5)));
}

module.exports = { seedDemo, DEMO_ACCOUNTS };
