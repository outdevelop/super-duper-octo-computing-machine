(function () {
  'use strict';

  var T = window.TARIFFS;
  var tariffs = T.DEFAULTS;

  var ROUTES_VISIBLE = 8;

  var fmt = new Intl.NumberFormat('ru-RU');
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  document.documentElement.classList.remove('no-js');
  $('#year').textContent = new Date().getFullYear();

  /* ---------- Header / menu ---------- */
  var header = $('.header');
  var burger = $('#burger');
  var nav = $('#nav');
  var fab = $('.fab');

  function onScroll() {
    var y = window.scrollY;
    header.classList.toggle('is-scrolled', y > 20);
    if (fab) {
      var request = $('#request').getBoundingClientRect();
      var nearForm = request.top < window.innerHeight && request.bottom > 0;
      fab.classList.toggle('is-visible', y > window.innerHeight * 0.8 && !nearForm);
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function setMenu(open) {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    nav.classList.toggle('is-open', open);
    header.classList.toggle('menu-open', open);
  }
  burger.addEventListener('click', function () {
    setMenu(burger.getAttribute('aria-expanded') !== 'true');
  });
  $$('a', nav).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });

  /* ---------- Reveal on scroll ---------- */
  var reveals = $$('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el, i) {
      el.style.transitionDelay = (el.closest('.hero') ? i * 80 : 0) + 'ms';
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* ---------- Counters ---------- */
  function animateCount(el) {
    var target = +el.dataset.count;
    var suffix = el.dataset.suffix || '';
    var start = performance.now();
    var dur = 1600;
    (function tick(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt.format(Math.round(target * eased)) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }
  $$('[data-count]').forEach(function (el) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = fmt.format(+el.dataset.count) + (el.dataset.suffix || '');
    } else {
      setTimeout(function () { animateCount(el); }, 400);
    }
  });

  /* ---------- Calculator ---------- */
  var form = $('#calcForm');
  var citySelect = $('#city');
  var typeBox = $('#carType');
  var optionBox = $('#calcOptions');
  var priceEl = $('#price');
  var daysEl = $('#days');
  var distEl = $('#distance');
  var calcCta = $('#calcCta');

  function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var shownPrice = 0;
  function animatePrice(to) {
    var from = shownPrice;
    var start = performance.now();
    var dur = 450;
    shownPrice = to;
    (function tick(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      priceEl.textContent = fmt.format(Math.round(from + (to - from) * eased));
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }

  function renderCalculator() {
    var prevCity = citySelect.value || 'Москва';
    var prevType = ($('input[name="type"]:checked', form) || {}).value;
    var prevOpts = $$('input[name="opt"]:checked', form).map(function (i) { return i.value; });

    citySelect.innerHTML = '';
    tariffs.cities.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); })
      .forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        citySelect.appendChild(opt);
      });
    citySelect.value = T.findCity(tariffs, prevCity) ? prevCity : tariffs.cities[0].name;

    typeBox.innerHTML = tariffs.carTypes.map(function (t, i) {
      var checked = prevType ? t.key === prevType : i === 0;
      return '<label class="chip"><input type="radio" name="type" value="' + esc(t.key) + '"' + (checked ? ' checked' : '') + '>' +
        '<span>' + esc(t.label) + '</span></label>';
    }).join('');
    if (!$('input[name="type"]:checked', form)) $('input[name="type"]', form).checked = true;

    optionBox.innerHTML = tariffs.options.map(function (o) {
      return '<label class="toggle"><input type="checkbox" name="opt" value="' + esc(o.key) + '"' +
        (prevOpts.indexOf(o.key) >= 0 ? ' checked' : '') + '><span class="toggle__ui"></span>' +
        '<span><b>' + esc(o.label) + '</b>' + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</span></label>';
    }).join('');
    $('#calcOptionsField').hidden = !tariffs.options.length;
  }

  function calculate() {
    var type = $('input[name="type"]:checked', form).value;
    var opts = $$('input[name="opt"]:checked', form).map(function (i) { return i.value; });
    var q = T.quote(tariffs, citySelect.value, type, opts);
    if (!q) return;

    animatePrice(q.price);
    daysEl.textContent = q.days[0] + '–' + q.days[1] + ' дн.';
    distEl.textContent = fmt.format(q.km) + ' км';

    // Передаём выбор в личный кабинет, чтобы форма заказа была заполнена.
    var params = new URLSearchParams({ city: citySelect.value, type: type, opts: opts.join(',') });
    calcCta.href = 'account.html?' + params.toString() + '#new';

    var routeInput = $('#rRoute');
    if (routeInput && !routeInput.dataset.touched) {
      routeInput.value = T.ORIGIN + ' → ' + citySelect.value;
    }
  }
  form.addEventListener('change', calculate);

  /* ---------- Routes table ---------- */
  var ROUTES_VISIBLE = 8;
  var table = $('#routesTable');
  var more = $('#routesMore');

  function renderRoutes() {
    $$('.routes__row:not(.routes__row--head)', table).forEach(function (row) { row.remove(); });
    var expanded = more.dataset.expanded === 'true';
    tariffs.cities.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'routes__row' + (!expanded && i >= ROUTES_VISIBLE ? ' is-hidden' : '');
      row.setAttribute('role', 'row');
      row.tabIndex = 0;
      row.innerHTML =
        '<span class="routes__city" role="cell"></span>' +
        '<span role="cell">' + fmt.format(c.km) + ' км</span>' +
        '<span role="cell">' + c.days[0] + '–' + c.days[1] + ' дней</span>' +
        '<span class="routes__price" role="cell">' + fmt.format(c.price) + ' ₽</span>' +
        '<span class="routes__arrow" aria-hidden="true">→</span>';
      row.firstChild.textContent = c.name;

      function pick() {
        citySelect.value = c.name;
        calculate();
        $('#calc').scrollIntoView({ behavior: 'smooth' });
      }
      row.addEventListener('click', pick);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter') pick(); });
      table.appendChild(row);
    });
    more.hidden = tariffs.cities.length <= ROUTES_VISIBLE;
  }

  more.addEventListener('click', function () {
    var expanded = more.dataset.expanded === 'true';
    $$('.routes__row:not(.routes__row--head)', table).forEach(function (row, i) {
      if (i >= ROUTES_VISIBLE) row.classList.toggle('is-hidden', expanded);
    });
    more.dataset.expanded = String(!expanded);
    more.textContent = expanded ? 'Показать все направления' : 'Свернуть';
  });

  function applyTariffs(data) {
    if (!data || !data.cities || !data.cities.length || !data.carTypes || !data.carTypes.length) return;
    tariffs = data;
    renderCalculator();
    renderRoutes();
    calculate();
  }

  // Сначала рисуем тарифы по умолчанию, чтобы страница не была пустой, затем — актуальные из админки.
  applyTariffs(T.DEFAULTS);
  fetch('/api/tariffs', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(applyTariffs)
    .catch(function () {});

  /* ---------- Auth state in header ---------- */
  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.user) $('#loginLink').textContent = 'Кабинет';
    })
    .catch(function () {});

  /* ---------- FAQ: only one open at a time ---------- */
  var faqItems = $$('.faq__item');
  faqItems.forEach(function (item) {
    item.addEventListener('toggle', function () {
      if (!item.open) return;
      faqItems.forEach(function (other) { if (other !== item) other.open = false; });
    });
  });

  /* ---------- Request form ---------- */
  var reqForm = $('#requestForm');
  var status = $('#formStatus');
  var phone = $('#rPhone');
  $('#rRoute').addEventListener('input', function () { this.dataset.touched = '1'; });

  // Маска телефона: +7 (XXX) XXX-XX-XX
  phone.addEventListener('input', function () {
    var digits = phone.value.replace(/\D/g, '');
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
    phone.value = out;
  });

  reqForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#rName');
    var okName = name.value.trim().length > 1;
    var okPhone = phone.value.replace(/\D/g, '').length === 11;
    var okConsent = $('input[name="consent"]', reqForm).checked;

    name.parentElement.classList.toggle('is-invalid', !okName);
    phone.parentElement.classList.toggle('is-invalid', !okPhone);
    status.classList.remove('is-ok');

    if (!okName || !okPhone) {
      status.textContent = 'Проверьте имя и номер телефона';
      return;
    }
    if (!okConsent) {
      status.textContent = 'Нужно согласие на обработку данных';
      return;
    }

    var payload = {
      name: name.value.trim(),
      phone: phone.value,
      route: $('#rRoute').value.trim(),
      estimate: priceEl.textContent + ' ₽'
    };
    var btn = $('button[type="submit"]', reqForm);
    btn.disabled = true;
    status.textContent = 'Отправляем…';

    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error(res.status);
      status.classList.add('is-ok');
      status.textContent = 'Спасибо, ' + payload.name + '! Перезвоним в течение 15 минут.';
      reqForm.reset();
      $('#rRoute').dataset.touched = '';
      calculate();
    }).catch(function () {
      status.textContent = 'Не удалось отправить. Позвоните нам: ' + (window.SITE_SETTINGS ? window.SITE_SETTINGS.phone : '');
    }).then(function () {
      btn.disabled = false;
    });
  });
})();
