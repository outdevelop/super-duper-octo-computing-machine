'use strict';

// Готовит фотографии для сайта: берёт исходники из media/photos/*.jpg и сохраняет
// в public/img/work/ уменьшенные копии WebP двух размеров (<имя>-800.webp и <имя>-1600.webp).
// Использование: npm run photos   (пересоздать все: npm run photos -- --force)

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'media', 'photos');
const OUT = path.join(__dirname, '..', 'public', 'img', 'work');
const WIDTHS = [800, 1600];

// Обрезка снизу (доля высоты, которую оставляем) — убирает дату и подпись камеры в углу кадра.
const KEEP_HEIGHT = {
  'sunset-pickups': 0.915,
  'ambulance-actros': 0.912
};

let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('Не установлен sharp. Выполните один раз: npm install');
  process.exit(1);
}

async function main() {
  const force = process.argv.includes('--force');
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(SRC).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  let made = 0;

  for (const file of files) {
    const slug = path.basename(file, path.extname(file));
    const src = path.join(SRC, file);
    const srcTime = fs.statSync(src).mtimeMs;
    const meta = await sharp(src).rotate().metadata();
    const keep = KEEP_HEIGHT[slug] || 1;
    const height = Math.round(meta.height * keep);

    for (const width of WIDTHS) {
      const out = path.join(OUT, `${slug}-${width}.webp`);
      if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcTime) continue;
      await sharp(src)
        .rotate()
        .extract({ left: 0, top: 0, width: meta.width, height })
        .resize({ width: Math.min(width, meta.width), withoutEnlargement: true })
        .webp({ quality: width > 800 ? 74 : 78, effort: 6 })
        .toFile(out);
      made++;
    }
  }

  const total = fs.readdirSync(OUT).reduce((sum, f) => sum + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`Фото: ${files.length} исходников, создано файлов: ${made}. Папка public/img/work — ${(total / 1024 / 1024).toFixed(1)} МБ`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
