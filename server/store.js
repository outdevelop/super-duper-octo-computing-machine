'use strict';

// Тарифы, настройки сайта и журнал действий.

const crypto = require('node:crypto');
const T = require('../public/tariffs.js');
const v = require('./validate');
const { tx, DEFAULT_SETTINGS } = require('./db');

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

function createStore(db) {
  const q = {
    cities: db.prepare('SELECT * FROM tariff_cities ORDER BY sort, id'),
    carTypes: db.prepare('SELECT * FROM tariff_car_types ORDER BY sort, key'),
    options: db.prepare('SELECT * FROM tariff_options ORDER BY sort, key'),
    usedCarType: db.prepare('SELECT 1 FROM orders WHERE car_type = ? LIMIT 1'),
    usedOption: db.prepare("SELECT 1 FROM orders, json_each(orders.options) WHERE json_each.value = ? LIMIT 1"),
    settings: db.prepare('SELECT key, value FROM settings'),
    upsertSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    audit: db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
  };

  let publicCache = null;

  /* ---------- Тарифы ---------- */

  function allTariffs() {
    return {
      cities: q.cities.all().map((c) => ({
        id: c.id, name: c.name, km: c.km, days: [c.days_min, c.days_max], price: c.price, active: !!c.active
      })),
      carTypes: q.carTypes.all().map((t) => ({ key: t.key, label: t.label, k: t.k, active: !!t.active })),
      options: q.options.all().map((o) => ({
        key: o.key, label: o.label, hint: o.hint, percent: o.percent, fixed: o.fixed, active: !!o.active
      }))
    };
  }

  // Активные тарифы в формате, который понимает tariffs.js (сайт, кабинет, расчёт заказа).
  function publicTariffs() {
    if (!publicCache) {
      const all = allTariffs();
      publicCache = {
        cities: all.cities.filter((c) => c.active).map(({ name, km, days, price }) => ({ name, km, days, price })),
        carTypes: all.carTypes.filter((t) => t.active).map(({ key, label, k }) => ({ key, label, k })),
        options: all.options.filter((o) => o.active).map(({ key, label, hint, percent, fixed }) => ({ key, label, hint, percent, fixed }))
      };
    }
    return publicCache;
  }

  // Для отображения заказов нужны и отключённые типы/опции, чтобы показать их названия.
  function labelTariffs() {
    const all = allTariffs();
    return { cities: all.cities, carTypes: all.carTypes, options: all.options };
  }

  function newKey(prefix) {
    return prefix + '_' + crypto.randomBytes(4).toString('hex');
  }

  // Полностью заменяет тарифы. Типы и опции, которые уже есть в заказах, не удаляются, а отключаются.
  function saveTariffs(payload) {
    const b = payload || {};
    if (!Array.isArray(b.cities) || !Array.isArray(b.carTypes) || !Array.isArray(b.options)) {
      throw new v.HttpError(400, 'Ожидаются списки городов, типов и опций');
    }
    if (b.cities.length > 500 || b.carTypes.length > 50 || b.options.length > 50) {
      throw new v.HttpError(400, 'Слишком много записей');
    }

    const seen = new Set();
    const cities = b.cities.map((c, i) => {
      const row = c || {};
      const name = v.str(row.name, { max: 100, required: true, field: `Город в строке ${i + 1}` });
      if (seen.has(name.toLowerCase())) throw new v.HttpError(400, `Город «${name}» указан дважды`);
      seen.add(name.toLowerCase());
      const days = Array.isArray(row.days) ? row.days : [];
      const dMin = v.int(days[0], { min: 0, max: 365, field: `${name}: срок от` });
      const dMax = v.int(days[1], { min: dMin, max: 365, field: `${name}: срок до` });
      return {
        name,
        km: v.int(row.km, { min: 0, max: 30000, field: `${name}: расстояние` }),
        dMin, dMax,
        price: v.int(row.price, { min: 0, max: 100000000, field: `${name}: цена` }),
        active: row.active === false ? 0 : 1
      };
    });

    const carTypes = b.carTypes.map((t, i) => {
      const row = t || {};
      const label = v.str(row.label, { max: 100, required: true, field: `Тип авто в строке ${i + 1}` });
      return {
        key: typeof row.key === 'string' && /^[a-z0-9_]{1,40}$/.test(row.key) ? row.key : newKey('type'),
        label,
        k: v.num(row.k, { min: 0.1, max: 10, field: `${label}: коэффициент` }),
        active: row.active === false ? 0 : 1
      };
    });
    if (!cities.some((c) => c.active)) throw new v.HttpError(400, 'Нужен хотя бы один активный город');
    if (!carTypes.some((t) => t.active)) throw new v.HttpError(400, 'Нужен хотя бы один активный тип автомобиля');

    const options = b.options.map((o, i) => {
      const row = o || {};
      const label = v.str(row.label, { max: 100, required: true, field: `Опция в строке ${i + 1}` });
      return {
        key: typeof row.key === 'string' && /^[a-z0-9_]{1,40}$/.test(row.key) ? row.key : newKey('opt'),
        label,
        hint: v.str(row.hint, { max: 200, field: `${label}: подсказка` }),
        percent: v.num(row.percent || 0, { min: 0, max: 500, field: `${label}: наценка %` }),
        fixed: v.int(row.fixed || 0, { min: 0, max: 10000000, field: `${label}: доплата` }),
        active: row.active === false ? 0 : 1
      };
    });

    tx(db, () => {
      db.exec('DELETE FROM tariff_cities');
      const ins = db.prepare('INSERT INTO tariff_cities (name, km, days_min, days_max, price, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
      cities.forEach((c, i) => ins.run(c.name, c.km, c.dMin, c.dMax, c.price, c.active, i));

      const keepTypes = new Set(carTypes.map((t) => t.key));
      for (const old of q.carTypes.all()) {
        if (keepTypes.has(old.key)) continue;
        if (q.usedCarType.get(old.key)) carTypes.push({ key: old.key, label: old.label, k: old.k, active: 0 });
      }
      db.exec('DELETE FROM tariff_car_types');
      const insT = db.prepare('INSERT INTO tariff_car_types (key, label, k, active, sort) VALUES (?, ?, ?, ?, ?)');
      carTypes.forEach((t, i) => insT.run(t.key, t.label, t.k, t.active, i));

      const keepOpts = new Set(options.map((o) => o.key));
      for (const old of q.options.all()) {
        if (keepOpts.has(old.key)) continue;
        if (q.usedOption.get(old.key)) options.push({ ...old, active: 0 });
      }
      db.exec('DELETE FROM tariff_options');
      const insO = db.prepare('INSERT INTO tariff_options (key, label, hint, percent, fixed, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
      options.forEach((o, i) => insO.run(o.key, o.label, o.hint, o.percent, o.fixed, o.active, i));
    });
    publicCache = null;
    return allTariffs();
  }

  /* ---------- Настройки ---------- */

  function settings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of q.settings.all()) if (SETTING_KEYS.includes(row.key)) out[row.key] = row.value;
    return out;
  }

  function saveSettings(payload) {
    const b = payload || {};
    const next = {
      phone: v.phone(b.phone, { required: true }),
      email: v.email(b.email),
      address: v.str(b.address, { max: 300, field: 'Адрес' }),
      hours: v.str(b.hours, { max: 200, field: 'Часы работы' }),
      telegram: v.str(b.telegram, { max: 200, field: 'Telegram' }),
      whatsapp: v.str(b.whatsapp, { max: 200, field: 'WhatsApp' }),
      vk: v.str(b.vk, { max: 200, field: 'VK' })
    };
    for (const key of ['telegram', 'whatsapp', 'vk']) {
      if (next[key] && !/^https:\/\//.test(next[key])) throw new v.HttpError(400, `${key}: ссылка должна начинаться с https://`);
    }
    tx(db, () => { for (const [k, val] of Object.entries(next)) q.upsertSetting.run(k, val); });
    return settings();
  }

  /* ---------- Журнал ---------- */

  function audit(user, action, entity = '', entityId = '', details = '') {
    q.audit.run(user ? user.id : null, action, entity, String(entityId), String(details).slice(0, 1000));
  }

  return { allTariffs, publicTariffs, labelTariffs, saveTariffs, settings, saveSettings, audit, quote: (...a) => T.quote(publicTariffs(), ...a) };
}

module.exports = { createStore };
