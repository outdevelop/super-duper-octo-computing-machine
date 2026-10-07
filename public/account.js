(function () {
  'use strict';

  var T = window.TARIFFS;
  var fmt = new Intl.NumberFormat('ru-RU');
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  var state = { user: null, orders: [] };
  var tariffs = T.DEFAULTS;

  /* ---------- Утилиты ---------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Даты из SQLite приходят в UTC без зоны: "2026-09-26 12:00:00".
  function formatDate(value, withTime) {
    var d = new Date(String(value).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return esc(value);
    var opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString('ru-RU', opts);
  }

  // Дата без времени «2026-10-05» → «5 окт. 2026 г.».
  function formatDay(value) {
    var d = new Date(value + 'T00:00:00');
    return isNaN(d) ? esc(value) : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function api(method, url, body) {
    return fetch('/api' + url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
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

  function setStatus(form, text, kind) {
    var el = $('.form-status', form) || $('#orderStatus');
    el.textContent = text || '';
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  function formData(form) {
    var out = {};
    $$('input[name], select[name], textarea[name]', form).forEach(function (el) {
      if (el.type === 'checkbox' || el.type === 'radio') return;
      out[el.name] = el.value;
    });
    return out;
  }

  function busy(form, on) {
    $$('button[type="submit"], button[form="' + form.id + '"]').forEach(function (b) {
      if (form.contains(b) || b.getAttribute('form') === form.id) b.disabled = on;
    });
  }


  /* ---------- Маска телефона ---------- */

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
  $$('[data-phone]').forEach(function (input) {
    input.addEventListener('input', function () { maskPhone(input); });
  });

  /* ---------- Авторизация ---------- */

  $$('[data-auth-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.dataset.authTab;
      $$('[data-auth-tab]').forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      $('#loginForm').hidden = tab !== 'login';
      $('#registerForm').hidden = tab !== 'register';
    });
  });

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this;
    var data = formData(form);
    if (!data.email || !data.password) return setStatus(form, 'Введите email и пароль', 'error');
    busy(form, true);
    setStatus(form, 'Входим…');
    api('POST', '/auth/login', data)
      .then(function (res) { setStatus(form, ''); form.reset(); onLogin(res.user); })
      .catch(function (err) { setStatus(form, err.message, 'error'); })
      .then(function () { busy(form, false); });
  });

  $('#registerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this;
    var data = formData(form);
    if (!data.name.trim()) return setStatus(form, 'Укажите имя', 'error');
    if (data.phone.replace(/\D/g, '').length !== 11) return setStatus(form, 'Укажите телефон полностью', 'error');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return setStatus(form, 'Проверьте email', 'error');
    if (data.password.length < 8) return setStatus(form, 'Пароль — минимум 8 символов', 'error');
    if (!$('input[name="consent"]', form).checked) return setStatus(form, 'Нужно согласие на обработку данных', 'error');
    busy(form, true);
    setStatus(form, 'Создаём аккаунт…');
    api('POST', '/auth/register', data)
      .then(function (res) { setStatus(form, ''); form.reset(); onLogin(res.user); toast('Аккаунт создан. Добро пожаловать!'); })
      .catch(function (err) { setStatus(form, err.message, 'error'); })
      .then(function () { busy(form, false); });
  });

  $('#staffLogout').addEventListener('click', function () { $('#logoutBtn').click(); });

  $('#logoutBtn').addEventListener('click', function () {
    api('POST', '/auth/logout').catch(function () {}).then(function () {
      state.user = null;
      state.orders = [];
      showAuth();
    });
  });

  function showAuth() {
    document.body.classList.remove('is-loading');
    $('#staffView').hidden = true;
    $('#authView').hidden = false;
    $('#appView').hidden = true;
    $('#accUser').hidden = true;
    $('#logoutBtn').hidden = true;
  }

  // Сотрудник, открывший кабинет, видит подсказку со ссылкой на админку и кнопкой выхода.
  function showStaff(user) {
    document.body.classList.remove('is-loading');
    $('#authView').hidden = true;
    $('#appView').hidden = true;
    $('#staffView').hidden = false;
    $('#accUser').hidden = false;
    $('#logoutBtn').hidden = false;
    $('#accName').textContent = user.name;
    $('#accAvatar').textContent = user.name.trim().charAt(0).toUpperCase() || '•';
    $('#staffTitle').textContent = user.name + ', ' + (T.ROLES[user.role] || '').toLowerCase();
  }

  function onLogin(user) {
    if (user.role === 'manager' || user.role === 'admin') {
      showStaff(user);
      return;
    }
    state.user = user;
    $('#staffView').hidden = true;
    document.body.classList.remove('is-loading');
    $('#authView').hidden = true;
    $('#appView').hidden = false;
    $('#accUser').hidden = false;
    $('#logoutBtn').hidden = false;
    renderUser();
    route();
  }

  function renderUser() {
    var u = state.user;
    $('#accName').textContent = u.name;
    $('#accAvatar').textContent = u.name.trim().charAt(0).toUpperCase() || '•';
    $('#pEmail').value = u.email;
    $('#pName').value = u.name;
    $('#pPhone').value = u.phone;
    $('#profileSince').textContent = 'Клиент с ' + formatDate(u.createdAt);
  }

  /* ---------- Роутинг по hash ---------- */

  function route() {
    if (!state.user) return;
    var hash = location.hash.replace(/^#/, '') || 'orders';
    var name = hash.split('/')[0];
    if (!$('[data-view="' + name + '"]')) name = 'orders';

    $$('.view').forEach(function (v) { v.hidden = v.dataset.view !== name; });
    $$('#sideNav a').forEach(function (a) {
      a.classList.toggle('is-active', a.dataset.route === name || (name === 'order' && a.dataset.route === 'orders'));
    });

    if (name === 'orders') loadOrders();
    if (name === 'order') loadOrder(hash.split('/')[1]);
    if (name === 'new') updateQuote();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  /* ---------- Список заказов ---------- */

  function loadOrders() {
    api('GET', '/orders').then(function (res) {
      state.orders = res.orders;
      renderOrders();
    }).catch(handleError);
  }

  function renderOrders() {
    var list = $('#ordersList');
    $('#ordersEmpty').hidden = state.orders.length > 0;
    list.innerHTML = state.orders.map(function (o) {
      return '<a class="order-row" href="#order/' + o.id + '">' +
        '<span class="order-row__num">' + esc(o.number) + '<small>' + formatDate(o.createdAt) + '</small></span>' +
        '<span class="order-row__route"><b>' + esc(o.origin) + ' → ' + esc(o.city) + '</b>' +
          '<span>' + (o.km ? fmt.format(o.km) + ' км · ' + o.days[0] + '–' + o.days[1] + ' дн.' : 'срок уточняется') + '</span></span>' +
        '<span class="order-row__car"><b>' + esc(o.carModel) + '</b><span>' + esc(o.carTypeLabel) + '</span></span>' +
        badge(o.status) +
        '<span class="order-row__price">' + (o.price ? fmt.format(o.price) + ' ₽' : 'по запросу') + '</span>' +
      '</a>';
    }).join('');
  }

  function badge(status) {
    return '<span class="badge badge--' + esc(status) + '">' + esc(T.STATUSES[status] || status) + '</span>';
  }

  /* ---------- Карточка заказа ---------- */

  function loadOrder(id) {
    var box = $('#orderDetails');
    box.innerHTML = '';
    api('GET', '/orders/' + encodeURIComponent(id || ''))
      .then(function (res) { renderOrder(res.order); })
      .catch(function (err) {
        if (err.status === 401) return handleError(err);
        box.innerHTML = '<div class="empty"><h3>' + esc(err.message) + '</h3><p>Проверьте ссылку или вернитесь к списку.</p></div>';
      });
  }

  function renderOrder(o) {
    var flowIndex = T.STATUS_FLOW.indexOf(o.status);
    var cancelled = o.status === 'cancelled';
    var progress = T.STATUS_FLOW.map(function (s, i) {
      return '<span' + (!cancelled && i <= flowIndex ? ' class="is-done"' : '') + '></span>';
    }).join('');
    var truckPos = cancelled ? 0 : Math.max(0, flowIndex) / (T.STATUS_FLOW.length - 1) * 100;
    var opts = o.optionLabels;

    var events = o.events.map(function (ev) {
      return '<li><b>' + esc(T.STATUSES[ev.status] || ev.status) + '</b>' +
        '<time>' + formatDate(ev.createdAt, true) + '</time>' +
        (ev.note ? '<p>' + esc(ev.note) + '</p>' : '') + '</li>';
    }).join('');

    var actions = '';
    if (o.status === 'new') {
      actions = '<div class="panel"><h3>Заявка ещё не подтверждена</h3>' +
        '<p class="view__sub">Менеджер свяжется с вами, чтобы подписать договор. Пока заявка новая, её можно отменить.</p>' +
        '<button class="btn btn--outline-dark panel__action" id="cancelOrder">Отменить заявку</button></div>';
    }

    var paid = !o.price ? 'Менеджер рассчитает стоимость и свяжется с вами'
      : o.paymentStatus === 'paid' ? 'Оплачен полностью'
      : o.paymentStatus === 'prepaid' ? 'Предоплата ' + fmt.format(o.paidAmount) + ' ₽, остаток ' + fmt.format(Math.max(o.price - o.paidAmount, 0)) + ' ₽'
      : 'Оплата после осмотра при выдаче';

    $('#orderDetails').innerHTML =
      '<div class="detail">' +
        '<div>' +
          '<div class="panel detail__hero">' +
            '<div class="detail__top"><span class="detail__num">Заказ ' + esc(o.number) + '</span>' + badge(o.status) + '</div>' +
            '<div class="detail__cities">' +
              '<div><small>Откуда</small><b>' + esc(o.origin) + '</b></div>' +
              '<div class="detail__line"><span data-pos="' + truckPos + '"></span></div>' +
              '<div class="ta-r"><small>Куда</small><b>' + esc(o.city) + '</b></div>' +
            '</div>' +
            '<div class="progress">' + progress + '</div>' +
            '<div class="detail__meta"><span>' + (o.km ? fmt.format(o.km) + ' км' : '') + '</span><span>' +
              (o.eta ? 'Прибытие: ' + formatDay(o.eta) : o.days[1] ? 'Срок: ' + o.days[0] + '–' + o.days[1] + ' дн.' : 'Срок уточняется') + '</span></div>' +
          '</div>' +
          '<div class="panel"><h3>Автомобиль и детали</h3><dl class="kv">' +
            '<div><dt>Марка и модель</dt><dd>' + esc(o.carModel) + '</dd></div>' +
            '<div><dt>Тип</dt><dd>' + esc(o.carTypeLabel) + '</dd></div>' +
            (o.vin ? '<div><dt>VIN</dt><dd>' + esc(o.vin) + '</dd></div>' : '') +
            '<div><dt>Опции</dt><dd>' + (opts.length ? esc(opts.join(', ')) : 'нет') + '</dd></div>' +
            (o.pickupAddress ? '<div><dt>Забрать</dt><dd>' + esc(o.pickupAddress) + '</dd></div>' : '') +
            (o.comment ? '<div><dt>Комментарий</dt><dd>' + esc(o.comment) + '</dd></div>' : '') +
            '<div><dt>Создан</dt><dd>' + formatDate(o.createdAt, true) + '</dd></div>' +
          '</dl></div>' +
        '</div>' +
        '<div>' +
          '<div class="panel"><h3>Стоимость</h3><p class="detail__price">' + (o.price ? fmt.format(o.price) + ' ₽' : 'Рассчитывается') + '</p>' +
            '<p class="view__sub">Страховка включена. ' + esc(paid) + '.</p></div>' +
          '<div class="panel"><h3>История</h3><ol class="timeline">' + events + '</ol></div>' +
          actions +
        '</div>' +
      '</div>';

    // Позицию точки ставим через CSSOM, а не inline-стилем (CSP запрещает style="...").
    var dot = $('.detail__line span');
    if (dot) dot.style.left = dot.dataset.pos + '%';

    var cancelBtn = $('#cancelOrder');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        if (!window.confirm('Отменить заявку ' + o.number + '?')) return;
        cancelBtn.disabled = true;
        api('POST', '/orders/' + o.id + '/cancel').then(function (res) {
          renderOrder(res.order);
          toast('Заявка отменена');
        }).catch(function (err) {
          toast(err.message);
          cancelBtn.disabled = false;
        });
      });
    }
  }

  /* ---------- Новый заказ ---------- */

  var orderForm = $('#orderForm');
  var originInput = $('#oOrigin');
  var cityInput = $('#oCity');

  function renderOrderForm() {
    var prev = orderForm.querySelector('input[name="carType"]') ? currentSelection() : null;
    // Подсказки городов: из тарифов, но вписать можно любой город.
    var names = tariffs.cities.map(function (c) { return c.name; }).concat([T.ORIGIN]);
    $('#oCities').innerHTML = names.filter(function (n, i) { return names.indexOf(n) === i; })
      .sort(function (a, b) { return a.localeCompare(b, 'ru'); })
      .map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');

    $('#oTypes').innerHTML = tariffs.carTypes.map(function (t, i) {
      var checked = prev && T.findCarType(tariffs, prev.carType) ? t.key === prev.carType : i === 0;
      return '<label class="chip"><input type="radio" name="carType" value="' + esc(t.key) + '"' + (checked ? ' checked' : '') + '>' +
        '<span>' + esc(t.label) + '</span></label>';
    }).join('');

    $('#oOptions').innerHTML = tariffs.options.map(function (o) {
      var checked = prev && prev.options.indexOf(o.key) >= 0;
      return '<label class="toggle"><input type="checkbox" name="opt" value="' + esc(o.key) + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="toggle__ui"></span><span><b>' + esc(o.label) + '</b>' + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</span></label>';
    }).join('');
    $('#oOptions').closest('fieldset').hidden = !tariffs.options.length;
  }

  // Предзаполнение по ссылке: account.html?origin=…&city=…&type=…&opts=a,b#new
  var params = new URLSearchParams(location.search);
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  function prefill() {
    if (params.get('origin')) originInput.value = params.get('origin').slice(0, 100);
    if (params.get('city')) cityInput.value = params.get('city').slice(0, 100);
    $$('input[name="carType"]', orderForm).forEach(function (i) { if (i.value === params.get('type')) i.checked = true; });
    var opts = (params.get('opts') || '').split(',');
    $$('input[name="opt"]', orderForm).forEach(function (i) { if (opts.indexOf(i.value) >= 0) i.checked = true; });
  }

  function applyTariffs(data) {
    if (!data || !data.cities || !data.cities.length || !data.carTypes || !data.carTypes.length) return;
    tariffs = data;
    renderOrderForm();
    prefill();
    updateQuote();
  }

  function currentSelection() {
    return {
      origin: originInput.value.trim(),
      city: cityInput.value.trim(),
      carType: $('input[name="carType"]:checked', orderForm).value,
      options: $$('input[name="opt"]:checked', orderForm).map(function (i) { return i.value; })
    };
  }

  function updateQuote() {
    var sel = currentSelection();
    var filled = sel.origin && sel.city;
    var q = filled ? T.routeQuote(tariffs, sel.origin, sel.city, sel.carType, sel.options) : null;
    var priced = q && q.priced;
    var price = $('#oPrice');
    price.textContent = priced ? fmt.format(q.price) + '\u00a0₽' : filled ? 'По запросу' : '—';
    price.classList.toggle('calc__price--text', !!filled && !priced);
    $('#oHint').textContent = priced ? 'Цена по тарифу фиксируется при создании заявки'
      : filled ? 'На этот маршрут менеджер рассчитает цену и срок после заявки' : 'Укажите, откуда и куда везём';
    $('#oRoute').textContent = filled ? sel.origin + ' → ' + sel.city : '—';
    $('#oDays').textContent = priced ? q.days[0] + '–' + q.days[1] + ' дн.' : filled ? 'уточнит менеджер' : '—';
    $('#oKm').textContent = priced ? fmt.format(q.km) + ' км' : '—';
  }
  orderForm.addEventListener('change', updateQuote);
  orderForm.addEventListener('input', function (e) { if (e.target === originInput || e.target === cityInput) updateQuote(); });

  orderForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var model = $('#oModel');
    var vin = $('#oVin');
    model.classList.toggle('is-invalid', !model.value.trim());
    var vinValue = vin.value.trim().toUpperCase();
    var vinOk = !vinValue || /^[A-HJ-NPR-Z0-9]{17}$/.test(vinValue);
    vin.classList.toggle('is-invalid', !vinOk);
    originInput.classList.toggle('is-invalid', !originInput.value.trim());
    cityInput.classList.toggle('is-invalid', !cityInput.value.trim());
    if (!originInput.value.trim() || !cityInput.value.trim()) return setStatus(orderForm, 'Укажите, откуда и куда везём', 'error');
    if (!model.value.trim()) return setStatus(orderForm, 'Укажите марку и модель', 'error');
    if (!vinOk) return setStatus(orderForm, 'VIN: 17 символов, латиница и цифры', 'error');

    var body = currentSelection();
    body.carModel = model.value;
    body.vin = vinValue;
    body.pickupAddress = $('#oPickup').value;
    body.comment = $('#oComment').value;

    busy(orderForm, true);
    setStatus(orderForm, 'Создаём заказ…');
    api('POST', '/orders', body).then(function (res) {
      setStatus(orderForm, '');
      $('#oModel').value = '';
      $('#oVin').value = '';
      $('#oPickup').value = '';
      $('#oComment').value = '';
      toast('Заказ ' + res.order.number + ' создан');
      location.hash = 'order/' + res.order.id;
    }).catch(function (err) {
      if (err.status === 401) return handleError(err);
      setStatus(orderForm, err.message, 'error');
    }).then(function () { busy(orderForm, false); });
  });

  /* ---------- Профиль ---------- */

  $('#profileForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this;
    busy(form, true);
    api('PATCH', '/me', { name: $('#pName').value, phone: $('#pPhone').value })
      .then(function (res) {
        state.user = res.user;
        renderUser();
        setStatus(form, 'Сохранено', 'ok');
      })
      .catch(function (err) { setStatus(form, err.message, 'error'); })
      .then(function () { busy(form, false); });
  });

  $('#passwordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this;
    var next = $('#pNext').value;
    if (next.length < 8) return setStatus(form, 'Новый пароль — минимум 8 символов', 'error');
    busy(form, true);
    api('POST', '/me/password', { current: $('#pCur').value, next: next })
      .then(function () { form.reset(); setStatus(form, 'Пароль обновлён. Другие сессии завершены.', 'ok'); })
      .catch(function (err) { setStatus(form, err.message, 'error'); })
      .then(function () { busy(form, false); });
  });

  /* ---------- Старт ---------- */

  function handleError(err) {
    if (err.status === 401) {
      state.user = null;
      showAuth();
      toast('Сессия истекла, войдите снова');
      return;
    }
    toast(err.message);
  }

  applyTariffs(T.DEFAULTS);
  api('GET', '/tariffs').then(applyTariffs).catch(function () {});

  api('GET', '/me')
    .then(function (res) { onLogin(res.user); })
    .catch(function (err) {
      showAuth();
      if (err.status !== 401) toast(err.message);
      // Пришли с кнопки «Оформить заказ» без аккаунта — сразу показываем регистрацию.
      if (location.hash === '#new') $('[data-auth-tab="register"]').click();
    });
})();
