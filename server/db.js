'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const T = require('../public/tariffs.js');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

const DEFAULT_SETTINGS = {
  phone: '+7 (900) 000-00-00',
  email: 'info@example.com',
  address: '',
  hours: 'Ежедневно 08:00–20:00',
  telegram: '',
  whatsapp: '',
  vk: '',
  about: '',
  requisites: ''
};

function open(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  // Встроенные lower()/LIKE в SQLite не понимают кириллицу — поиск идёт через эти функции.
  db.function('ulower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
  db.function('digits', { deterministic: true }, (s) => (s == null ? null : String(s).replace(/\D/g, '')));
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// Миграции применяются по порядку; номер последней хранится в PRAGMA user_version.
// Внешние ключи на время миграций выключены, чтобы пересоздание таблиц не каскадило удаления.
const MIGRATIONS = [
  // 1. Исходная схема.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      phone         TEXT    NOT NULL DEFAULT '',
      role          TEXT    NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'manager')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      city           TEXT    NOT NULL,
      car_type       TEXT    NOT NULL,
      car_model      TEXT    NOT NULL,
      vin            TEXT    NOT NULL DEFAULT '',
      options        TEXT    NOT NULL DEFAULT '[]',
      pickup_address TEXT    NOT NULL DEFAULT '',
      comment        TEXT    NOT NULL DEFAULT '',
      price          INTEGER NOT NULL,
      km             INTEGER NOT NULL,
      days_min       INTEGER NOT NULL,
      days_max       INTEGER NOT NULL,
      status         TEXT    NOT NULL DEFAULT 'new',
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status     TEXT    NOT NULL,
      note       TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id);

    CREATE TABLE IF NOT EXISTS leads (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      phone      TEXT    NOT NULL,
      route      TEXT    NOT NULL DEFAULT '',
      estimate   TEXT    NOT NULL DEFAULT '',
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      processed  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `),

  // 2. Админ-панель: роль admin, блокировка, поля заказов и заявок, тарифы, настройки, журнал.
  (db) => {
    db.exec(`
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    UNIQUE COLLATE NOCASE,
        password_hash TEXT    NOT NULL,
        name          TEXT    NOT NULL,
        phone         TEXT    NOT NULL DEFAULT '',
        role          TEXT    NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'manager', 'admin')),
        blocked       INTEGER NOT NULL DEFAULT 0,
        note          TEXT    NOT NULL DEFAULT '',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, email, password_hash, name, phone, role, created_at)
        SELECT id, email, password_hash, name, phone, role, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;

      ALTER TABLE orders ADD COLUMN manager_note   TEXT    NOT NULL DEFAULT '';
      ALTER TABLE orders ADD COLUMN driver         TEXT    NOT NULL DEFAULT '';
      ALTER TABLE orders ADD COLUMN truck          TEXT    NOT NULL DEFAULT '';
      ALTER TABLE orders ADD COLUMN eta            TEXT    NOT NULL DEFAULT '';
      ALTER TABLE orders ADD COLUMN payment_status TEXT    NOT NULL DEFAULT 'unpaid';
      ALTER TABLE orders ADD COLUMN paid_amount    INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);

      ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
      ALTER TABLE leads ADD COLUMN note   TEXT NOT NULL DEFAULT '';
      UPDATE leads SET status = 'done' WHERE processed = 1;

      CREATE TABLE tariff_cities (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT    NOT NULL UNIQUE,
        km       INTEGER NOT NULL,
        days_min INTEGER NOT NULL,
        days_max INTEGER NOT NULL,
        price    INTEGER NOT NULL,
        active   INTEGER NOT NULL DEFAULT 1,
        sort     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tariff_car_types (
        key    TEXT    PRIMARY KEY,
        label  TEXT    NOT NULL,
        k      REAL    NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        sort   INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tariff_options (
        key     TEXT    PRIMARY KEY,
        label   TEXT    NOT NULL,
        hint    TEXT    NOT NULL DEFAULT '',
        percent REAL    NOT NULL DEFAULT 0,
        fixed   INTEGER NOT NULL DEFAULT 0,
        active  INTEGER NOT NULL DEFAULT 1,
        sort    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action     TEXT    NOT NULL,
        entity     TEXT    NOT NULL DEFAULT '',
        entity_id  TEXT    NOT NULL DEFAULT '',
        details    TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX audit_created ON audit_log(created_at);
    `);

    const city = db.prepare('INSERT INTO tariff_cities (name, km, days_min, days_max, price, sort) VALUES (?, ?, ?, ?, ?, ?)');
    T.DEFAULTS.cities.forEach((c, i) => city.run(c.name, c.km, c.days[0], c.days[1], c.price, i));
    const type = db.prepare('INSERT INTO tariff_car_types (key, label, k, sort) VALUES (?, ?, ?, ?)');
    T.DEFAULTS.carTypes.forEach((t, i) => type.run(t.key, t.label, t.k, i));
    const opt = db.prepare('INSERT INTO tariff_options (key, label, hint, percent, fixed, sort) VALUES (?, ?, ?, ?, ?, ?)');
    T.DEFAULTS.options.forEach((o, i) => opt.run(o.key, o.label, o.hint, o.percent, o.fixed, i));
    const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setting.run(k, v);
  },

  // 3. Сайт-визитка для компаний: перевозки по всей России, заявки на сотрудничество.
  (db) => db.exec(`
    ALTER TABLE orders ADD COLUMN origin TEXT NOT NULL DEFAULT 'Владивосток';

    ALTER TABLE leads ADD COLUMN company TEXT NOT NULL DEFAULT '';
    ALTER TABLE leads ADD COLUMN email   TEXT NOT NULL DEFAULT '';
    ALTER TABLE leads ADD COLUMN message TEXT NOT NULL DEFAULT '';

    -- Заглушки, привязанные к Владивостоку, убираем; реальные значения не трогаем.
    UPDATE settings SET value = '' WHERE key = 'address' AND value = 'г. Владивосток, ул. Примерная, 1';
    UPDATE settings SET value = 'Ежедневно 08:00–20:00' WHERE key = 'hours' AND value = 'Ежедневно 08:00–20:00 (Влд)';
  `)
];

function migrate(db) {
  db.exec('PRAGMA foreign_keys = OFF;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

// Выполняет fn внутри транзакции.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, tx, DB_PATH, DEFAULT_SETTINGS };
