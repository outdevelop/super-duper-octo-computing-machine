// Справочники и расчёт стоимости. Общий файл для браузера (window.TARIFFS) и сервера (require).
// Сами тарифы хранятся в БД и приходят с /api/tariffs; DEFAULTS — начальные значения
// для заполнения пустой базы и запасной вариант, если сервер недоступен.
(function (root) {
  'use strict';

  var ORIGIN = 'Владивосток';

  var DEFAULTS = {
    cities: [
      { name: 'Москва',            km: 9150, days: [14, 18], price: 135000 },
      { name: 'Санкт-Петербург',   km: 9850, days: [16, 20], price: 150000 },
      { name: 'Новосибирск',       km: 5750, days: [8, 11],  price: 85000 },
      { name: 'Екатеринбург',      km: 7450, days: [11, 14], price: 110000 },
      { name: 'Казань',            km: 8350, days: [12, 16], price: 125000 },
      { name: 'Краснодар',         km: 9600, days: [15, 19], price: 155000 },
      { name: 'Иркутск',           km: 3900, days: [6, 8],   price: 65000 },
      { name: 'Красноярск',        km: 4950, days: [7, 10],  price: 75000 },
      { name: 'Хабаровск',         km: 760,  days: [1, 2],   price: 22000 },
      { name: 'Омск',              km: 6400, days: [9, 12],  price: 92000 },
      { name: 'Уфа',               km: 7900, days: [12, 15], price: 118000 },
      { name: 'Самара',            km: 8350, days: [12, 16], price: 124000 },
      { name: 'Нижний Новгород',   km: 8750, days: [13, 17], price: 130000 },
      { name: 'Ростов-на-Дону',    km: 9400, days: [15, 19], price: 150000 },
      { name: 'Воронеж',           km: 9250, days: [14, 18], price: 140000 },
      { name: 'Челябинск',         km: 7250, days: [11, 14], price: 108000 },
      { name: 'Тюмень',            km: 7100, days: [10, 13], price: 102000 },
      { name: 'Пермь',             km: 7750, days: [12, 15], price: 115000 },
      { name: 'Барнаул',           km: 5950, days: [9, 11],  price: 88000 },
      { name: 'Улан-Удэ',          km: 3450, days: [5, 7],   price: 58000 },
      { name: 'Чита',              km: 2850, days: [4, 6],   price: 50000 },
      { name: 'Благовещенск',      km: 1650, days: [2, 4],   price: 35000 },
      { name: 'Якутск',            km: 3100, days: [8, 12],  price: 95000 }
    ],
    carTypes: [
      { key: 'sedan',     label: 'Седан / хэтчбек',       k: 1 },
      { key: 'crossover', label: 'Кроссовер',             k: 1.15 },
      { key: 'suv',       label: 'Внедорожник / минивэн', k: 1.3 },
      { key: 'van',       label: 'Микроавтобус',          k: 1.6 }
    ],
    options: [
      { key: 'closed', label: 'Закрытый автовоз',     hint: 'Для премиум и спорткаров',     percent: 35, fixed: 0 },
      { key: 'door',   label: 'Доставка до двери',    hint: 'Эвакуатор в городе получения', percent: 0,  fixed: 6000 },
      { key: 'port',   label: 'Забор из порта / СВХ', hint: 'Получим авто за вас',          percent: 0,  fixed: 8000 }
    ]
  };

  var STATUSES = {
    new:        'Новая заявка',
    confirmed:  'Договор подписан',
    pickup:     'Приёмка авто',
    in_transit: 'В пути',
    arrived:    'Прибыл в город',
    delivered:  'Выдан',
    cancelled:  'Отменён'
  };
  var STATUS_FLOW = ['new', 'confirmed', 'pickup', 'in_transit', 'arrived', 'delivered'];

  var PAYMENT_STATUSES = {
    unpaid:  'Не оплачен',
    prepaid: 'Предоплата',
    paid:    'Оплачен'
  };

  var LEAD_STATUSES = {
    new:     'Новая',
    in_work: 'В работе',
    done:    'Обработана',
    spam:    'Спам'
  };

  var ROLES = {
    client:  'Клиент',
    manager: 'Менеджер',
    admin:   'Администратор'
  };

  function byKey(list, key, field) {
    for (var i = 0; i < list.length; i++) if (list[i][field] === key) return list[i];
    return null;
  }

  function findCity(tariffs, name) { return byKey(tariffs.cities, name, 'name'); }
  function findCarType(tariffs, key) { return byKey(tariffs.carTypes, key, 'key'); }
  function findOption(tariffs, key) { return byKey(tariffs.options, key, 'key'); }

  function carTypeLabel(tariffs, key) {
    var t = findCarType(tariffs, key);
    return t ? t.label : key;
  }

  function optionLabels(tariffs, keys) {
    return (keys || []).map(function (k) {
      var o = findOption(tariffs, k);
      return o ? o.label : k;
    });
  }

  // Возвращает { price, km, days, options } или null, если город или тип неизвестны.
  function quote(tariffs, cityName, carType, options) {
    var city = findCity(tariffs, cityName);
    var type = findCarType(tariffs, carType);
    if (!city || !type) return null;
    var total = city.price * type.k;
    var opts = (options || []).filter(function (k, i, arr) {
      return findOption(tariffs, k) && arr.indexOf(k) === i;
    });
    opts.forEach(function (k) { var o = findOption(tariffs, k); if (o.percent) total *= 1 + o.percent / 100; });
    opts.forEach(function (k) { var o = findOption(tariffs, k); if (o.fixed) total += o.fixed; });
    return {
      price: Math.round(total / 500) * 500,
      km: city.km,
      days: city.days.slice(),
      options: opts
    };
  }

  var api = {
    ORIGIN: ORIGIN,
    DEFAULTS: DEFAULTS,
    STATUSES: STATUSES,
    STATUS_FLOW: STATUS_FLOW,
    PAYMENT_STATUSES: PAYMENT_STATUSES,
    LEAD_STATUSES: LEAD_STATUSES,
    ROLES: ROLES,
    findCity: findCity,
    findCarType: findCarType,
    findOption: findOption,
    carTypeLabel: carTypeLabel,
    optionLabels: optionLabels,
    quote: quote
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TARIFFS = api;
})(this);
