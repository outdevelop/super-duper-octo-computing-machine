'use strict';

// Запускает сайт на отдельной демо-базе (data/demo.db) с тестовыми заказами, клиентами и заявками.
// Использование: npm run demo   (сбросить данные: npm run demo -- --reset)

const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../server/db');
const { createApp } = require('../server/index');
const { seedDemo, DEMO_ACCOUNTS } = require('./demo-data');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'demo.db');
if (process.argv.includes('--reset')) {
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
}

const db = open(file);
if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) seedDemo(db);

const port = Number(process.env.PORT) || 3000;
createApp({ db }).listen(port, () => {
  console.log(`Демо «Карго Экспресс»: http://localhost:${port}`);
  console.log(`  Админка:  http://localhost:${port}/admin.html`);
  console.log(`    администратор ${DEMO_ACCOUNTS.admin.email} / ${DEMO_ACCOUNTS.admin.password}`);
  console.log(`    менеджер      ${DEMO_ACCOUNTS.manager.email} / ${DEMO_ACCOUNTS.manager.password}`);
  console.log(`  Кабинет:  http://localhost:${port}/account.html`);
  console.log(`    клиент        ${DEMO_ACCOUNTS.client.email} / ${DEMO_ACCOUNTS.client.password}`);
});
