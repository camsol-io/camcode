import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, ALL_FORMATS, DEFAULT_FORMATS } from '../dist/index.js';
import { blank, drawQR, drawBarcode, rotate } from './helpers.mjs';

const codes = (out) => out.results.map((r) => `${r.format} ${r.text}`).sort();

test('reads QR codes and Data Matrix codes by default, and nothing else', async () => {
  assert.deepEqual(DEFAULT_FORMATS, ['QR_CODE', 'DATA_MATRIX']);
  const img = blank(500, 300);
  await drawBarcode(img, 'Code128', 'AB-12345', 40, 60);
  assert.deepEqual((await scan(img, { mode: 'all' })).results, []);
});

const barcodes = [
  ['CODE_128', 'Code128', 'AB-12345'],
  ['CODE_39', 'Code39', 'TOOL-042'],
  ['CODE_93', 'Code93', 'TOOL93'],
  ['EAN_13', 'EAN-13', '4006381333931'],
  ['EAN_8', 'EAN-8', '96385074'],
  ['UPC_A', 'UPC-A', '036000291452'],
  ['ITF', 'ITF', '12345678'],
  ['CODABAR', 'Codabar', 'A40156B'],
];

for (const [format, writerFormat, text] of barcodes) {
  test(`reads a ${format} barcode when asked for it`, async () => {
    const img = blank(600, 300);
    await drawBarcode(img, writerFormat, text, 40, 60);
    assert.deepEqual(codes(await scan(img, { formats: [format] })), [`${format} ${text}`]);
  });
}

test('reads a barcode turned by 90 degrees', async () => {
  const img = blank(600, 300);
  await drawBarcode(img, 'Code128', 'AB-12345', 40, 60);
  assert.deepEqual(codes(await scan(rotate(img, 90), { formats: ['CODE_128'] })), ['CODE_128 AB-12345']);
});

test('reads only the formats asked for when several kinds are in the image', async () => {
  const img = blank(900, 400);
  drawQR(img, 'sample.io/qr1234', 30, 40, 5);
  await drawBarcode(img, 'Code128', 'AB-12345', 400, 80);
  assert.deepEqual(codes(await scan(img, { mode: 'all', formats: ['CODE_128'] })), ['CODE_128 AB-12345']);
  assert.deepEqual(codes(await scan(img, { mode: 'all' })), ['QR_CODE sample.io/qr1234']);
  assert.deepEqual(codes(await scan(img, { mode: 'all', formats: ['QR_CODE', 'CODE_128'] })), ['CODE_128 AB-12345', 'QR_CODE sample.io/qr1234']);
});

test('reads 2D codes beyond QR and Data Matrix when asked for them', async () => {
  for (const [format, writerFormat, text] of [['AZTEC', 'Aztec', 'sample.io/az1234'], ['PDF_417', 'PDF417', 'sample.io/pdf417']]) {
    const img = blank(700, 400);
    await drawBarcode(img, writerFormat, text, 40, 40);
    assert.deepEqual(codes(await scan(img, { formats: [format] })), [`${format} ${text}`], format);
  }
});

test('finds no code in pure noise with every format switched on', async () => {
  const img = blank(400, 400);
  let seed = 3;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = (seed >> 16) & 255;
  }
  assert.deepEqual((await scan(img, { mode: 'all', formats: ALL_FORMATS })).results, []);
});

test('finds no code in a page of printed text lines with every 1D format switched on', async () => {
  // stripes of short dark marks, like lines of small print, the classic source of false 1D reads
  const img = blank(600, 400);
  let seed = 11;
  for (let row = 30; row < 370; row += 18) {
    for (let x = 20; x < 580; ) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const w = 2 + ((seed >> 16) % 6);
      const gap = 2 + ((seed >> 8) % 5);
      for (let y = row; y < row + 9; y++) for (let dx = 0; dx < w; dx++) img.data[y * 600 + x + dx] = 30;
      x += w + gap;
    }
  }
  const linear = ALL_FORMATS.filter((f) => !['QR_CODE', 'DATA_MATRIX', 'AZTEC', 'PDF_417'].includes(f));
  assert.deepEqual((await scan(img, { mode: 'all', formats: linear })).results, []);
});
