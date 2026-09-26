// Контакты компании из настроек админки: подставляются во все элементы с data-set / data-link.
(function () {
  'use strict';

  function apply(settings) {
    window.SITE_SETTINGS = settings;
    Array.prototype.forEach.call(document.querySelectorAll('[data-set]'), function (el) {
      var key = el.getAttribute('data-set');
      var value = settings[key];
      if (!value) { if (key !== 'phone') el.hidden = true; return; }
      el.hidden = false;
      el.textContent = value;
      if (el.tagName === 'A' && key === 'phone') el.href = 'tel:+' + value.replace(/\D/g, '');
      if (el.tagName === 'A' && key === 'email') el.href = 'mailto:' + value;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-link]'), function (el) {
      var value = settings[el.getAttribute('data-link')];
      el.hidden = !value;
      if (value) el.href = value;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-messengers]'), function (box) {
      box.hidden = !box.querySelector('[data-link]:not([hidden])');
    });
  }

  fetch('/api/settings', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) { if (data && data.settings) apply(data.settings); })
    .catch(function () {});
})();
