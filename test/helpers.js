'use strict';

const { open } = require('../server/db');
const { createApp } = require('../server/index');
const { hashPassword } = require('../server/auth');

function setup() {
  const db = open(':memory:');
  const server = createApp({ db }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // Мини-клиент с собственной cookie-сессией.
  function client() {
    let cookie = '';
    return async function call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };
  }
  return { db, server, base, client };
}

// Создаёт сотрудника напрямую в БД (как это делает npm run create-admin).
function addStaff(db, role, email, password = 'staffpass1', name = 'Сотрудник') {
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(email, hashPassword(password), name, role);
  return { email, password };
}

module.exports = { setup, addStaff };
