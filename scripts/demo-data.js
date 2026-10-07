'use strict';

// Демо-данные: сотрудники, клиенты, заказы за последние два месяца, заявки с сайта.
// Используются командой `npm run demo` и генератором скриншотов. Данные детерминированы
// (фиксированный seed), даты отсчитываются от начала текущих суток.

const { hashPassword } = require('../server/auth');
const T = require('../public/tariffs.js');

const DEMO_ACCOUNTS = {
  admin: { email: 'admin@example.com', password: 'admin12345' },
  manager: { email: 'manager@example.com', password: 'manager123' },
  client: { email: 'client0@example.com', password: 'client123' }
};

// Имя, авто, откуда, куда, тип.
const CLIENTS = [
  ['Иван Петров', 'Toyota Land Cruiser 300', 'Владивосток', 'Москва', 'suv'],
  ['Ольга Смирнова', 'Geely Monjaro', 'Казань', 'Москва', 'crossover'],
  ['Дмитрий Ковалёв', 'Toyota Camry', 'Владивосток', 'Новосибирск', 'sedan'],
  ['Алексей Ким', 'Haval Jolion', 'Москва', 'Екатеринбург', 'crossover'],
  ['Марина Орлова', 'Mazda CX-5', 'Владивосток', 'Иркутск', 'crossover'],
  ['Павел Зуев', 'Chery Tiggo 7 Pro', 'Санкт-Петербург', 'Казань', 'crossover'],
  ['Елена Белова', 'Toyota Prius', 'Владивосток', 'Казань', 'sedan'],
  ['Николай Жуков', 'Subaru Forester', 'Владивосток', 'Хабаровск', 'crossover'],
  ['Татьяна Лис', 'Mercedes-Benz Sprinter', 'Москва', 'Краснодар', 'van'],
  ['Руслан Ахметов', 'Toyota Alphard', 'Владивосток', 'Омск', 'van'],
  ['Виктор Гусев', 'Volkswagen Tiguan', 'Калининград', 'Москва', 'crossover'],
  ['Ксения Новак', 'Kia Sorento', 'Владивосток', 'Краснодар', 'suv']
];

// Ориентиры для маршрутов без тарифа: цена седана, км, срок.
const OTHER_ROUTES = {
  'Казань → Москва': [38000, 820, [2, 3]],
  'Москва → Екатеринбург': [52000, 1790, [3, 4]],
  'Санкт-Петербург → Казань': [56000, 1530, [3, 5]],
  'Москва → Краснодар': [48000, 1350, [3, 4]],
  'Калининград → Москва': [62000, 1240, [4, 6]]
};

// Имя, телефон, компания, email, задача, статус, комментарий менеджера.
const LEADS = [
  ['Олег Савин', '+7 (914) 000-11-22', 'ООО «Восток Моторс»', 'o.savin@vostok-motors.example', 'Дилер Geely. Ежемесячно 15–20 машин со склада в Казани в салоны Москвы и Нижнего Новгорода.', 'new', ''],
  ['Светлана Ким', '+7 (924) 321-45-67', 'Лизинг-Финанс', 'kim@leasing.example', 'Изъятые автомобили по регионам, разовые перевозки по 2–3 машины. Нужен договор и закрывающие документы.', 'new', ''],
  ['Артём Галиев', '+7 (902) 555-66-77', 'Каршеринг «Город»', 'fleet@gorod.example', 'Перегон 40 кроссоверов Санкт-Петербург → Казань до конца месяца.', 'in_work', 'Отправил КП, перезвонить в четверг'],
  ['Игорь Белов', '+7 (999) 111-00-00', '', '', 'Одна машина Владивосток → Уфа, Toyota RAV4', 'done', 'Оформлен заказ']
];

function sqlTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedDemo(db) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Отсчёт от начала текущих суток (UTC): повторные запуски в течение дня дают одинаковые данные и скриншоты.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const now = today.getTime();

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
    INSERT INTO orders (user_id, origin, city, car_type, car_model, vin, options, pickup_address, comment, price, km, days_min, days_max,
                        status, created_at, updated_at, payment_status, paid_amount, driver, truck, eta)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEvent = db.prepare('INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)');

  for (let n = 0; n < 46; n++) {
    const i = Math.floor(rnd() * CLIENTS.length);
    const [, car, origin, city, type] = CLIENTS[i];
    const daysAgo = Math.floor(rnd() * rnd() * 58);
    const created = new Date(now - daysAgo * 864e5 - rnd() * 8e7);
    const at = sqlTime(created);
    const opts = rnd() > 0.7 ? ['closed'] : rnd() > 0.5 ? ['door'] : [];
    const q = T.routeQuote(T.DEFAULTS, origin, city, type, opts);
    if (!q.priced) {
      const [base, km, days] = OTHER_ROUTES[origin + ' → ' + city];
      Object.assign(q, { price: Math.round(base * T.findCarType(T.DEFAULTS, type).k / 500) * 500, km, days });
    }
    const stage = daysAgo > 20 ? 5 : daysAgo > 12 ? 3 + Math.floor(rnd() * 3) : Math.floor(rnd() * 4);
    const status = rnd() > 0.93 ? 'cancelled' : T.STATUS_FLOW[stage];
    const payment = status === 'delivered' ? 'paid' : stage >= 1 && status !== 'cancelled' ? 'prepaid' : 'unpaid';
    const paid = payment === 'paid' ? q.price : payment === 'prepaid' ? Math.round(q.price * 0.1 / 500) * 500 : 0;
    const onRoad = stage >= 3 && status !== 'cancelled';
    const eta = onRoad ? new Date(created.getTime() + q.days[1] * 864e5).toISOString().slice(0, 10) : '';

    const id = Number(insOrder.run(
      ids[i], origin, city, type, car, JSON.stringify(q.options), origin === 'Владивосток' ? 'СВХ Владивосток' : 'Склад дилера, ' + origin, q.price, q.km, q.days[0], q.days[1],
      status, at, at, payment, paid, onRoad ? 'Олег, +7 914 555-12-12' : '', onRoad ? `А${100 + n}ВС 125` : '', eta
    ).lastInsertRowid);
    insEvent.run(id, 'new', 'Заявка создана в личном кабинете', at);
    if (status !== 'new') insEvent.run(id, status, status === 'in_transit' ? 'Автовоз выехал, город отправления: ' + origin : '', at);
  }

  const insLead = db.prepare('INSERT INTO leads (name, phone, company, email, message, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  LEADS.forEach((l, i) => insLead.run(...l, sqlTime(new Date(now - (LEADS.length - i) * 3.6e6))));

  const insAudit = db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at) VALUES (1, ?, ?, ?, ?, ?)');
  insAudit.run('Добавил сотрудника', 'staff', '2', 'Анна Менеджерова (Менеджер)', sqlTime(new Date(now - 58 * 864e5)));
  insAudit.run('Обновил тарифы', 'tariffs', '', '23 городов', sqlTime(new Date(now - 30 * 864e5)));
  insAudit.run('Обновил настройки сайта', 'settings', '', '', sqlTime(new Date(now - 29 * 864e5)));
}

module.exports = { seedDemo, DEMO_ACCOUNTS };
