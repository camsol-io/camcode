import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../dist/index.js';
import { blank, drawQR, drawDataMatrix } from './helpers.mjs';

// Three labels stacked as in a photo of several asset labels: each has a QR code and, just to its right, a rectangular Data Matrix
// code with the same text. With this many codes close together ZXing's detectors find only some of them in the
// whole frame or in a fixed grid of windows, and where the stack sits relative to that grid decides which.
const texts = ['sample.io/cra7q8', 'sample.io/fudatb', 'sample.io/ixgdwe'];

function stack(dx, dy) {
  const img = blank(1200, 1600);
  texts.forEach((text, i) => {
    drawQR(img, text, 380 + dx, 330 + dy + i * 190, 4);
    drawDataMatrix(img, text, 571 + dx, 376 + dy + i * 190, 8, 2);
  });
  return img;
}

const expected = texts.flatMap((t) => [`DATA_MATRIX ${t}`, `QR_CODE ${t}`]).sort();

for (const [dx, dy] of [[0, 0], [0, 50], [50, 50], [100, 50], [0, 100], [100, 100]]) {
  test(`reads all six codes of three stacked tags, shifted by ${dx},${dy}`, async () => {
    const out = await scan(stack(dx, dy), { mode: 'all' });
    assert.deepEqual(out.results.map((r) => `${r.format} ${r.text}`).sort(), expected);
  });
}
