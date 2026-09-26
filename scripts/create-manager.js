'use strict';

// Создаёт менеджера или повышает существующего пользователя до менеджера.
// Использование: npm run create-manager -- <email> <пароль> [имя]

const { open } = require('../server/db');
const { hashPassword } = require('../server/auth');

const [email, password, name = 'Менеджер'] = process.argv.slice(2);

if (!email || !password) {
  console.error('Использование: npm run create-manager -- <email> <пароль> [имя]');
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
  db.prepare("UPDATE users SET role = 'manager', password_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
  console.log(`Пользователь ${normalized} теперь менеджер, пароль обновлён.`);
} else {
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'manager')")
    .run(normalized, hashPassword(password), name);
  console.log(`Менеджер ${normalized} создан.`);
}
