(function () {
  'use strict';

  var T = window.TARIFFS;
  var fmt = new Intl.NumberFormat('ru-RU');
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  var state = { user: null, tariffs: null, pendingLead: null, dirty: false, counts: {} };
  var content = $('#content');

  /* =====================================================================
     Утилиты
     ===================================================================== */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) { return fmt.format(Math.round(n || 0)) + '\u00a0₽'; }

  // Даты из SQLite приходят в UTC без зоны: "2026-09-26 12:00:00".
  function formatDate(value, withTime) {
    if (!value) return '—';
    var d = new Date(String(value).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return esc(value);
    var opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString('ru-RU', opts);
  }

  function formatDay(value, short) {
    if (!value) return '—';
    var d = new Date(value + 'T00:00:00');
    if (isNaN(d)) return esc(value);
    return d.toLocaleDateString('ru-RU', short ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function telHref(phone) { return 'tel:+' + String(phone || '').replace(/\D/g, ''); }

  function isAdmin() { return state.user && state.user.role === 'admin'; }

  function api(method, url, body) {
    return fetch('/api' + url, {
      method: method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Ошибка ' + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error('Сервер недоступен. Проверьте подключение.');
    });
  }

  var toastTimer;
  function toast(text) {
    var el = $('#toast');
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 3200);
  }

  function handleError(err) {
    if (err.status === 401) { showLogin(); toast('Сессия истекла, войдите снова'); return; }
    if (err.status === 403) { toast('Недостаточно прав'); return; }
    toast(err.message);
  }

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  function maskPhone(input) {
    var digits = input.value.replace(/\D/g, '');
    if (digits[0] === '8') digits = '7' + digits.slice(1);
    if (digits && digits[0] !== '7') digits = '7' + digits;
    digits = digits.slice(0, 11);
    var d = digits.slice(1);
    var out = digits ? '+7' : '';
    if (d.length) out += ' (' + d.slice(0, 3);
    if (d.length >= 3) out += ')';
    if (d.length > 3) out += ' ' + d.slice(3, 6);
    if (d.length > 6) out += '-' + d.slice(6, 8);
    if (d.length > 8) out += '-' + d.slice(8, 10);
    input.value = out;
  }
  document.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('[data-phone]')) maskPhone(e.target);
  });

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function options(map, selected, empty) {
    var out = empty !== undefined ? '<option value="">' + esc(empty) + '</option>' : '';
    Object.keys(map).forEach(function (k) {
      out += '<option value="' + esc(k) + '"' + (k === selected ? ' selected' : '') + '>' + esc(map[k]) + '</option>';
    });
    return out;
  }

  function badge(status) {
    return '<span class="badge badge--' + esc(status) + '">' + esc(T.STATUSES[status] || status) + '</span>';
  }

  function payPill(o) {
    var label = T.PAYMENT_STATUSES[o.paymentStatus] || o.paymentStatus;
    if (o.paymentStatus === 'prepaid') label += ' ' + fmt.format(o.paidAmount);
    return '<span class="pill pill--' + esc(o.paymentStatus) + '">' + esc(label) + '</span>';
  }

  function field(label, control, cls, hint) {
    return '<div class="field' + (cls ? ' ' + cls : '') + '"><label>' + esc(label) + '</label>' + control +
      (hint ? '<p class="field__hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function input(name, value, attrs) {
    return '<input class="field__input" name="' + name + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + '>';
  }

  function textarea(name, value, attrs) {
    return '<textarea class="field__input" name="' + name + '" ' + (attrs || '') + '>' + esc(value || '') + '</textarea>';
  }

  // Тарифы для расчёта — только активные позиции.
  function activeTariffs() {
    var t = state.tariffs;
    return {
      cities: t.cities.filter(function (c) { return c.active; }),
      carTypes: t.carTypes.filter(function (c) { return c.active; }),
      options: t.options.filter(function (c) { return c.active; })
    };
  }

  function loadTariffs(force) {
    if (state.tariffs && !force) return Promise.resolve(state.tariffs);
    return api('GET', '/admin/tariffs').then(function (t) { state.tariffs = t; return t; });
  }

  /* =====================================================================
     Тултип и диалог
     ===================================================================== */

  var tip = $('#tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    var w = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(x, w / 2 + 8), window.innerWidth - w / 2 - 8) + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }

  var dialog = $('#dialog');
  var dialogHandler = null;

  function openDialog(opts) {
    $('#dialogTitle').textContent = opts.title;
    $('#dialogBody').innerHTML = opts.body;
    $('#dialogOk').textContent = opts.ok || 'Сохранить';
    $('#dialogOk').className = 'btn ' + (opts.danger ? 'btn--danger' : 'btn--dark');
    $('#dialogOk').disabled = false;
    setStatus($('#dialogStatus'), '');
    dialogHandler = opts.onSubmit;
    dialog.showModal();
    var first = $('#dialogBody input:not([type=checkbox]), #dialogBody select, #dialogBody textarea');
    if (first && !opts.danger) first.focus();
  }

  function closeDialog() { dialog.close(); dialogHandler = null; }

  $('#dialogForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!dialogHandler) return closeDialog();
    var btn = $('#dialogOk');
    btn.disabled = true;
    setStatus($('#dialogStatus'), '');
    Promise.resolve().then(function () { return dialogHandler($('#dialogBody')); })
      .then(function () { closeDialog(); })
      .catch(function (err) {
        if (err.status === 401) { closeDialog(); return handleError(err); }
        setStatus($('#dialogStatus'), err.message, 'error');
        btn.disabled = false;
      });
  });
  $('#dialogCancel').addEventListener('click', closeDialog);
  $('#dialogClose').addEventListener('click', closeDialog);

  function confirmDialog(title, text, okText) {
    return new Promise(function (resolve) {
      openDialog({
        title: title, body: '<p>' + esc(text) + '</p>', ok: okText || 'Удалить', danger: true,
        onSubmit: function () { resolve(true); }
      });
      dialog.addEventListener('close', function onClose() {
        dialog.removeEventListener('close', onClose);
        resolve(false);
      });
    });
  }

  function formData(root) {
    var out = {};
    $$('input[name], select[name], textarea[name]', root).forEach(function (el) {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    });
    return out;
  }

  /* =====================================================================
     Навигация и роутинг
     ===================================================================== */

  var ICONS = {
    dashboard: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
    orders: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    leads: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
    clients: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.6 2.5 3 5.2"/>',
    staff: '<path d="M12 3l8 3v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>',
    tariffs: '<path d="M4 4h9l7 7-9 9-7-7z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    audit: '<path d="M8 4h8M9 4v3M15 4v3"/><rect x="4" y="6" width="16" height="15" rx="2"/><path d="M8 12h8M8 16h5"/>',
    site: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
  };

  var NAV = [
    { route: 'dashboard', label: 'Дашборд' },
    { group: 'Работа' },
    { route: 'orders', label: 'Заказы', count: 'newOrders' },
    { route: 'leads', label: 'Заявки с сайта', count: 'newLeads' },
    { route: 'clients', label: 'Клиенты' },
    { group: 'Управление', admin: true },
    { route: 'staff', label: 'Сотрудники', admin: true },
    { route: 'tariffs', label: 'Тарифы', admin: true },
    { route: 'settings', label: 'Настройки сайта', admin: true },
    { route: 'audit', label: 'Журнал действий', admin: true },
    { group: ' ' },
    { href: './', label: 'Открыть сайт', icon: 'site' }
  ];

  function icon(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }

  function renderNav() {
    $('#admNav').innerHTML = NAV.filter(function (n) { return !n.admin || isAdmin(); }).map(function (n) {
      if (n.group) return '<p class="adm-nav__group">' + esc(n.group) + '</p>';
      if (n.href) return '<a href="' + n.href + '" target="_blank" rel="noopener">' + icon(n.icon) + esc(n.label) + '</a>';
      var count = n.count && state.counts[n.count] ? '<span class="adm-nav__count">' + state.counts[n.count] + '</span>' : '';
      return '<a href="#' + n.route + '" data-route="' + n.route + '">' + icon(n.route) + esc(n.label) + count + '</a>';
    }).join('');
    markNav();
  }

  function markNav() {
    var name = parseHash().name;
    var section = { order: 'orders', 'new-order': 'orders', client: 'clients' }[name] || name;
    $$('#admNav a[data-route]').forEach(function (a) { a.classList.toggle('is-active', a.dataset.route === section); });
  }

  function refreshCounts() {
    return api('GET', '/admin/dashboard').then(function (d) {
      state.counts = { newOrders: d.kpi.newOrders, newLeads: d.kpi.newLeads };
      renderNav();
      return d;
    });
  }

  // "#orders?status=new&page=2" → { name: 'orders', id: null, params: {...} }
  function parseHash() {
    var raw = location.hash.replace(/^#/, '') || 'dashboard';
    var q = raw.indexOf('?');
    var path = q >= 0 ? raw.slice(0, q) : raw;
    var params = {};
    new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '').forEach(function (v, k) { params[k] = v; });
    var parts = path.split('/');
    return { name: parts[0], id: parts[1] || null, params: params };
  }

  function hashFor(name, params) {
    var clean = {};
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== '' && params[k] != null && !(k === 'page' && String(params[k]) === '1')) clean[k] = params[k];
    });
    var qs = new URLSearchParams(clean).toString();
    return '#' + name + (qs ? '?' + qs : '');
  }

  function go(hash, replace) {
    if (replace) { history.replaceState(null, '', hash); route(); } else location.hash = hash;
  }

  var ROUTES = {
    dashboard: viewDashboard,
    orders: viewOrders,
    order: viewOrder,
    'new-order': viewNewOrder,
    leads: viewLeads,
    clients: viewClients,
    client: viewClient,
    staff: viewStaff,
    tariffs: viewTariffs,
    settings: viewSettings,
    audit: viewAudit
  };
  var ADMIN_ONLY = { staff: 1, tariffs: 1, settings: 1, audit: 1 };

  var lastHash = location.hash;
  function route() {
    if (!state.user) return;
    if (state.dirty && location.hash !== lastHash) {
      if (!window.confirm('Есть несохранённые изменения. Уйти со страницы?')) {
        history.replaceState(null, '', lastHash);
        return;
      }
      state.dirty = false;
    }
    lastHash = location.hash;
    var r = parseHash();
    if (!ROUTES[r.name] || (ADMIN_ONLY[r.name] && !isAdmin())) { go('#dashboard', true); return; }
    closeMenu();
    hideTip();
    markNav();
    // Обработчики конкретного раздела живут до следующего перехода.
    content.onclick = content.oninput = content.onchange = null;
    window.onresize = null;
    content.innerHTML = '<div class="skeleton"></div>';
    setPage('', '', '');
    ROUTES[r.name](r);
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  function setPage(title, crumb, actions) {
    $('#pageTitle').textContent = title || '';
    $('#crumb').innerHTML = crumb || '';
    $('#pageActions').innerHTML = actions || '';
    document.title = (title ? title + ' — ' : '') + 'Админ-панель';
  }

  // Меню на мобильных
  function closeMenu() { $('#side').classList.remove('is-open'); $('#backdrop').classList.remove('is-open'); }
  $('#menuBtn').addEventListener('click', function () { $('#side').classList.add('is-open'); $('#backdrop').classList.add('is-open'); });
  $('#backdrop').addEventListener('click', closeMenu);

  function pager(total, page, size, onPage) {
    var pages = Math.max(1, Math.ceil(total / size));
    var from = total ? (page - 1) * size + 1 : 0;
    var to = Math.min(page * size, total);
    var el = document.createElement('div');
    el.className = 'pager';
    el.innerHTML = '<span>' + from + '–' + to + ' из ' + fmt.format(total) + '</span>' +
      '<span class="pager__btns">' +
        '<button class="btn btn--sm btn--outline-dark" data-p="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Назад">←</button>' +
        '<button class="btn btn--sm btn--outline-dark" data-p="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + ' aria-label="Вперёд">→</button>' +
      '</span>';
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-p]');
      if (b && !b.disabled) onPage(Number(b.dataset.p));
    });
    return el;
  }

  // Строки таблиц с data-href открываются по клику (ссылки и кнопки внутри работают как обычно).
  content.addEventListener('click', function (e) {
    var row = e.target.closest('tr[data-href]');
    if (!row || e.target.closest('a, button, input, select, textarea, label')) return;
    location.hash = row.dataset.href;
  });

  /* =====================================================================
     Дашборд
     ===================================================================== */

  function delta(cur, prev, isMoney) {
    if (!prev) return cur ? 'в прошлом месяце: 0' : 'в прошлом месяце: —';
    var pct = Math.round((cur - prev) / prev * 100);
    return '<b>' + (pct > 0 ? '+' : '') + pct + '%</b> к прошлому месяцу (' + (isMoney ? money(prev) : fmt.format(prev)) + ')';
  }

  function viewDashboard() {
    setPage('Дашборд', 'Сводка на ' + new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }),
      '<a class="btn btn--sm btn--dark" href="#new-order">+ Новый заказ</a>');
    refreshCounts().then(function (d) {
      var k = d.kpi;
      content.innerHTML =
        '<section class="kpis">' +
          '<div class="kpi kpi--dark"><p class="kpi__label">Выручка за месяц</p><p class="kpi__value">' + money(k.revenueMonth) + '</p><p class="kpi__delta">' + delta(k.revenueMonth, k.revenuePrevMonth, true) + '</p></div>' +
          '<div class="kpi"><p class="kpi__label">Заказов за месяц</p><p class="kpi__value">' + fmt.format(k.ordersMonth) + '</p><p class="kpi__delta">' + delta(k.ordersMonth, k.ordersPrevMonth) + '</p></div>' +
          '<a class="kpi" href="#orders?status=active"><p class="kpi__label">В работе</p><p class="kpi__value">' + fmt.format(k.active) + '</p><p class="kpi__delta">из них в пути: <b>' + fmt.format(k.inTransit) + '</b></p></a>' +
          '<a class="kpi" href="#orders?status=new"><p class="kpi__label">Ждут подтверждения</p><p class="kpi__value">' + fmt.format(k.newOrders) + '</p><p class="kpi__delta">новые заказы</p></a>' +
          '<a class="kpi" href="#leads?status=new"><p class="kpi__label">Заявки с сайта</p><p class="kpi__value">' + fmt.format(k.newLeads) + '</p><p class="kpi__delta">необработанные</p></a>' +
          '<a class="kpi" href="#orders?payment=unpaid"><p class="kpi__label">К оплате</p><p class="kpi__value">' + money(k.unpaid) + '</p><p class="kpi__delta">по неоплаченным заказам</p></a>' +
          '<a class="kpi" href="#clients"><p class="kpi__label">Клиенты</p><p class="kpi__value">' + fmt.format(k.clients) + '</p><p class="kpi__delta"><b>+' + fmt.format(k.clientsMonth) + '</b> за месяц</p></a>' +
        '</section>' +
        '<section class="panel">' +
          '<div class="panel__head"><div><h3 id="chartTitle">Заказы по дням</h3><p class="panel__sub">Последние 30 дней</p></div>' +
            '<div class="seg" role="tablist"><button class="is-active" data-metric="orders" type="button">Заказы</button><button data-metric="revenue" type="button">Выручка</button></div></div>' +
          '<div class="chart" id="chart"></div>' +
          '<details class="chart-table"><summary>Показать таблицей</summary><div id="chartTable"></div></details>' +
        '</section>' +
        '<section class="adm-grid adm-grid--even">' +
          '<div class="panel"><div class="panel__head"><h3>Заказы по статусам</h3><a class="panel__link" href="#orders">Все заказы →</a></div><div class="hbars" id="statusBars"></div></div>' +
          '<div class="panel"><div class="panel__head"><h3>Популярные направления</h3><a class="panel__link" href="#tariffs">Тарифы →</a></div><div class="hbars hbars--routes" id="cityBars"></div></div>' +
        '</section>' +
        '<section class="adm-grid adm-grid--even">' +
          '<div class="panel"><div class="panel__head"><h3>Последние заказы</h3><a class="panel__link" href="#orders">Все →</a></div><div class="mini-list" id="recentOrders"></div></div>' +
          '<div class="panel"><div class="panel__head"><h3>Заявки в работе</h3><a class="panel__link" href="#leads">Все →</a></div><div class="mini-list" id="recentLeads"></div></div>' +
        '</section>';

      var metric = 'orders';
      function drawChart() { barChart($('#chart'), d.daily, metric); }
      drawChart();
      $('.seg').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-metric]');
        if (!b) return;
        metric = b.dataset.metric;
        $$('.seg button').forEach(function (x) { x.classList.toggle('is-active', x === b); });
        $('#chartTitle').textContent = metric === 'orders' ? 'Заказы по дням' : 'Выручка по дням';
        drawChart();
      });
      window.onresize = debounce(function () { if ($('#chart')) drawChart(); }, 150);

      $('#chartTable').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Дата</th><th class="num">Заказы</th><th class="num">Выручка</th></tr></thead><tbody>' +
        d.daily.slice().reverse().map(function (x) {
          return '<tr><td>' + formatDay(x.day) + '</td><td class="num">' + x.orders + '</td><td class="num">' + money(x.revenue) + '</td></tr>';
        }).join('') + '</tbody></table></div>';

      var statuses = T.STATUS_FLOW.concat(['cancelled']);
      var maxS = Math.max.apply(null, statuses.map(function (s) { return d.statuses[s] || 0; }).concat([1]));
      $('#statusBars').innerHTML = statuses.map(function (s) {
        var n = d.statuses[s] || 0;
        return hbar('<a href="#orders?status=' + s + '">' + esc(T.STATUSES[s]) + '</a>', n / maxS, fmt.format(n));
      }).join('');

      var maxC = Math.max.apply(null, d.cities.map(function (c) { return c.orders; }).concat([1]));
      $('#cityBars').innerHTML = d.cities.length ? d.cities.map(function (c) {
        return hbar(esc(c.city) + '<small class="muted">' + money(c.revenue) + '</small>', c.orders / maxC, fmt.format(c.orders));
      }).join('') : '<p class="panel__sub">Пока нет заказов</p>';

      $('#recentOrders').innerHTML = d.recentOrders.length ? d.recentOrders.map(function (o) {
        return '<a href="#order/' + o.id + '"><span><b>' + esc(o.number) + '</b> · ' + esc(o.origin) + ' → ' + esc(o.city) + '<small>' + esc(o.client.name) + ' · ' + esc(o.carModel) + '</small></span>' + badge(o.status) + '</a>';
      }).join('') : '<p class="panel__sub">Заказов пока нет</p>';

      $('#recentLeads').innerHTML = d.recentLeads.length ? d.recentLeads.map(function (l) {
        return '<div><span><b>' + esc(l.name) + '</b> · <a href="' + telHref(l.phone) + '">' + esc(l.phone) + '</a><small>' + esc(l.company || l.route || 'частное лицо') + ' · ' + formatDate(l.createdAt, true) + '</small></span>' +
          '<span class="pill">' + esc(T.LEAD_STATUSES[l.status]) + '</span></div>';
      }).join('') : '<p class="panel__sub">Все заявки обработаны</p>';
    }).catch(handleError);
  }

  function hbar(label, share, value) {
    return '<div class="hbar"><span class="hbar__name">' + label + '</span>' +
      '<span class="hbar__track"><span class="hbar__fill" data-w="' + Math.round(share * 100) + '"></span></span>' +
      '<span class="hbar__value">' + value + '</span></div>';
  }

  // Ширины полос выставляем через CSSOM (CSP не разрешает inline style="").
  new MutationObserver(function () {
    $$('.hbar__fill[data-w]').forEach(function (el) { el.style.width = el.dataset.w + '%'; el.removeAttribute('data-w'); });
  }).observe(content, { childList: true, subtree: true });

  // Одна серия столбцов: 30 дней, ось Y с «круглыми» делениями, подпись максимума, тултип при наведении.
  function barChart(box, days, metric) {
    var W = Math.max(box.clientWidth, 280);
    var H = box.clientWidth < 500 ? 200 : 240;
    var pad = { l: metric === 'revenue' ? 58 : 32, r: 8, t: 22, b: 26 };
    var pw = W - pad.l - pad.r;
    var ph = H - pad.t - pad.b;
    var values = days.map(function (d) { return d[metric]; });
    var max = Math.max.apply(null, values);
    var step = niceStep(max || 1, 4);
    var top = Math.max(step, Math.ceil(max / step) * step);
    var slot = pw / days.length;
    var bw = Math.min(24, Math.max(2, slot - 2));
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (metric === 'orders' ? 'Заказы' : 'Выручка') + ' по дням за 30 дней">';

    for (var v = 0; v <= top + 1e-9; v += step) {
      var y = pad.t + ph - v / top * ph;
      svg += '<line class="grid-line" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y + '" y2="' + y + '"/>';
      svg += '<text class="axis-text" x="' + (pad.l - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + shortNum(v) + '</text>';
    }
    var peak = values.lastIndexOf(max);
    days.forEach(function (d, i) {
      var x = pad.l + i * slot + (slot - bw) / 2;
      var h = d[metric] / top * ph;
      var yb = pad.t + ph;
      svg += '<rect class="bar-hit" data-i="' + i + '" x="' + (pad.l + i * slot) + '" y="' + pad.t + '" width="' + slot + '" height="' + ph + '"/>';
      if (h > 0) {
        var r = Math.min(4, bw / 2, h);
        svg += '<path class="bar" data-bar="' + i + '" d="M' + x + ' ' + yb + 'V' + (yb - h + r) + 'Q' + x + ' ' + (yb - h) + ' ' + (x + r) + ' ' + (yb - h) +
          'H' + (x + bw - r) + 'Q' + (x + bw) + ' ' + (yb - h) + ' ' + (x + bw) + ' ' + (yb - h + r) + 'V' + yb + 'Z"/>';
      }
      var every = W < 600 ? 10 : 5;
      if (i % every === every - 1) {
        svg += '<text class="axis-text" x="' + (x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + formatDay(d.day, true) + '</text>';
      }
      if (i === peak && max > 0) {
        svg += '<text class="peak-label" x="' + (x + bw / 2) + '" y="' + (yb - h - 6) + '" text-anchor="middle">' + shortNum(max) + '</text>';
      }
    });
    box.innerHTML = svg + '</svg>';

    $$('.bar-hit', box).forEach(function (hit) {
      var i = Number(hit.dataset.i);
      var d = days[i];
      hit.addEventListener('mousemove', function (e) {
        $$('.bar.is-hover', box).forEach(function (b) { b.classList.remove('is-hover'); });
        var bar = $('[data-bar="' + i + '"]', box);
        if (bar) bar.classList.add('is-hover');
        showTip(formatDay(d.day) + '<br>Заказы: <b>' + d.orders + '</b> · Выручка: <b>' + money(d.revenue) + '</b>', e.clientX, e.clientY);
      });
      hit.addEventListener('mouseleave', function () {
        hideTip();
        var bar = $('[data-bar="' + i + '"]', box);
        if (bar) bar.classList.remove('is-hover');
      });
    });
  }

  function niceStep(max, ticks) {
    var raw = max / ticks;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / pow;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return Math.max(1, step * pow);
  }

  function shortNum(v) {
    if (v >= 1e6) return fmt.format(Math.round(v / 1e5) / 10) + ' млн';
    if (v >= 1e4) return fmt.format(Math.round(v / 1e3)) + ' тыс';
    return fmt.format(v);
  }

  /* =====================================================================
     Заказы
     ===================================================================== */

  function viewOrders(r) {
    var p = r.params;
    var page = Number(p.page) || 1;
    var statusMap = { active: 'В работе (все этапы)' };
    Object.keys(T.STATUSES).forEach(function (k) { statusMap[k] = T.STATUSES[k]; });
    var qs = new URLSearchParams({ q: p.q || '', status: p.status || '', payment: p.payment || '', from: p.from || '', to: p.to || '', sort: p.sort || '', page: page });

    setPage('Заказы', '', '<a class="btn btn--sm btn--outline-dark" href="/api/admin/orders.csv?' + qs.toString() + '" download>Экспорт в Excel</a>' +
      '<a class="btn btn--sm btn--dark" href="#new-order">+ Новый заказ</a>');

    content.innerHTML =
      '<form class="toolbar" id="filters">' +
        '<input class="field__input" type="search" name="q" placeholder="Номер, клиент, телефон, авто, VIN, город" value="' + esc(p.q || '') + '">' +
        '<select class="select" name="status">' + options(statusMap, p.status, 'Все статусы') + '</select>' +
        '<select class="select" name="payment">' + options(T.PAYMENT_STATUSES, p.payment, 'Любая оплата') + '</select>' +
        '<label class="inline">с <input class="field__input" type="date" name="from" value="' + esc(p.from || '') + '"></label>' +
        '<label class="inline">по <input class="field__input" type="date" name="to" value="' + esc(p.to || '') + '"></label>' +
        '<select class="select" name="sort">' + options({ new: 'Сначала новые', old: 'Сначала старые', price_desc: 'Дороже', price_asc: 'Дешевле' }, p.sort || 'new') + '</select>' +
      '</form>' +
      '<p class="toolbar__summary" id="summary"></p>' +
      '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>Заказ</th><th>Клиент</th><th>Маршрут</th><th>Автомобиль</th><th>Статус</th><th>Оплата</th><th class="num">Цена</th>' +
      '</tr></thead><tbody id="rows"><tr class="empty-row"><td colspan="7">Загрузка…</td></tr></tbody></table></div>' +
      '<div id="pager"></div>';

    var filters = $('#filters');
    function apply(replace) {
      var f = formData(filters);
      f.sort = f.sort === 'new' ? '' : f.sort;
      go(hashFor('orders', f), replace);
    }
    filters.addEventListener('change', function (e) { if (e.target.name !== 'q') apply(); });
    filters.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
    $('input[name="q"]', filters).addEventListener('input', debounce(function () { apply(true); }, 400));
    if (p.q) { var qi = $('input[name="q"]', filters); qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }

    api('GET', '/admin/orders?' + qs.toString()).then(function (res) {
      $('#summary').innerHTML = 'Найдено: <b>' + fmt.format(res.total) + '</b> на сумму <b>' + money(res.sum) + '</b>';
      $('#rows').innerHTML = res.orders.length ? res.orders.map(orderRow).join('') :
        '<tr class="empty-row"><td colspan="7">Ничего не найдено. Измените фильтры или <a href="#new-order">создайте заказ</a>.</td></tr>';
      $('#pager').appendChild(pager(res.total, res.page, res.pageSize, function (n) { p.page = n; go(hashFor('orders', p)); }));
    }).catch(handleError);
  }

  function orderRow(o) {
    return '<tr class="is-link" data-href="#order/' + o.id + '">' +
      '<td class="nowrap"><b>' + esc(o.number) + '</b><small>' + formatDate(o.createdAt) + '</small></td>' +
      '<td class="nowrap">' + esc(o.client.name) + '<small>' + esc(o.client.phone) + '</small></td>' +
      '<td class="nowrap">' + esc(o.origin) + ' → ' + esc(o.city) + '<small>' + (o.eta ? 'ETA ' + formatDay(o.eta, true) : o.days[1] ? o.days[0] + '–' + o.days[1] + ' дн.' : 'срок уточняется') + '</small></td>' +
      '<td>' + esc(o.carModel) + '<small>' + esc(o.carTypeLabel) + '</small></td>' +
      '<td>' + badge(o.status) + '</td>' +
      '<td>' + payPill(o) + '</td>' +
      '<td class="num"><b>' + orderPrice(o) + '</b></td>' +
    '</tr>';
  }

  /* ---------- Карточка заказа ---------- */

  function viewOrder(r) {
    Promise.all([api('GET', '/admin/orders/' + encodeURIComponent(r.id)), loadTariffs()]).then(function (res) {
      renderOrder(res[0].order);
    }).catch(function (err) {
      if (err.status === 404) {
        setPage('Заказ не найден', '<a href="#orders">Заказы</a>');
        content.innerHTML = '<div class="panel empty-state"><h3>Заказ не найден</h3><p>Возможно, он был удалён.</p></div>';
        return;
      }
      handleError(err);
    });
  }

  // Поле города с подсказками: города из тарифов, но можно вписать любой.
  function cityInput(name, value, placeholder) {
    return input(name, value, 'list="routeCities" maxlength="100" required autocomplete="off" placeholder="' + esc(placeholder) + '"');
  }

  function cityDatalist() {
    var names = activeTariffs().cities.map(function (c) { return c.name; }).concat([T.ORIGIN]);
    names = names.filter(function (n, i) { return names.indexOf(n) === i; }).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    return '<datalist id="routeCities">' + names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>';
  }

  // Маршрут из текста заявки, если клиент написал его через стрелку или тире: «Казань → Москва».
  function parseRoute(text) {
    var m = /([А-ЯЁA-Z][А-Яа-яЁёA-Za-z-]*(?:[ -][А-ЯЁA-Z][А-Яа-яЁёA-Za-z-]*)*)\s*(?:→|->|—|–)\s*([А-ЯЁA-Z][А-Яа-яЁёA-Za-z-]*(?:[ -][А-ЯЁA-Z][А-Яа-яЁёA-Za-z-]*)*)/.exec(text || '');
    return m ? { origin: m[1], city: m[2] } : null;
  }

  function orderPrice(o) {
    return o.price ? money(o.price) : '<span class="muted">по запросу</span>';
  }

  function typeSelect(name, selected) {
    var types = state.tariffs.carTypes.filter(function (t) { return t.active || t.key === selected; });
    return '<select class="select" name="' + name + '">' + types.map(function (t) {
      return '<option value="' + esc(t.key) + '"' + (t.key === selected ? ' selected' : '') + '>' + esc(t.label) + (t.active ? '' : ' (отключён)') + '</option>';
    }).join('') + '</select>';
  }

  function optionChecks(selected) {
    var opts = state.tariffs.options.filter(function (o) { return o.active || selected.indexOf(o.key) >= 0; });
    if (!opts.length) return '<p class="field__hint">Опций нет</p>';
    return '<div class="check-list">' + opts.map(function (o) {
      return '<label class="check"><input type="checkbox" data-opt value="' + esc(o.key) + '"' + (selected.indexOf(o.key) >= 0 ? ' checked' : '') + '>' +
        esc(o.label) + '</label>';
    }).join('') + '</div>';
  }

  // { price, km, days, priced } по маршруту формы; priced: false — тарифа на маршрут нет.
  function tariffPrice(root) {
    var opts = $$('[data-opt]:checked', root).map(function (i) { return i.value; });
    return T.routeQuote(activeTariffs(), $('[name=origin]', root).value, $('[name=city]', root).value, $('[name=carType]', root).value, opts);
  }

  function renderOrder(o) {
    var actions = '<a class="btn btn--sm btn--outline-dark" href="#client/' + o.client.id + '">Клиент</a>';
    if (isAdmin()) actions += '<button class="btn btn--sm btn--danger" id="deleteOrder">Удалить</button>';
    setPage('Заказ ' + o.number, '<a href="#orders">Заказы</a> / ' + esc(o.number) + ' · создан ' + formatDate(o.createdAt, true), actions);

    var events = o.events.map(function (ev) {
      return '<li><b>' + esc(T.STATUSES[ev.status] || ev.status) + '</b><time>' + formatDate(ev.createdAt, true) + '</time>' +
        (ev.note ? '<p>' + esc(ev.note) + '</p>' : '') + '</li>';
    }).join('');

    content.innerHTML =
      '<div class="adm-grid adm-grid--detail">' +
        '<form class="panel" id="orderForm" novalidate>' +
          '<div class="form-section"><h4>Маршрут и автомобиль</h4><div class="form-grid">' +
            field('Откуда', cityInput('origin', o.origin, 'Город отправления')) +
            field('Куда', cityInput('city', o.city, 'Город назначения')) +
            field('Марка и модель', input('carModel', o.carModel, 'maxlength="120" required')) +
            field('Тип', typeSelect('carType', o.carType)) +
            field('VIN', input('vin', o.vin, 'maxlength="17" autocapitalize="characters"')) +
            field('Где забрать', input('pickupAddress', o.pickupAddress, 'maxlength="300"')) +
            field('Опции', optionChecks(o.options), 'span-all') +
            field('Комментарий клиента', textarea('comment', o.comment, 'maxlength="1000" rows="2"'), 'span-all') +
          '</div></div>' +
          '<div class="form-section"><h4>Цена и оплата</h4><div class="form-grid">' +
            field('Цена, ₽', '<div class="price-row">' + input('price', o.price, 'type="number" min="0" step="500"') +
              '<button type="button" class="btn btn--sm btn--outline-dark" id="byTariff">По тарифу</button></div>', '',
              o.km ? 'Расстояние ' + fmt.format(o.km) + ' км, срок ' + o.days[0] + '–' + o.days[1] + ' дн.' : 'На этот маршрут нет тарифа — цену и дату прибытия укажите вручную') +
            field('Статус оплаты', '<select class="select" name="paymentStatus">' + options(T.PAYMENT_STATUSES, o.paymentStatus) + '</select>') +
            field('Оплачено, ₽', input('paidAmount', o.paidAmount, 'type="number" min="0" step="500"')) +
            field('Остаток', '<div class="field__static" id="rest"></div>') +
          '</div></div>' +
          '<div class="form-section"><h4>Логистика</h4><div class="form-grid">' +
            field('Дата прибытия (ETA)', input('eta', o.eta, 'type="date"'), '', 'Клиент видит эту дату в кабинете') +
            field('Автовоз', input('truck', o.truck, 'maxlength="100" placeholder="Госномер или название"')) +
            field('Водитель', input('driver', o.driver, 'maxlength="200" placeholder="Имя и телефон"'), 'span-2') +
            field('Заметка менеджера', textarea('managerNote', o.managerNote, 'maxlength="2000" rows="3" placeholder="Видят только сотрудники"'), 'span-all') +
          '</div></div>' +
          '<div class="form-actions"><button type="submit" class="btn btn--dark">Сохранить изменения</button><p class="form-status" role="status"></p></div>' +
          cityDatalist() +
        '</form>' +
        '<div>' +
          '<form class="panel" id="statusForm">' +
            '<div class="panel__head"><h3>Статус</h3>' + badge(o.status) + '</div>' +
            '<div class="acc-form acc-form--light">' +
              '<select class="select" name="status">' + options(T.STATUSES, o.status) + '</select>' +
              '<textarea class="field__input" name="note" rows="2" maxlength="500" placeholder="Комментарий для клиента — появится в истории"></textarea>' +
              '<button type="submit" class="btn btn--dark">Обновить статус</button>' +
              '<p class="form-status" role="status"></p>' +
            '</div>' +
          '</form>' +
          '<div class="panel"><div class="panel__head"><h3>Клиент</h3><a class="panel__link" href="#client/' + o.client.id + '">Карточка →</a></div><dl class="kv">' +
            '<div><dt>Имя</dt><dd>' + esc(o.client.name) + '</dd></div>' +
            '<div><dt>Телефон</dt><dd><a href="' + telHref(o.client.phone) + '">' + esc(o.client.phone) + '</a></dd></div>' +
            '<div><dt>Email</dt><dd>' + (o.client.email ? '<a href="mailto:' + esc(o.client.email) + '">' + esc(o.client.email) + '</a>' : '—') + '</dd></div>' +
          '</dl></div>' +
          '<div class="panel"><h3>История</h3><ol class="timeline">' + events + '</ol></div>' +
        '</div>' +
      '</div>';

    var form = $('#orderForm');
    function updateRest() {
      var rest = Number($('[name=price]', form).value || 0) - Number($('[name=paidAmount]', form).value || 0);
      $('#rest').textContent = money(Math.max(rest, 0));
    }
    updateRest();
    form.addEventListener('input', function () { state.dirty = true; updateRest(); });
    form.addEventListener('change', function () { state.dirty = true; });

    $('#byTariff').addEventListener('click', function () {
      var q = tariffPrice(form);
      if (!q || !q.priced) return toast('На этот маршрут нет тарифа — укажите цену вручную');
      $('[name=price]', form).value = q.price;
      state.dirty = true;
      updateRest();
      toast('Цена по тарифу: ' + money(q.price));
    });

    $('[name=paymentStatus]', form).addEventListener('change', function () {
      if (this.value === 'paid') $('[name=paidAmount]', form).value = $('[name=price]', form).value;
      if (this.value === 'unpaid') $('[name=paidAmount]', form).value = 0;
      updateRest();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = formData(form);
      var body = {
        origin: f.origin, city: f.city, carType: f.carType, carModel: f.carModel, vin: f.vin.trim().toUpperCase(),
        pickupAddress: f.pickupAddress, comment: f.comment,
        options: $$('[data-opt]:checked', form).map(function (i) { return i.value; }),
        price: Number(f.price), paymentStatus: f.paymentStatus, paidAmount: Number(f.paidAmount || 0),
        eta: f.eta, truck: f.truck, driver: f.driver, managerNote: f.managerNote
      };
      var st = $('.form-actions .form-status', form);
      setStatus(st, 'Сохраняем…');
      api('PATCH', '/admin/orders/' + o.id, body).then(function (res) {
        state.dirty = false;
        renderOrder(res.order);
        toast('Заказ сохранён');
      }).catch(function (err) { setStatus(st, err.message, 'error'); if (err.status === 401) handleError(err); });
    });

    $('#statusForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = formData(this);
      var st = $('.form-status', this);
      if (state.dirty && !window.confirm('В форме заказа есть несохранённые изменения — они пропадут. Продолжить?')) return;
      api('POST', '/admin/orders/' + o.id + '/status', { status: f.status, note: f.note }).then(function (res) {
        state.dirty = false;
        renderOrder(res.order);
        refreshCounts().catch(function () {});
        toast('Статус: ' + T.STATUSES[res.order.status]);
      }).catch(function (err) { setStatus(st, err.message, 'error'); });
    });

    var del = $('#deleteOrder');
    if (del) {
      del.addEventListener('click', function () {
        confirmDialog('Удалить заказ ' + o.number + '?', 'Заказ и его история будут удалены без возможности восстановления. Действие попадёт в журнал.')
          .then(function (ok) {
            if (!ok) return;
            api('DELETE', '/admin/orders/' + o.id).then(function () {
              state.dirty = false;
              toast('Заказ удалён');
              go('#orders');
            }).catch(handleError);
          });
      });
    }
  }

  /* ---------- Новый заказ ---------- */

  function viewNewOrder(r) {
    setPage('Новый заказ', '<a href="#orders">Заказы</a> / новый');
    var lead = state.pendingLead && String(state.pendingLead.id) === r.params.lead ? state.pendingLead : null;
    var clientReq = r.params.client ? api('GET', '/admin/clients/' + encodeURIComponent(r.params.client)).then(function (x) { return x.client; }, function () { return null; }) : Promise.resolve(null);

    Promise.all([loadTariffs(), clientReq]).then(function (res) {
      var t = activeTariffs();
      var picked = res[1];
      var guess = lead ? parseRoute(lead.message) || parseRoute(lead.route) || {} : {};
      var leadNote = lead ? ['Из заявки с сайта', lead.company, lead.message, lead.route, lead.estimate ? 'оценка ' + lead.estimate : '']
        .filter(Boolean).join('. ') : '';

      content.innerHTML =
        '<form class="adm-grid adm-grid--detail" id="newOrder" novalidate>' +
          '<div class="panel">' +
            '<div class="form-section"><h4>Клиент</h4><div id="clientBox"></div></div>' +
            '<div class="form-section"><h4>Маршрут и автомобиль</h4><div class="form-grid">' +
              field('Откуда', cityInput('origin', guess.origin || '', 'Город отправления')) +
              field('Куда', cityInput('city', guess.city || '', 'Город назначения')) +
              field('Тип', typeSelect('carType', t.carTypes[0].key)) +
              field('Марка и модель', input('carModel', '', 'maxlength="120" required placeholder="Toyota Camry, 2023"')) +
              field('VIN', input('vin', '', 'maxlength="17"')) +
              field('Где забрать', input('pickupAddress', '', 'maxlength="300" placeholder="Порт, СВХ, адрес"'), 'span-all') +
              field('Опции', optionChecks([]), 'span-all') +
              field('Комментарий клиента', textarea('comment', '', 'maxlength="1000" rows="2"'), 'span-all') +
              field('Заметка менеджера', textarea('managerNote', leadNote, 'maxlength="2000" rows="2"'), 'span-all') +
            '</div></div>' +
            cityDatalist() +
          '</div>' +
          '<aside class="calc__result">' +
            '<p class="calc__label" id="nLabel">Цена</p>' +
            '<p class="calc__price" id="nPrice">—</p>' +
            '<p class="calc__hint" id="nHint">Укажите маршрут</p>' +
            '<dl class="calc__details"><div><dt>Срок</dt><dd id="nDays">—</dd></div><div><dt>Расстояние</dt><dd id="nKm">—</dd></div></dl>' +
            '<div class="quote-extra"><div class="field"><label class="calc__label" for="nManual">Своя цена, ₽</label>' +
              '<input class="field__input" id="nManual" name="price" type="number" min="0" step="500" placeholder="Оставьте пустым — по тарифу"></div>' +
            '<div class="field"><label class="calc__label" for="nEta">Дата прибытия (ETA)</label><input class="field__input" id="nEta" name="eta" type="date"></div></div>' +
            '<button type="submit" class="btn btn--dark btn--block">Создать заказ <span class="arrow">→</span></button>' +
            '<p class="form-status" role="status"></p>' +
          '</aside>' +
        '</form>';

      var form = $('#newOrder');
      var chosen = picked;
      var mode = picked ? 'picked' : (lead ? 'new' : 'search');

      function renderClientBox() {
        var box = $('#clientBox');
        if (mode === 'picked') {
          box.innerHTML = '<div class="picked"><span><b>' + esc(chosen.name) + '</b><small>' + esc(chosen.phone) + (chosen.email ? ' · ' + esc(chosen.email) : '') + '</small></span>' +
            '<button type="button" class="btn btn--sm btn--outline-dark" data-mode="search">Изменить</button></div>';
        } else if (mode === 'search') {
          box.innerHTML = '<div class="picker"><input class="field__input" type="search" id="clientSearch" placeholder="Найти клиента: имя, телефон или email" autocomplete="off">' +
            '<div class="picker__list" id="clientList" hidden></div></div>' +
            '<p class="field__hint">Нет в базе? <button type="button" class="btn-link" data-mode="new">Создать нового клиента</button></p>';
          var si = $('#clientSearch');
          si.addEventListener('input', debounce(function () {
            var q = si.value.trim();
            var list = $('#clientList');
            if (q.length < 2) { list.hidden = true; return; }
            api('GET', '/admin/clients?q=' + encodeURIComponent(q)).then(function (res) {
              list.hidden = false;
              list.innerHTML = res.clients.length ? res.clients.slice(0, 8).map(function (c, i) {
                return '<button type="button" data-pick="' + i + '"><b>' + esc(c.name) + '</b><small>' + esc(c.phone) + (c.email ? ' · ' + esc(c.email) : '') + ' · заказов: ' + c.ordersCount + '</small></button>';
              }).join('') : '<button type="button" data-mode="new">Не найдено — создать нового клиента</button>';
              $$('[data-pick]', list).forEach(function (b) {
                b.addEventListener('click', function () { chosen = res.clients[Number(b.dataset.pick)]; mode = 'picked'; renderClientBox(); });
              });
            }).catch(handleError);
          }, 300));
          si.focus();
        } else {
          box.innerHTML = '<div class="form-grid">' +
            field('Имя', input('clientName', lead ? lead.name : '', 'maxlength="100" required')) +
            field('Телефон', input('clientPhone', lead ? lead.phone : '', 'type="tel" data-phone required')) +
            field('Email', input('clientEmail', lead ? lead.email : '', 'type="email" maxlength="200"'), 'span-all', 'Необязательно. Нужен, чтобы клиент мог войти в кабинет') +
          '</div><p class="field__hint"><button type="button" class="btn-link" data-mode="search">Выбрать из существующих</button></p>';
        }
      }
      $('#clientBox').addEventListener('click', function (e) {
        var b = e.target.closest('[data-mode]');
        if (b) { mode = b.dataset.mode; renderClientBox(); }
      });
      renderClientBox();

      function recalc() {
        var q = tariffPrice(form);
        var priced = q && q.priced;
        var filled = $('[name=origin]', form).value.trim() && $('[name=city]', form).value.trim();
        var manual = $('#nManual').value.trim();
        // Крупная цифра — итоговая цена заказа: своя цена важнее тарифа.
        $('#nLabel').textContent = manual ? 'Своя цена' : priced ? 'Цена по тарифу' : 'Цена';
        $('#nPrice').textContent = manual ? money(Number(manual)) : priced ? money(q.price) : '—';
        $('#nDays').textContent = priced ? q.days[0] + '–' + q.days[1] + ' дн.' : '—';
        $('#nKm').textContent = priced ? fmt.format(q.km) + ' км' : '—';
        $('#nHint').textContent = priced ? (manual ? 'По тарифу: ' + money(q.price) : 'Тариф ' + T.ORIGIN + ' ↔ город назначения')
          : filled ? (manual ? 'Тарифа на маршрут нет — цена указана вручную' : 'Тарифа на маршрут нет — укажите свою цену') : 'Укажите маршрут';
      }
      form.addEventListener('change', recalc);
      form.addEventListener('input', debounce(recalc, 200));
      recalc();

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var f = formData(form);
        var st = $('aside .form-status', form);
        var body = {
          origin: f.origin, city: f.city, carType: f.carType, carModel: f.carModel, vin: f.vin.trim().toUpperCase(),
          pickupAddress: f.pickupAddress, comment: f.comment, managerNote: f.managerNote, eta: f.eta,
          options: $$('[data-opt]:checked', form).map(function (i) { return i.value; })
        };
        if (f.price !== '') body.price = Number(f.price);
        if (lead) body.leadId = lead.id;
        if (mode === 'picked') body.clientId = chosen.id;
        else if (mode === 'new') body.client = { name: f.clientName, phone: f.clientPhone, email: f.clientEmail };
        else return setStatus(st, 'Выберите клиента или создайте нового', 'error');
        if (!f.origin.trim() || !f.city.trim()) return setStatus(st, 'Укажите, откуда и куда везём', 'error');
        if (!f.carModel.trim()) return setStatus(st, 'Укажите марку и модель', 'error');

        setStatus(st, 'Создаём…');
        api('POST', '/admin/orders', body).then(function (res) {
          state.pendingLead = null;
          toast('Заказ ' + res.order.number + ' создан');
          refreshCounts().catch(function () {});
          go('#order/' + res.order.id);
        }).catch(function (err) { setStatus(st, err.message, 'error'); });
      });
    }).catch(handleError);
  }

  /* =====================================================================
     Заявки с сайта
     ===================================================================== */

  function viewLeads(r) {
    var p = r.params;
    var page = Number(p.page) || 1;
    setPage('Заявки с сайта', 'Заявки на сотрудничество из формы на главной странице');
    content.innerHTML =
      '<form class="toolbar" id="filters">' +
        '<input class="field__input" type="search" name="q" placeholder="Имя, компания, телефон, email, задача" value="' + esc(p.q || '') + '">' +
        '<select class="select" name="status">' + options(T.LEAD_STATUSES, p.status, 'Все статусы') + '</select>' +
      '</form>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Получена</th><th>Контакт</th><th>Компания и задача</th><th>Статус</th><th>Комментарий</th><th></th></tr></thead>' +
      '<tbody id="rows"><tr class="empty-row"><td colspan="6">Загрузка…</td></tr></tbody></table></div><div id="pager"></div>';

    var filters = $('#filters');
    function apply(replace) { go(hashFor('leads', formData(filters)), replace); }
    filters.addEventListener('change', function (e) { if (e.target.name !== 'q') apply(); });
    filters.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
    $('input[name="q"]', filters).addEventListener('input', debounce(function () { apply(true); }, 400));
    if (p.q) { var qi = $('input[name="q"]', filters); qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }

    var qs = new URLSearchParams({ q: p.q || '', status: p.status || '', page: page });
    api('GET', '/admin/leads?' + qs.toString()).then(function (res) {
      var byId = {};
      res.leads.forEach(function (l) { byId[l.id] = l; });
      $('#rows').innerHTML = res.leads.length ? res.leads.map(function (l) {
        return '<tr data-id="' + l.id + '">' +
          '<td class="nowrap">' + formatDate(l.createdAt, true) + '</td>' +
          '<td class="nowrap"><b>' + esc(l.name) + '</b><small><a href="' + telHref(l.phone) + '">' + esc(l.phone) + '</a></small>' +
            (l.email ? '<small><a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a></small>' : '') + '</td>' +
          '<td class="lead-task">' + (l.company ? '<b>' + esc(l.company) + '</b>' : '<span class="muted">Без компании</span>') +
            '<small>' + esc([l.message, l.route, l.estimate].filter(Boolean).join(' · ') || '—') + '</small></td>' +
          '<td><select class="select lead-status lead-status--' + esc(l.status) + '" data-status>' + options(T.LEAD_STATUSES, l.status) + '</select></td>' +
          '<td>' + (l.note ? esc(l.note) : '<span class="muted">—</span>') + ' <button class="btn-link" data-note>изменить</button></td>' +
          '<td class="nowrap"><button class="btn btn--sm btn--dark" data-order title="Оформить заказ по заявке">В заказ</button>' +
            (isAdmin() ? ' <button class="adm-icon-btn" data-del title="Удалить" aria-label="Удалить"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : '') +
          '</td></tr>';
      }).join('') : '<tr class="empty-row"><td colspan="6">Заявок не найдено</td></tr>';
      $('#pager').appendChild(pager(res.total, res.page, res.pageSize, function (n) { p.page = n; go(hashFor('leads', p)); }));

      $('#rows').addEventListener('change', function (e) {
        var sel = e.target.closest('[data-status]');
        if (!sel) return;
        var id = sel.closest('tr').dataset.id;
        api('PATCH', '/admin/leads/' + id, { status: sel.value }).then(function (x) {
          byId[id] = x.lead;
          sel.className = 'select lead-status lead-status--' + x.lead.status;
          refreshCounts().catch(function () {});
          toast('Статус заявки: ' + T.LEAD_STATUSES[x.lead.status]);
        }).catch(handleError);
      });
      $('#rows').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        var lead = byId[tr.dataset.id];
        if (e.target.closest('[data-order]')) {
          state.pendingLead = lead;
          go('#new-order?lead=' + lead.id);
        } else if (e.target.closest('[data-note]')) {
          openDialog({
            title: 'Комментарий к заявке', body: field('Комментарий', textarea('note', lead.note, 'maxlength="1000" rows="4"')),
            onSubmit: function (root) {
              return api('PATCH', '/admin/leads/' + lead.id, { note: $('[name=note]', root).value }).then(function () { route(); });
            }
          });
        } else if (e.target.closest('[data-del]')) {
          confirmDialog('Удалить заявку?', [lead.company, lead.name, lead.phone].filter(Boolean).join(', ')).then(function (ok) {
            if (ok) api('DELETE', '/admin/leads/' + lead.id).then(function () { toast('Заявка удалена'); route(); refreshCounts().catch(function () {}); }).catch(handleError);
          });
        }
      });
    }).catch(handleError);
  }

  /* =====================================================================
     Клиенты
     ===================================================================== */

  function viewClients(r) {
    var p = r.params;
    var page = Number(p.page) || 1;
    setPage('Клиенты', '', '<button class="btn btn--sm btn--dark" id="addClient">+ Клиент</button>');
    content.innerHTML =
      '<form class="toolbar" id="filters">' +
        '<input class="field__input" type="search" name="q" placeholder="Имя, телефон или email" value="' + esc(p.q || '') + '">' +
        '<label class="check"><input type="checkbox" name="blocked"' + (p.blocked === '1' ? ' checked' : '') + '> Только заблокированные</label>' +
      '</form>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Клиент</th><th>Телефон</th><th class="num">Заказов</th><th class="num">На сумму</th><th>Последний заказ</th><th>Доступ</th></tr></thead>' +
      '<tbody id="rows"><tr class="empty-row"><td colspan="6">Загрузка…</td></tr></tbody></table></div><div id="pager"></div>';

    var filters = $('#filters');
    function apply(replace) {
      var f = formData(filters);
      go(hashFor('clients', { q: f.q, blocked: f.blocked ? '1' : '' }), replace);
    }
    filters.addEventListener('change', function (e) { if (e.target.name !== 'q') apply(); });
    filters.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
    $('input[name="q"]', filters).addEventListener('input', debounce(function () { apply(true); }, 400));
    if (p.q) { var qi = $('input[name="q"]', filters); qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }

    $('#addClient').addEventListener('click', function () {
      openDialog({
        title: 'Новый клиент',
        body: field('Имя', input('name', '', 'maxlength="100" required')) +
          field('Телефон', input('phone', '', 'type="tel" data-phone required')) +
          field('Email', input('email', '', 'type="email"'), '', 'Необязательно. Нужен для входа в кабинет'),
        ok: 'Создать',
        onSubmit: function (root) {
          return api('POST', '/admin/clients', formData(root)).then(function (res) {
            toast('Клиент создан');
            go('#client/' + res.client.id);
          });
        }
      });
    });

    var qs = new URLSearchParams({ q: p.q || '', blocked: p.blocked || '', page: page });
    api('GET', '/admin/clients?' + qs.toString()).then(function (res) {
      $('#rows').innerHTML = res.clients.length ? res.clients.map(function (c) {
        return '<tr class="is-link" data-href="#client/' + c.id + '">' +
          '<td><b>' + esc(c.name) + '</b><small>' + esc(c.email || 'без email') + '</small></td>' +
          '<td class="nowrap">' + esc(c.phone) + '</td>' +
          '<td class="num">' + c.ordersCount + '</td>' +
          '<td class="num">' + money(c.ordersSum) + '</td>' +
          '<td class="nowrap">' + formatDate(c.lastOrder) + '</td>' +
          '<td>' + clientAccess(c) + '</td>' +
        '</tr>';
      }).join('') : '<tr class="empty-row"><td colspan="6">Клиентов не найдено</td></tr>';
      $('#pager').appendChild(pager(res.total, res.page, res.pageSize, function (n) { p.page = n; go(hashFor('clients', p)); }));
    }).catch(handleError);
  }

  function clientAccess(c) {
    if (c.blocked) return '<span class="pill pill--blocked">Заблокирован</span>';
    if (!c.hasPassword) return '<span class="pill pill--unpaid">Без пароля</span>';
    return '<span class="pill pill--prepaid">Есть кабинет</span>';
  }

  function viewClient(r) {
    api('GET', '/admin/clients/' + encodeURIComponent(r.id)).then(function (res) {
      var c = res.client;
      setPage(c.name, '<a href="#clients">Клиенты</a> / ' + esc(c.name) + ' · с ' + formatDate(c.createdAt),
        '<a class="btn btn--sm btn--dark" href="#new-order?client=' + c.id + '">+ Заказ для клиента</a>');
      var total = res.orders.filter(function (o) { return o.status !== 'cancelled'; }).reduce(function (s, o) { return s + o.price; }, 0);

      content.innerHTML =
        '<section class="kpis">' +
          '<div class="kpi"><p class="kpi__label">Заказов</p><p class="kpi__value">' + res.orders.length + '</p></div>' +
          '<div class="kpi"><p class="kpi__label">На сумму</p><p class="kpi__value">' + money(total) + '</p></div>' +
          '<div class="kpi"><p class="kpi__label">Доступ в кабинет</p><p class="kpi__value">' + clientAccess(c) + '</p></div>' +
        '</section>' +
          '<div class="panel"><div class="panel__head"><h3>Заказы клиента</h3></div>' +
            '<div class="table-wrap"><table class="table"><thead><tr><th>Заказ</th><th>Маршрут</th><th>Автомобиль</th><th>Статус</th><th>Оплата</th><th class="num">Цена</th></tr></thead><tbody>' +
            (res.orders.length ? res.orders.map(function (o) {
              return '<tr class="is-link" data-href="#order/' + o.id + '"><td class="nowrap"><b>' + esc(o.number) + '</b><small>' + formatDate(o.createdAt) + '</small></td>' +
                '<td>' + esc(o.origin) + ' → ' + esc(o.city) + '</td><td>' + esc(o.carModel) + '</td><td>' + badge(o.status) + '</td><td>' + payPill(o) + '</td><td class="num">' + orderPrice(o) + '</td></tr>';
            }).join('') : '<tr class="empty-row"><td colspan="6">Заказов пока нет</td></tr>') +
            '</tbody></table></div></div>' +
          '<div class="adm-grid adm-grid--three">' +
            '<form class="panel" id="clientForm" novalidate><h3>Данные клиента</h3><div class="acc-form acc-form--light">' +
              field('Имя', input('name', c.name, 'maxlength="100" required')) +
              field('Телефон', input('phone', c.phone, 'type="tel" data-phone required')) +
              field('Email', input('email', c.email || '', 'type="email"')) +
              field('Заметка', textarea('note', c.note, 'maxlength="2000" rows="3" placeholder="Видят только сотрудники"')) +
              '<button type="submit" class="btn btn--dark">Сохранить</button><p class="form-status" role="status"></p>' +
            '</div></form>' +
            '<form class="panel" id="passForm" novalidate><h3>Пароль от кабинета</h3><div class="acc-form acc-form--light">' +
              '<p class="panel__sub">' + (c.hasPassword ? 'Новый пароль заменит старый, все сессии клиента завершатся.' : 'У клиента ещё нет пароля. Задайте его и сообщите клиенту — он сможет входить по email.') + '</p>' +
              input('password', '', 'type="text" minlength="8" autocomplete="off" placeholder="Новый пароль, от 8 символов"') +
              '<button type="button" class="btn-link adm-gen" id="genPass">Сгенерировать надёжный пароль</button>' +
              '<button type="submit" class="btn btn--outline-dark">Задать пароль</button><p class="form-status" role="status"></p>' +
            '</div></form>' +
            '<div class="panel ' + (c.blocked ? '' : 'danger-zone') + '"><h3>' + (c.blocked ? 'Клиент заблокирован' : 'Блокировка') + '</h3>' +
              '<p class="panel__sub">' + (c.blocked ? 'Клиент не может войти в кабинет.' : 'Клиент не сможет войти в кабинет, текущие сессии завершатся. Заказы сохранятся.') + '</p>' +
              '<button class="btn ' + (c.blocked ? 'btn--dark' : 'btn--danger') + ' panel__action" id="blockBtn">' + (c.blocked ? 'Разблокировать' : 'Заблокировать') + '</button></div>' +
          '</div>';

      $('#clientForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var st = $('.form-status', this);
        api('PATCH', '/admin/clients/' + c.id, formData(this)).then(function () { toast('Сохранено'); route(); })
          .catch(function (err) { setStatus(st, err.message, 'error'); });
      });
      $('#genPass').addEventListener('click', function () {
        var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        var arr = new Uint32Array(10);
        crypto.getRandomValues(arr);
        $('#passForm [name=password]').value = Array.prototype.map.call(arr, function (n) { return chars[n % chars.length]; }).join('');
      });
      $('#passForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var st = $('.form-status', this);
        var pass = $('[name=password]', this).value;
        api('POST', '/admin/clients/' + c.id + '/password', { password: pass }).then(function () {
          setStatus(st, 'Пароль задан. Сообщите его клиенту: ' + pass, 'ok');
        }).catch(function (err) { setStatus(st, err.message, 'error'); });
      });
      $('#blockBtn').addEventListener('click', function () {
        var run = function () {
          api('PATCH', '/admin/clients/' + c.id, { blocked: !c.blocked }).then(function () {
            toast(c.blocked ? 'Клиент разблокирован' : 'Клиент заблокирован');
            route();
          }).catch(handleError);
        };
        if (c.blocked) run();
        else confirmDialog('Заблокировать клиента?', c.name + ' не сможет войти в личный кабинет.', 'Заблокировать').then(function (ok) { if (ok) run(); });
      });
    }).catch(function (err) {
      if (err.status === 404) {
        setPage('Клиент не найден', '<a href="#clients">Клиенты</a>');
        content.innerHTML = '<div class="panel empty-state"><h3>Клиент не найден</h3></div>';
        return;
      }
      handleError(err);
    });
  }

  /* =====================================================================
     Сотрудники
     ===================================================================== */

  function viewStaff() {
    setPage('Сотрудники', 'Менеджеры работают с заказами, заявками и клиентами. Администраторы — ещё и с тарифами, настройками и сотрудниками.',
      '<button class="btn btn--sm btn--dark" id="addStaff">+ Сотрудник</button>');
    var roles = { manager: T.ROLES.manager, admin: T.ROLES.admin };

    api('GET', '/admin/staff').then(function (res) {
      var byId = {};
      res.staff.forEach(function (s) { byId[s.id] = s; });
      content.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Сотрудник</th><th>Телефон</th><th>Роль</th><th>Статус</th><th>Добавлен</th><th></th></tr></thead><tbody>' +
        res.staff.map(function (s) {
          var me = s.id === state.user.id;
          return '<tr data-id="' + s.id + '"><td><b>' + esc(s.name) + (me ? ' <span class="muted">(вы)</span>' : '') + '</b><small>' + esc(s.email) + '</small></td>' +
            '<td>' + esc(s.phone || '—') + '</td>' +
            '<td><span class="pill pill--' + s.role + '">' + esc(T.ROLES[s.role]) + '</span></td>' +
            '<td>' + (s.blocked ? '<span class="pill pill--blocked">Заблокирован</span>' : '<span class="pill">Активен</span>') + '</td>' +
            '<td class="nowrap">' + formatDate(s.createdAt) + '</td>' +
            '<td><button class="btn btn--sm btn--outline-dark" data-edit>Изменить</button></td></tr>';
        }).join('') + '</tbody></table></div>';

      content.onclick = function (e) {
        var b = e.target.closest('[data-edit]');
        if (!b) return;
        var s = byId[b.closest('tr').dataset.id];
        var me = s.id === state.user.id;
        openDialog({
          title: s.name,
          body: field('Имя', input('name', s.name, 'maxlength="100" required')) +
            field('Телефон', input('phone', s.phone, 'type="tel" data-phone')) +
            field('Роль', '<select class="select" name="role"' + (me ? ' disabled' : '') + '>' + options(roles, s.role) + '</select>', '', me ? 'Свою роль изменить нельзя' : '') +
            field('Новый пароль', input('password', '', 'type="text" minlength="8" autocomplete="off" placeholder="Оставьте пустым, чтобы не менять"')) +
            (me ? '' : '<label class="check"><input type="checkbox" name="blocked"' + (s.blocked ? ' checked' : '') + '> Заблокирован (не может войти)</label>'),
          onSubmit: function (root) {
            var f = formData(root);
            var body = { name: f.name, phone: f.phone };
            if (!me) { body.role = f.role; body.blocked = f.blocked; }
            if (f.password) body.password = f.password;
            return api('PATCH', '/admin/staff/' + s.id, body).then(function () { toast('Сохранено'); route(); });
          }
        });
      };
    }).catch(handleError);

    $('#addStaff').addEventListener('click', function () {
      openDialog({
        title: 'Новый сотрудник',
        body: field('Имя', input('name', '', 'maxlength="100" required')) +
          field('Email (логин)', input('email', '', 'type="email" required')) +
          field('Телефон', input('phone', '', 'type="tel" data-phone')) +
          field('Роль', '<select class="select" name="role">' + options(roles, 'manager') + '</select>') +
          field('Пароль', input('password', '', 'type="text" minlength="8" autocomplete="off" required'), '', 'Минимум 8 символов. Сообщите его сотруднику'),
        ok: 'Добавить',
        onSubmit: function (root) {
          return api('POST', '/admin/staff', formData(root)).then(function () { toast('Сотрудник добавлен'); route(); });
        }
      });
    });
  }

  /* =====================================================================
     Тарифы
     ===================================================================== */

  function viewTariffs() {
    setPage('Тарифы', 'Цены по направлениям между городом ' + T.ORIGIN + ' и городами списка (в обе стороны). Для остальных маршрутов цену назначает менеджер.');
    loadTariffs(true).then(function (t) {
      var data = JSON.parse(JSON.stringify(t));
      state.dirty = false;

      function render() {
        content.innerHTML =
          '<section class="panel"><div class="panel__head"><div><h3>Города</h3><p class="panel__sub">Базовая цена — седан на открытом автовозе</p></div>' +
            '<div class="toolbar"><button type="button" class="btn btn--sm btn--outline-dark" data-sort>По алфавиту</button><button type="button" class="btn btn--sm btn--dark" data-add="cities">+ Город</button></div></div>' +
            '<div class="table-wrap"><table class="table edit-table"><thead><tr><th>Город</th><th class="col-num num">Км</th><th class="col-sm num">Дней от</th><th class="col-sm num">до</th><th class="col-num num">Цена, ₽</th><th class="col-act">Вкл.</th><th class="col-act"></th></tr></thead><tbody>' +
            data.cities.map(function (c, i) {
              return '<tr' + (c.active ? '' : ' class="is-off"') + '>' +
                cell('cities', i, 'name', c.name, 'text') + cell('cities', i, 'km', c.km, 'number') +
                cell('cities', i, 'd0', c.days[0], 'number') + cell('cities', i, 'd1', c.days[1], 'number') +
                cell('cities', i, 'price', c.price, 'number', 'step="500"') + activeCell('cities', i, c.active) + delCell('cities', i) + '</tr>';
            }).join('') + '</tbody></table></div></section>' +

          '<section class="adm-grid adm-grid--even">' +
            '<div class="panel"><div class="panel__head"><div><h3>Типы автомобилей</h3><p class="panel__sub">Коэффициент к базовой цене: 1,15 = +15%</p></div>' +
              '<button type="button" class="btn btn--sm btn--dark" data-add="carTypes">+ Тип</button></div>' +
              '<div class="table-wrap"><table class="table edit-table"><thead><tr><th>Название</th><th class="col-sm num">Коэф.</th><th class="col-act">Вкл.</th><th class="col-act"></th></tr></thead><tbody>' +
              data.carTypes.map(function (x, i) {
                return '<tr' + (x.active ? '' : ' class="is-off"') + '>' + cell('carTypes', i, 'label', x.label, 'text') +
                  cell('carTypes', i, 'k', x.k, 'number', 'step="0.05" min="0.1"') + activeCell('carTypes', i, x.active) + delCell('carTypes', i) + '</tr>';
              }).join('') + '</tbody></table></div></div>' +
            '<div class="panel"><div class="panel__head"><div><h3>Дополнительные опции</h3><p class="panel__sub">Наценка в % от цены и/или фиксированная доплата</p></div>' +
              '<button type="button" class="btn btn--sm btn--dark" data-add="options">+ Опция</button></div>' +
              '<div class="table-wrap"><table class="table edit-table"><thead><tr><th>Название и подсказка</th><th class="col-sm num">%</th><th class="col-num num">₽</th><th class="col-act">Вкл.</th><th class="col-act"></th></tr></thead><tbody>' +
              data.options.map(function (x, i) {
                return '<tr' + (x.active ? '' : ' class="is-off"') + '><td>' +
                  '<input data-list="options" data-i="' + i + '" data-f="label" value="' + esc(x.label) + '" aria-label="Название">' +
                  '<input data-list="options" data-i="' + i + '" data-f="hint" value="' + esc(x.hint) + '" placeholder="Подсказка" aria-label="Подсказка"></td>' +
                  cell('options', i, 'percent', x.percent, 'number', 'step="1" min="0"') + cell('options', i, 'fixed', x.fixed, 'number', 'step="500" min="0"') +
                  activeCell('options', i, x.active) + delCell('options', i) + '</tr>';
              }).join('') + '</tbody></table></div></div>' +
          '</section>' +
          '<div class="sticky-save" id="saveBar"' + (state.dirty ? '' : ' hidden') + '><p><b>Есть несохранённые изменения.</b> Они вступят в силу после сохранения.</p>' +
            '<span class="toolbar"><button type="button" class="btn btn--sm btn--ghost" id="resetT">Отменить</button><button type="button" class="btn btn--sm btn--light" id="saveT">Сохранить тарифы</button></span></div>';
      }

      function cell(list, i, f, v, type, extra) {
        return '<td' + (type === 'number' ? ' class="num"' : '') + '><input type="' + type + '" data-list="' + list + '" data-i="' + i + '" data-f="' + f + '" value="' + esc(v) + '" ' + (extra || '') + ' aria-label="' + f + '"></td>';
      }
      function activeCell(list, i, on) {
        return '<td class="col-act"><input type="checkbox" data-list="' + list + '" data-i="' + i + '" data-f="active"' + (on ? ' checked' : '') + ' aria-label="Включено"></td>';
      }
      function delCell(list, i) {
        return '<td class="col-act"><button type="button" class="adm-icon-btn" data-del="' + list + '" data-i="' + i + '" title="Удалить" aria-label="Удалить">' +
          '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></td>';
      }
      function dirty() { state.dirty = true; var bar = $('#saveBar'); if (bar) bar.hidden = false; }

      render();

      content.oninput = content.onchange = function (e) {
        var el = e.target;
        if (!el.dataset || !el.dataset.list) return;
        var row = data[el.dataset.list][Number(el.dataset.i)];
        var f = el.dataset.f;
        if (f === 'active') { row.active = el.checked; el.closest('tr').classList.toggle('is-off', !el.checked); }
        else if (f === 'd0' || f === 'd1') row.days[f === 'd0' ? 0 : 1] = el.value === '' ? '' : Number(el.value);
        else if (el.type === 'number') row[f] = el.value === '' ? '' : Number(el.value);
        else row[f] = el.value;
        dirty();
      };
      content.onclick = function (e) {
        var add = e.target.closest('[data-add]');
        var del = e.target.closest('[data-del]');
        if (add) {
          var list = add.dataset.add;
          if (list === 'cities') data.cities.push({ name: '', km: 0, days: [1, 2], price: 0, active: true });
          if (list === 'carTypes') data.carTypes.push({ label: '', k: 1, active: true });
          if (list === 'options') data.options.push({ label: '', hint: '', percent: 0, fixed: 0, active: true });
          dirty(); render();
          var inputs = $$('input[data-list="' + list + '"][type="text"], input[data-list="' + list + '"]:not([type])');
          if (inputs.length) inputs[inputs.length - 1].focus();
        } else if (del) {
          data[del.dataset.del].splice(Number(del.dataset.i), 1);
          dirty(); render();
        } else if (e.target.closest('[data-sort]')) {
          data.cities.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
          dirty(); render();
        } else if (e.target.closest('#resetT')) {
          state.dirty = false; viewTariffs();
        } else if (e.target.closest('#saveT')) {
          var btn = $('#saveT');
          btn.disabled = true;
          api('PUT', '/admin/tariffs', data).then(function (saved) {
            state.tariffs = saved;
            state.dirty = false;
            toast('Тарифы сохранены');
            data = JSON.parse(JSON.stringify(saved));
            render();
          }).catch(function (err) { btn.disabled = false; handleError(err); });
        }
      };
    }).catch(handleError);
  }

  /* =====================================================================
     Настройки
     ===================================================================== */

  function viewSettings() {
    setPage('Настройки сайта', 'Контакты и текст о компании, которые видят посетители сайта и личного кабинета');
    api('GET', '/settings').then(function (res) {
      var s = res.settings;
      content.innerHTML =
        '<form class="panel" id="settingsForm" novalidate><div class="form-section"><h4>Контакты</h4><div class="form-grid">' +
          field('Телефон', input('phone', s.phone, 'type="tel" data-phone required'), '', 'В шапке, подвале, FAQ и кабинете') +
          field('Email', input('email', s.email, 'type="email" required')) +
          field('Адрес офиса и площадки', input('address', s.address, 'maxlength="300"'), 'span-all') +
          field('Часы работы', input('hours', s.hours, 'maxlength="200"'), 'span-all') +
        '</div></div><div class="form-section"><h4>Мессенджеры</h4><div class="form-grid form-grid--3">' +
          field('Telegram', input('telegram', s.telegram, 'type="url" placeholder="https://t.me/…"')) +
          field('WhatsApp', input('whatsapp', s.whatsapp, 'type="url" placeholder="https://wa.me/7…"')) +
          field('VK', input('vk', s.vk, 'type="url" placeholder="https://vk.com/…"')) +
        '</div><p class="field__hint">Пустые ссылки не показываются на сайте.</p></div>' +
        '<div class="form-section"><h4>О компании</h4><div class="form-grid">' +
          field('Текст «О компании»', textarea('about', s.about, 'maxlength="5000" rows="8" placeholder="История компании, опыт, ключевые клиенты. Каждый абзац — с новой строки."'), 'span-all',
            'Показывается в разделе «О компании» на главной. Пусто — на сайте стоит текст по умолчанию.') +
          field('Реквизиты', textarea('requisites', s.requisites, 'maxlength="1000" rows="3" placeholder="ООО «Карго Экспресс», ИНН …, ОГРН …"'), 'span-all', 'Показываются в подвале сайта') +
        '</div></div>' +
        '<div class="form-actions"><button type="submit" class="btn btn--dark">Сохранить</button><a class="btn btn--outline-dark" href="./#contacts" target="_blank" rel="noopener">Посмотреть на сайте</a><p class="form-status" role="status"></p></div></form>';

      var form = $('#settingsForm');
      form.addEventListener('input', function () { state.dirty = true; });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var st = $('.form-actions .form-status', form);
        api('PUT', '/admin/settings', formData(form)).then(function () {
          state.dirty = false;
          setStatus(st, 'Сохранено', 'ok');
          toast('Настройки сохранены');
        }).catch(function (err) { setStatus(st, err.message, 'error'); });
      });
    }).catch(handleError);
  }

  /* =====================================================================
     Журнал
     ===================================================================== */

  var ENTITY_LINK = { order: '#order/', client: '#client/' };

  function viewAudit(r) {
    var page = Number(r.params.page) || 1;
    setPage('Журнал действий', 'Кто и когда менял данные');
    api('GET', '/admin/audit?page=' + page).then(function (res) {
      content.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Когда</th><th>Сотрудник</th><th>Действие</th><th>Подробности</th></tr></thead><tbody>' +
        (res.entries.length ? res.entries.map(function (e) {
          var link = ENTITY_LINK[e.entity] && e.entityId && e.action.indexOf('Удалил') < 0
            ? ' <a class="panel__link" href="' + ENTITY_LINK[e.entity] + esc(e.entityId) + '">открыть</a>' : '';
          return '<tr><td class="nowrap">' + formatDate(e.createdAt, true) + '</td><td>' + esc(e.user) + (e.role ? '<small>' + esc(T.ROLES[e.role] || '') + '</small>' : '') + '</td>' +
            '<td>' + esc(e.action) + '</td><td>' + esc(e.details || '—') + link + '</td></tr>';
        }).join('') : '<tr class="empty-row"><td colspan="4">Записей пока нет</td></tr>') +
        '</tbody></table></div><div id="pager"></div>';
      $('#pager').appendChild(pager(res.total, res.page, res.pageSize, function (n) { go(hashFor('audit', { page: n })); }));
    }).catch(handleError);
  }

  /* =====================================================================
     Вход и старт
     ===================================================================== */

  function showLogin() {
    state.user = null;
    document.body.classList.remove('is-loading');
    $('#loginView').hidden = false;
    $('#appView').hidden = true;
  }

  function onLogin(user) {
    if (user.role !== 'manager' && user.role !== 'admin') {
      location.replace('account.html');
      return;
    }
    state.user = user;
    document.body.classList.remove('is-loading');
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    $('#meName').textContent = user.name;
    $('#meRole').textContent = T.ROLES[user.role];
    $('#meAvatar').textContent = user.name.trim().charAt(0).toUpperCase() || '•';
    renderNav();
    route();
    refreshCounts().catch(function () {});
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this;
    var st = $('.form-status', form);
    var f = formData(form);
    if (!f.email || !f.password) return setStatus(st, 'Введите email и пароль', 'error');
    setStatus(st, 'Входим…');
    api('POST', '/auth/login', f).then(function (res) {
      setStatus(st, '');
      form.reset();
      if (res.user.role === 'client') return setStatus(st, 'Это вход для сотрудников. Клиентам — в личный кабинет.', 'error');
      onLogin(res.user);
    }).catch(function (err) { setStatus(st, err.message, 'error'); });
  });

  $('#logoutBtn').addEventListener('click', function () {
    if (state.dirty && !window.confirm('Есть несохранённые изменения. Выйти?')) return;
    state.dirty = false;
    api('POST', '/auth/logout').catch(function () {}).then(showLogin);
  });

  setInterval(function () { if (state.user && !document.hidden) refreshCounts().catch(function () {}); }, 60000);

  api('GET', '/me').then(function (res) { onLogin(res.user); }).catch(function (err) {
    showLogin();
    if (err.status !== 401) toast(err.message);
  });
})();
