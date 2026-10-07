(function () {
  'use strict';

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  document.documentElement.classList.remove('no-js');
  $('#year').textContent = new Date().getFullYear();

  /* ---------- Шапка и меню ---------- */
  var header = $('.header');
  var burger = $('#burger');
  var nav = $('#nav');
  var fab = $('.fab');

  function onScroll() {
    var y = window.scrollY;
    header.classList.toggle('is-scrolled', y > 20);
    if (fab) {
      var form = $('#partner').getBoundingClientRect();
      var nearForm = form.top < window.innerHeight && form.bottom > 0;
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

  /* ---------- Появление блоков при прокрутке ---------- */
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

  /* ---------- Услуги: фото меняется при наведении на пункт ---------- */
  var services = $$('.service');
  var serviceImages = $$('[data-service-img]');
  function showService(item) {
    services.forEach(function (s) { s.classList.toggle('is-active', s === item); });
    serviceImages.forEach(function (img) { img.classList.toggle('is-active', img.dataset.serviceImg === item.dataset.service); });
  }
  services.forEach(function (item) {
    item.addEventListener('mouseenter', function () { showService(item); });
    item.addEventListener('focus', function () { showService(item); });
    item.addEventListener('click', function () { showService(item); });
  });

  /* ---------- Галерея и просмотр фото ---------- */
  var lightbox = $('#lightbox');
  var lbImg = $('#lightboxImg');
  var lbCaption = $('#lightboxCaption');
  var shots = $$('#gallery .gallery__item');
  var current = 0;

  function showShot(i) {
    current = (i + shots.length) % shots.length;
    var link = shots[current];
    var alt = $('img', link).alt;
    lbImg.src = link.href;
    lbImg.alt = alt;
    lbCaption.textContent = alt + ' · ' + (current + 1) + ' из ' + shots.length;
  }

  if (lightbox && typeof lightbox.showModal === 'function') {
    shots.forEach(function (link, i) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        showShot(i);
        lightbox.showModal();
      });
    });
    lightbox.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-lb]');
      if (btn) {
        var action = btn.dataset.lb;
        if (action === 'close') lightbox.close();
        else showShot(current + (action === 'next' ? 1 : -1));
      } else if (e.target === lightbox) {
        lightbox.close();
      }
    });
    lightbox.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') showShot(current + 1);
      if (e.key === 'ArrowLeft') showShot(current - 1);
    });
    // Свайп на телефоне
    var touchX = null;
    lightbox.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    lightbox.addEventListener('touchend', function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 50) showShot(current + (dx < 0 ? 1 : -1));
      touchX = null;
    });
    lightbox.addEventListener('close', function () { lbImg.removeAttribute('src'); });
  }

  /* ---------- Вход или кабинет в шапке ---------- */
  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.user) $('#loginLink').textContent = 'Кабинет';
    })
    .catch(function () {});

  /* ---------- FAQ: открыт только один ответ ---------- */
  var faqItems = $$('.faq__item');
  faqItems.forEach(function (item) {
    item.addEventListener('toggle', function () {
      if (!item.open) return;
      faqItems.forEach(function (other) { if (other !== item) other.open = false; });
    });
  });

  /* ---------- Заявка на сотрудничество ---------- */
  var reqForm = $('#requestForm');
  var status = $('#formStatus');
  var phone = $('#rPhone');

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
    var email = $('#rEmail');
    var okName = name.value.trim().length > 1;
    var okPhone = phone.value.replace(/\D/g, '').length === 11;
    var okEmail = !email.value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());
    var okConsent = $('input[name="consent"]', reqForm).checked;

    name.parentElement.classList.toggle('is-invalid', !okName);
    phone.parentElement.classList.toggle('is-invalid', !okPhone);
    email.parentElement.classList.toggle('is-invalid', !okEmail);
    status.classList.remove('is-ok');

    if (!okName || !okPhone) {
      status.textContent = 'Укажите контактное лицо и номер телефона';
      return;
    }
    if (!okEmail) {
      status.textContent = 'Проверьте email';
      return;
    }
    if (!okConsent) {
      status.textContent = 'Нужно согласие на обработку данных';
      return;
    }

    var payload = {
      company: $('#rCompany').value.trim(),
      name: name.value.trim(),
      phone: phone.value,
      email: email.value.trim(),
      message: $('#rMessage').value.trim()
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
      if (!res.ok) return res.json().then(function (d) { throw new Error(d && d.error); }, function () { throw new Error(); });
      status.classList.add('is-ok');
      status.textContent = 'Спасибо, ' + payload.name + '! Свяжемся с вами в течение рабочего дня.';
      reqForm.reset();
    }).catch(function (err) {
      var phoneText = window.SITE_SETTINGS ? window.SITE_SETTINGS.phone : '';
      status.textContent = (err && err.message ? err.message + '. ' : 'Не удалось отправить. ') + (phoneText ? 'Телефон: ' + phoneText : '');
    }).then(function () {
      btn.disabled = false;
    });
  });
})();
