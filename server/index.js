'use strict';

const path = require('node:path');
const express = require('express');
const { open } = require('./db');
const { createAuth } = require('./auth');
const { createApi } = require('./api');
const { createAdminApi } = require('./admin');
const { createStore } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ db, secureCookies = process.env.NODE_ENV === 'production', trustProxy = process.env.TRUST_PROXY } = {}) {
  const app = express();
  const auth = createAuth(db, { secureCookies });
  const store = createStore(db);

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy === 'true' ? true : trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '));
    next();
  });

  // Защита от CSRF: изменяющие запросы к API принимаются только как JSON
  // и только с того же origin (браузер не отправит такой запрос с чужого сайта без CORS).
  // Запросы без тела (выход, отмена, удаление) пропускаются: HTML-форма всегда
  // отправляет тело с form-типом, а кросс-доменный fetch отсекает проверка Origin.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const hasBody = req.headers['content-type'] !== undefined || Number(req.headers['content-length'] || 0) > 0;
    if (hasBody && !req.is('application/json')) return res.status(415).json({ error: 'Ожидается application/json' });
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.headers.host}`) {
      return res.status(403).json({ error: 'Недопустимый источник запроса' });
    }
    next();
  });

  app.use('/api', express.json({ limit: '200kb' }), auth.loadUser);
  app.use('/api/admin', createAdminApi(db, auth, store));
  app.use('/api', createApi(db, auth, store));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Внутренняя ошибка сервера' : err.message });
  });

  return app;
}

if (require.main === module) {
  const db = open();
  const port = Number(process.env.PORT) || 3000;
  createApp({ db }).listen(port, () => {
    console.log(`Карго Экспресс: http://localhost:${port}`);
  });
}

module.exports = { createApp };
