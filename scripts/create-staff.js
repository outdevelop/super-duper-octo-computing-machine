'use strict';

// Создаёт сотрудника или меняет роль и пароль существующего пользователя.
// Использование:
//   npm run create-admin   -- <email> <пароль> [имя]
//   npm run create-manager -- <email> <пароль> [имя]

const { open } = require('../server/db');
const { hashPassword } = require('../server/auth');

const [role, email, password, name] = process.argv.slice(2);
const titles = { admin: 'Администратор', manager: 'Менеджер' };

if (!titles[role] || !email || !password) {
  console.error('Использование: npm run create-admin -- <email> <пароль> [имя]');
  console.error('               npm run create-manager -- <email> <пароль> [имя]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Пароль должен быть не короче 8 символов');
  process.exit(1);
}

const db = open();
const normalized = email.trim().toLowerCase();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);

if (existing) {
  db.prepare('UPDATE users SET role = ?, password_hash = ?, blocked = 0 WHERE id = ?').run(role, hashPassword(password), existing.id);
  console.log(`${titles[role]}: ${normalized} — роль и пароль обновлены.`);
} else {
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(normalized, hashPassword(password), name || titles[role], role);
  console.log(`${titles[role]} ${normalized} создан.`);
}
