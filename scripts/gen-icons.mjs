/**
 * gen-icons.mjs
 * توليد ملفات PNG من مصادر SVG للتطبيق.
 * الاستخدام: node scripts/gen-icons.mjs
 *
 * المتطلبات: sharp (موجود في node_modules)
 * ملاحظة favicon.ico: لا تتوفر حزمة تحويل ico — الـ SVG يغطي المتصفحات الحديثة
 * وfavicon.ico الحالي محفوظ كما هو.
 */

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sharp = require('sharp');

const PROJECT_ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(PROJECT_ROOT, 'public');
const ICONS_DIR = resolve(PUBLIC, 'icons');

// خلفية كحلية مطابقة للـSVG
const BACKGROUND = { r: 27, g: 42, b: 74, alpha: 1 };

async function svgToPng(svgPath, pngPath, size) {
  if (!existsSync(svgPath)) {
    console.warn(`  SKIP (SVG غير موجود): ${svgPath}`);
    return false;
  }
  const svgBuffer = readFileSync(svgPath);
  // limitInputPixels: false يرفع حد sharp للـSVGs الكبيرة (512x512+)
  await sharp(svgBuffer, { density: Math.ceil((size / 16) * 72), limitInputPixels: false })
    .resize(size, size, { fit: 'contain', background: BACKGROUND })
    .flatten({ background: BACKGROUND })
    .png({ compressionLevel: 9 })
    .toFile(pngPath);
  console.log(`  OK  ${size}x${size} → ${pngPath.replace(PROJECT_ROOT, '.')}`);
  return true;
}

async function main() {
  console.log('\n--- favicon ---');
  const faviconSvg = resolve(PUBLIC, 'favicon.svg');
  await svgToPng(faviconSvg, resolve(PUBLIC, 'favicon-16x16.png'), 16);
  await svgToPng(faviconSvg, resolve(PUBLIC, 'favicon-32x32.png'), 32);
  await svgToPng(faviconSvg, resolve(PUBLIC, 'favicon.png'), 32);
  await svgToPng(faviconSvg, resolve(PUBLIC, 'apple-touch-icon.png'), 180);

  console.log('\n--- logo ---');
  const logoSvg = resolve(PUBLIC, 'logo.svg');
  for (const size of [32, 64, 128, 256, 512]) {
    await svgToPng(logoSvg, resolve(PUBLIC, `logo-${size}.png`), size);
  }

  console.log('\n--- icons/icon-NxN ---');
  const iconSizes = [72, 96, 128, 144, 152, 192, 384, 512];
  for (const size of iconSizes) {
    const svgPath = resolve(ICONS_DIR, `icon-${size}x${size}.svg`);
    const pngPath = resolve(ICONS_DIR, `icon-${size}x${size}.png`);
    await svgToPng(svgPath, pngPath, size);
  }

  console.log('\nfavicon.ico: لا تتوفر حزمة تحويل ico — الملف الحالي محفوظ (favicon.svg يغطي المتصفحات الحديثة).');
  console.log('\nاكتمل توليد الأيقونات.\n');
}

main().catch((err) => {
  console.error('خطأ:', err);
  process.exit(1);
});
