'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function str(value, { max = 200, required = false, field = 'Поле' } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new HttpError(400, `${field}: обязательное поле`);
  if (s.length > max) throw new HttpError(400, `${field}: не длиннее ${max} символов`);
  return s;
}

function email(value, { required = true } = {}) {
  const s = str(value, { max: 200, required, field: 'Email' }).toLowerCase();
  if (s && !EMAIL_RE.test(s)) throw new HttpError(400, 'Email: некорректный адрес');
  return s;
}

function phone(value, { required = false } = {}) {
  const raw = str(value, { max: 32, required, field: 'Телефон' });
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits.length !== 11 || digits[0] !== '7') throw new HttpError(400, 'Телефон: формат +7 (XXX) XXX-XX-XX');
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'Пароль: минимум 8 символов');
  if (value.length > 128) throw new HttpError(400, 'Пароль: не длиннее 128 символов');
  return value;
}

function vin(value) {
  const s = str(value, { max: 17, field: 'VIN' }).toUpperCase();
  if (s && !VIN_RE.test(s)) throw new HttpError(400, 'VIN: 17 символов, латиница и цифры');
  return s;
}

function int(value, { min = 0, max = 1e9, field = 'Число' } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.round(n) !== n) throw new HttpError(400, `${field}: целое число`);
  if (n < min || n > max) throw new HttpError(400, `${field}: от ${min} до ${max}`);
  return n;
}

function num(value, { min = 0, max = 1e9, field = 'Число' } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field}: число`);
  if (n < min || n > max) throw new HttpError(400, `${field}: от ${min} до ${max}`);
  return n;
}

function date(value, { field = 'Дата' } = {}) {
  const s = str(value, { max: 10, field });
  if (s && (!DATE_RE.test(s) || isNaN(Date.parse(s)))) throw new HttpError(400, `${field}: формат ГГГГ-ММ-ДД`);
  return s;
}

function oneOf(value, allowed, { field = 'Значение' } = {}) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(allowed, value)) {
    throw new HttpError(400, `${field}: недопустимое значение`);
  }
  return value;
}

function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Не найдено');
  return n;
}

module.exports = { HttpError, str, email, phone, password, vin, int, num, date, oneOf, id };
