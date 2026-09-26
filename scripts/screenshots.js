'use strict';

// Снимает скриншоты сайта, кабинета и админ-панели в docs/screenshots.
// Сайт поднимается на временной базе с демо-данными, шрифты берутся из npm-пакетов
// @fontsource-variable (работает без доступа к Google Fonts).
//
// Использование: npm run screenshots

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { open } = require('../server/db');
const { createApp } = require('../server/index');
const { seedDemo, DEMO_ACCOUNTS } = require('./demo-data');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

// Google Fonts CSS → локальные @font-face из @fontsource-variable с теми же именами семейств.
function localFonts() {
  const files = {};
  let css = '';
  for (const [pkg, family] of [['unbounded', 'Unbounded'], ['manrope', 'Manrope']]) {
    const dir = path.dirname(require.resolve(`@fontsource-variable/${pkg}/index.css`));
    css += fs.readFileSync(path.join(dir, 'index.css'), 'utf8')
      .replace(new RegExp(`'${family} Variable'`, 'g'), `'${family}'`)
      .replace(/url\(\.\/files\/([^)]+)\)/g, (m, name) => {
        files[name] = path.join(dir, 'files', name);
        return `url(https://fonts.gstatic.com/local/${name})`;
      });
  }
  return { css, files };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-shots-'));
  const db = open(path.join(tmp, 'demo.db'));
  seedDemo(db);
  const server = createApp({ db }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const fonts = localFonts();
  const browser = await chromium.launch();
  const errors = [];
  const saved = [];

  async function newPage(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fonts.css }));
    await page.route('https://fonts.gstatic.com/local/**', (r) => {
      const file = fonts.files[r.request().url().split('/').pop()];
      return file ? r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(file) }) : r.abort();
    });
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`);
    });
    return page;
  }

  // Показывает всё, что появляется при прокрутке, и прячет плавающие элементы.
  async function settle(page, { hideHeader = false } = {}) {
    await page.evaluate(async (hide) => {
      await document.fonts.ready;
      document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
      document.querySelectorAll('.fab, .toast').forEach((el) => { el.style.display = 'none'; });
      if (hide) document.querySelectorAll('.header').forEach((el) => { el.style.display = 'none'; });
    }, hideHeader);
    await page.waitForTimeout(400);
  }

  // Ищет элементы, вылезающие за правый край экрана (кроме тех, что внутри прокручиваемых/обрезанных блоков).
  async function checkOverflow(page, name) {
    const found = await page.evaluate(() => {
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
        }
        return false;
      };
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > window.innerWidth + 1 && !clipped(el)) {
          out.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''));
        }
      }
      return out.slice(0, 5);
    });
    if (found.length) errors.push(`${name}: элементы выходят за край экрана — ${found.join(', ')}`);
  }

  async function shot(page, name, target) {
    if (!target) await checkOverflow(page, name);
    const file = path.join(OUT, name + '.png');
    if (target) await page.locator(target).first().screenshot({ path: file });
    else await page.screenshot({ path: file });
    saved.push(name);
  }

  // Вся страница целиком: окно растягивается на высоту документа, чтобы липкие
  // элементы (боковое меню админки) отрисовались так же, как у пользователя.
  async function shotFull(page, name) {
    const vp = page.viewportSize();
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, window.innerHeight));
    await page.setViewportSize({ width: vp.width, height: Math.min(height, 6000) });
    await page.waitForTimeout(300);
    await shot(page, name);
    await page.setViewportSize(vp);
  }

  async function login(page, url, account) {
    await page.goto(base + url);
    await page.waitForSelector('#lEmail', { state: 'visible' });
    await page.fill('#lEmail', account.email);
    await page.fill('#lPass', account.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForTimeout(1200);
  }

  try {
    /* ---------- Лендинг ---------- */
    let p = await newPage(DESKTOP);
    await p.goto(base + '/');
    await p.waitForTimeout(2000);
    await settle(p);
    await shot(p, 'landing-hero');
    await settle(p, { hideHeader: true });
    await p.check('input[name=type][value=suv]', { force: true });
    await p.waitForTimeout(600);
    for (const [name, sel] of [['landing-calculator', '#calc'], ['landing-steps', '#how'], ['landing-features', '.section--dark-alt'],
      ['landing-routes', '#routes'], ['landing-fleet', '#fleet'], ['landing-faq', '#faq'], ['landing-request', '#request'], ['landing-footer', '.footer']]) {
      await shot(p, name, sel);
    }
    await p.context().close();

    p = await newPage(MOBILE);
    await p.goto(base + '/');
    await p.waitForTimeout(1500);
    await settle(p);
    await shot(p, 'mobile-landing-hero');
    await p.click('#burger');
    await p.waitForTimeout(400);
    await shot(p, 'mobile-landing-menu');
    await p.context().close();

    /* ---------- Кабинет клиента ---------- */
    p = await newPage(DESKTOP);
    await p.goto(base + '/account.html');
    await p.waitForTimeout(800);
    await shot(p, 'account-login');
    await login(p, '/account.html', DEMO_ACCOUNTS.client);
    await shotFull(p, 'account-orders');
    const firstOrder = await p.getAttribute('.order-row', 'href');
    if (firstOrder) {
      await p.goto(base + '/account.html' + firstOrder);
      await p.waitForTimeout(900);
      await shotFull(p, 'account-order');
    }
    await p.goto(base + '/account.html#new');
    await p.waitForTimeout(700);
    await p.fill('#oModel', 'Toyota RAV4, 2024');
    await shotFull(p, 'account-new-order');
    await p.goto(base + '/account.html#profile');
    await p.waitForTimeout(600);
    await shot(p, 'account-profile');
    await p.context().close();

    p = await newPage(MOBILE);
    await login(p, '/account.html', DEMO_ACCOUNTS.client);
    if (firstOrder) {
      await p.goto(base + '/account.html' + firstOrder);
      await p.waitForTimeout(900);
    }
    await shotFull(p, 'mobile-account-order');
    await p.context().close();

    /* ---------- Админ-панель ---------- */
    p = await newPage(DESKTOP);
    await p.goto(base + '/admin.html');
    await p.waitForTimeout(800);
    await shot(p, 'admin-login');
    await login(p, '/admin.html', DEMO_ACCOUNTS.admin);
    await p.waitForTimeout(600);
    await shotFull(p, 'admin-dashboard');

    const pages = [
      ['admin-orders', '#orders'],
      ['admin-order', '#order/3'],
      ['admin-new-order', '#new-order'],
      ['admin-leads', '#leads'],
      ['admin-clients', '#clients'],
      ['admin-client', '#client/3'],
      ['admin-staff', '#staff'],
      ['admin-tariffs', '#tariffs'],
      ['admin-settings', '#settings'],
      ['admin-audit', '#audit']
    ];
    for (const [name, hash] of pages) {
      await p.goto(base + '/admin.html' + hash);
      await p.waitForTimeout(900);
      await shotFull(p, name);
    }
    await p.goto(base + '/admin.html#dashboard');
    await p.waitForTimeout(900);
    const bar = p.locator('.bar-hit').nth(26);
    await bar.hover();
    await p.waitForTimeout(300);
    await shot(p, 'admin-chart', '#chart');
    await p.goto(base + '/account.html');
    await p.waitForTimeout(900);
    await shot(p, 'account-staff');
    await p.context().close();

    p = await newPage(MOBILE);
    await login(p, '/admin.html', DEMO_ACCOUNTS.manager);
    await shotFull(p, 'mobile-admin-dashboard');
    await p.click('#menuBtn');
    await p.waitForTimeout(400);
    await shot(p, 'mobile-admin-menu');
    await p.context().close();
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`Скриншотов сохранено: ${saved.length} → ${path.relative(process.cwd(), OUT)}/`);
  if (errors.length) {
    console.error('Ошибки на страницах:\n  ' + errors.join('\n  '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
