(function () {
  'use strict';

  var T = window.TARIFFS;
  var fmt = new Intl.NumberFormat('ru-RU');
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  var state = { user: null, orders: [], filter: '' };

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

  function isManager() { return state.user && state.user.role === 'manager'; }

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

  $('#logoutBtn').addEventListener('click', function () {
    api('POST', '/auth/logout').catch(function () {}).then(function () {
      state.user = null;
      state.orders = [];
      showAuth();
    });
  });

  function showAuth() {
    document.body.classList.remove('is-loading');
    $('#authView').hidden = false;
    $('#appView').hidden = true;
    $('#accUser').hidden = true;
    $('#logoutBtn').hidden = true;
  }

  function onLogin(user) {
    state.user = user;
    document.body.classList.remove('is-loading');
    $('#authView').hidden = true;
    $('#appView').hidden = false;
    $('#accUser').hidden = false;
    $('#logoutBtn').hidden = false;
    renderUser();

    var manager = isManager();
    $$('[data-manager]').forEach(function (el) { el.hidden = !manager; });
    $$('[data-client-only]').forEach(function (el) { el.hidden = manager; });
    $('[data-route="orders"]').textContent = manager ? 'Все заказы' : 'Мои заказы';
    $('[data-route="new"]').hidden = manager;
    $('#ordersTitle').textContent = manager ? 'Все заказы' : 'Мои заказы';
    $('#ordersSub').textContent = manager ? 'Управление перевозками и статусами' : 'Все перевозки и их текущий статус';

    route();
  }

  function renderUser() {
    var u = state.user;
    $('#accName').textContent = u.name;
    $('#accAvatar').textContent = u.name.trim().charAt(0).toUpperCase() || '•';
    $('#pEmail').value = u.email;
    $('#pName').value = u.name;
    $('#pPhone').value = u.phone;
    $('#profileSince').textContent = (u.role === 'manager' ? 'Менеджер' : 'Клиент') + ' с ' + formatDate(u.createdAt);
  }

  /* ---------- Роутинг по hash ---------- */

  function route() {
    if (!state.user) return;
    var hash = location.hash.replace(/^#/, '') || 'orders';
    var name = hash.split('/')[0];
    if (name === 'new' && isManager()) name = 'orders';
    if (name === 'leads' && !isManager()) name = 'orders';
    if (!$('[data-view="' + name + '"]')) name = 'orders';

    $$('.view').forEach(function (v) { v.hidden = v.dataset.view !== name; });
    $$('#sideNav a').forEach(function (a) {
      a.classList.toggle('is-active', a.dataset.route === name || (name === 'order' && a.dataset.route === 'orders'));
    });

    if (name === 'orders') loadOrders();
    if (name === 'order') loadOrder(hash.split('/')[1]);
    if (name === 'leads') loadLeads();
    if (name === 'new') updateQuote();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  /* ---------- Список заказов ---------- */

  function loadOrders() {
    var url = '/orders' + (isManager() && state.filter ? '?status=' + encodeURIComponent(state.filter) : '');
    api('GET', url).then(function (res) {
      state.orders = res.orders;
      renderOrders();
    }).catch(handleError);
    if (isManager()) loadStats();
  }

  function renderOrders() {
    var list = $('#ordersList');
    $('#ordersEmpty').hidden = state.orders.length > 0;
    list.innerHTML = state.orders.map(function (o) {
      var type = T.CAR_TYPES[o.carType];
      return '<a class="order-row" href="#order/' + o.id + '">' +
        '<span class="order-row__num">' + esc(o.number) + '<small>' + formatDate(o.createdAt) + '</small></span>' +
        '<span class="order-row__route"><b>' + esc(o.origin) + ' → ' + esc(o.city) + '</b>' +
          '<span>' + (o.client ? esc(o.client.name) + ' · ' + esc(o.client.phone) : fmt.format(o.km) + ' км · ' + o.days[0] + '–' + o.days[1] + ' дн.') + '</span></span>' +
        '<span class="order-row__car"><b>' + esc(o.carModel) + '</b><span>' + esc(type ? type.label : o.carType) + '</span></span>' +
        badge(o.status) +
        '<span class="order-row__price">' + fmt.format(o.price) + ' ₽</span>' +
      '</a>';
    }).join('');
  }

  function badge(status) {
    return '<span class="badge badge--' + esc(status) + '">' + esc(T.STATUSES[status] || status) + '</span>';
  }

  function renderFilters() {
    var box = $('#statusFilter');
    var items = [['', 'Все']].concat(Object.keys(T.STATUSES).map(function (k) { return [k, T.STATUSES[k]]; }));
    box.innerHTML = items.map(function (it) {
      return '<button type="button" data-status="' + it[0] + '"' + (it[0] === state.filter ? ' class="is-active"' : '') + '>' + esc(it[1]) + '</button>';
    }).join('');
  }
  $('#statusFilter').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-status]');
    if (!btn) return;
    state.filter = btn.dataset.status;
    renderFilters();
    loadOrders();
  });
  renderFilters();

  function loadStats() {
    api('GET', '/stats').then(function (res) {
      var s = res.stats;
      var box = $('#stats');
      box.hidden = false;
      box.innerHTML =
        '<div class="stat stat--dark"><b>' + fmt.format(s.active) + '</b><span>в работе</span></div>' +
        '<div class="stat"><b>' + fmt.format(s.orders) + '</b><span>всего заказов</span></div>' +
        '<div class="stat"><b>' + fmt.format(s.clients) + '</b><span>клиентов</span></div>' +
        '<a class="stat" href="#leads"><b>' + fmt.format(s.newLeads) + '</b><span>новых заявок с сайта</span></a>';
    }).catch(function () {});
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
    var type = T.CAR_TYPES[o.carType];
    var opts = o.options.map(function (k) { return T.OPTIONS[k] ? T.OPTIONS[k].label : k; });

    var events = o.events.map(function (ev) {
      return '<li><b>' + esc(T.STATUSES[ev.status] || ev.status) + '</b>' +
        '<time>' + formatDate(ev.createdAt, true) + '</time>' +
        (ev.note ? '<p>' + esc(ev.note) + '</p>' : '') + '</li>';
    }).join('');

    var actions = '';
    if (isManager()) {
      actions =
        '<form class="panel acc-form acc-form--light" id="statusForm">' +
          '<h3>Изменить статус</h3>' +
          '<select class="select" name="status">' + Object.keys(T.STATUSES).map(function (k) {
            return '<option value="' + k + '"' + (k === o.status ? ' selected' : '') + '>' + esc(T.STATUSES[k]) + '</option>';
          }).join('') + '</select>' +
          '<textarea class="field__input" name="note" rows="2" maxlength="500" placeholder="Комментарий для клиента (необязательно)"></textarea>' +
          '<button type="submit" class="btn btn--dark">Сохранить статус</button>' +
          '<p class="form-status" role="status"></p>' +
        '</form>';
    } else if (o.status === 'new') {
      actions = '<div class="panel"><h3>Заявка ещё не подтверждена</h3>' +
        '<p class="view__sub">Менеджер свяжется с вами, чтобы подписать договор. Пока заявка новая, её можно отменить.</p>' +
        '<button class="btn btn--outline-dark panel__action" id="cancelOrder">Отменить заявку</button></div>';
    }

    var client = o.client
      ? '<div class="panel"><h3>Клиент</h3><dl class="kv">' +
          '<div><dt>Имя</dt><dd>' + esc(o.client.name) + '</dd></div>' +
          '<div><dt>Телефон</dt><dd><a href="tel:' + esc(o.client.phone.replace(/[^\d+]/g, '')) + '">' + esc(o.client.phone) + '</a></dd></div>' +
          '<div><dt>Email</dt><dd><a href="mailto:' + esc(o.client.email) + '">' + esc(o.client.email) + '</a></dd></div>' +
        '</dl></div>'
      : '';

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
            '<div class="detail__meta"><span>' + fmt.format(o.km) + ' км</span><span>Срок: ' + o.days[0] + '–' + o.days[1] + ' дн.</span></div>' +
          '</div>' +
          '<div class="panel"><h3>Автомобиль и детали</h3><dl class="kv">' +
            '<div><dt>Марка и модель</dt><dd>' + esc(o.carModel) + '</dd></div>' +
            '<div><dt>Тип</dt><dd>' + esc(type ? type.label : o.carType) + '</dd></div>' +
            (o.vin ? '<div><dt>VIN</dt><dd>' + esc(o.vin) + '</dd></div>' : '') +
            '<div><dt>Опции</dt><dd>' + (opts.length ? esc(opts.join(', ')) : 'нет') + '</dd></div>' +
            (o.pickupAddress ? '<div><dt>Забрать</dt><dd>' + esc(o.pickupAddress) + '</dd></div>' : '') +
            (o.comment ? '<div><dt>Комментарий</dt><dd>' + esc(o.comment) + '</dd></div>' : '') +
            '<div><dt>Создан</dt><dd>' + formatDate(o.createdAt, true) + '</dd></div>' +
          '</dl></div>' +
        '</div>' +
        '<div>' +
          '<div class="panel"><h3>Стоимость</h3><p class="detail__price">' + fmt.format(o.price) + ' ₽</p>' +
            '<p class="view__sub">Страховка включена. Оплата остатка — после осмотра при выдаче.</p></div>' +
          client +
          '<div class="panel"><h3>История</h3><ol class="timeline">' + events + '</ol></div>' +
          actions +
        '</div>' +
      '</div>';

    // Позицию точки ставим через CSSOM, а не inline-стилем (CSP запрещает style="...").
    var dot = $('.detail__line span');
    if (dot) dot.style.left = dot.dataset.pos + '%';

    var statusForm = $('#statusForm');
    if (statusForm) {
      statusForm.addEventListener('submit', function (e) {
        e.preventDefault();
        busy(statusForm, true);
        api('PATCH', '/orders/' + o.id + '/status', {
          status: $('select', statusForm).value,
          note: $('textarea', statusForm).value
        }).then(function (res) {
          renderOrder(res.order);
          toast('Статус обновлён');
        }).catch(function (err) {
          setStatus(statusForm, err.message, 'error');
          busy(statusForm, false);
        });
      });
    }

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
  var citySelect = $('#oCity');

  T.CITIES.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); }).forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    citySelect.appendChild(opt);
  });
  citySelect.value = 'Москва';

  $('#oTypes').innerHTML = Object.keys(T.CAR_TYPES).map(function (k, i) {
    return '<label class="chip"><input type="radio" name="carType" value="' + k + '"' + (i === 0 ? ' checked' : '') + '>' +
      '<span>' + esc(T.CAR_TYPES[k].label) + '</span></label>';
  }).join('');

  $('#oOptions').innerHTML = Object.keys(T.OPTIONS).map(function (k) {
    var o = T.OPTIONS[k];
    return '<label class="toggle"><input type="checkbox" name="opt" value="' + k + '"><span class="toggle__ui"></span>' +
      '<span><b>' + esc(o.label) + '</b><small>' + esc(o.hint) + '</small></span></label>';
  }).join('');

  // Предзаполнение из калькулятора на главной: account.html?city=…&type=…&opts=a,b#new
  (function prefill() {
    var params = new URLSearchParams(location.search);
    if (params.get('city') && T.findCity(params.get('city'))) citySelect.value = params.get('city');
    var type = params.get('type');
    if (type && T.CAR_TYPES[type]) $('input[name="carType"][value="' + type + '"]', orderForm).checked = true;
    (params.get('opts') || '').split(',').forEach(function (k) {
      if (T.OPTIONS[k]) $('input[name="opt"][value="' + k + '"]', orderForm).checked = true;
    });
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  })();

  function currentSelection() {
    return {
      city: citySelect.value,
      carType: $('input[name="carType"]:checked', orderForm).value,
      options: $$('input[name="opt"]:checked', orderForm).map(function (i) { return i.value; })
    };
  }

  function updateQuote() {
    var sel = currentSelection();
    var q = T.quote(sel.city, sel.carType, sel.options);
    if (!q) return;
    $('#oPrice').textContent = fmt.format(q.price);
    $('#oRoute').textContent = T.ORIGIN + ' → ' + sel.city;
    $('#oDays').textContent = q.days[0] + '–' + q.days[1] + ' дн.';
    $('#oKm').textContent = fmt.format(q.km) + ' км';
  }
  orderForm.addEventListener('change', updateQuote);

  orderForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var model = $('#oModel');
    var vin = $('#oVin');
    model.classList.toggle('is-invalid', !model.value.trim());
    var vinValue = vin.value.trim().toUpperCase();
    var vinOk = !vinValue || /^[A-HJ-NPR-Z0-9]{17}$/.test(vinValue);
    vin.classList.toggle('is-invalid', !vinOk);
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

  /* ---------- Заявки с сайта (менеджер) ---------- */

  function loadLeads() {
    api('GET', '/leads').then(function (res) {
      var body = $('#leadsTable tbody');
      if (!res.leads.length) {
        body.innerHTML = '<tr><td colspan="6">Заявок пока нет</td></tr>';
        return;
      }
      body.innerHTML = res.leads.map(function (l) {
        return '<tr' + (l.processed ? ' class="is-done"' : '') + '>' +
          '<td>' + formatDate(l.createdAt, true) + '</td>' +
          '<td>' + esc(l.name) + '</td>' +
          '<td><a href="tel:' + esc(l.phone.replace(/[^\d+]/g, '')) + '">' + esc(l.phone) + '</a></td>' +
          '<td>' + esc(l.route) + '</td>' +
          '<td>' + esc(l.estimate) + '</td>' +
          '<td><input type="checkbox" data-lead="' + l.id + '"' + (l.processed ? ' checked' : '') + ' aria-label="Обработана"></td>' +
        '</tr>';
      }).join('');
    }).catch(handleError);
  }
  $('#leadsTable').addEventListener('change', function (e) {
    var box = e.target.closest('input[data-lead]');
    if (!box) return;
    api('PATCH', '/leads/' + box.dataset.lead, { processed: box.checked }).then(function () {
      box.closest('tr').classList.toggle('is-done', box.checked);
    }).catch(function (err) {
      box.checked = !box.checked;
      toast(err.message);
    });
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

  updateQuote();
  api('GET', '/me')
    .then(function (res) { onLogin(res.user); })
    .catch(function (err) {
      showAuth();
      if (err.status !== 401) toast(err.message);
      // Пришли с кнопки «Оформить заказ» без аккаунта — сразу показываем регистрацию.
      if (location.hash === '#new') $('[data-auth-tab="register"]').click();
    });
})();
