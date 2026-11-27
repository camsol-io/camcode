import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../dist/index.js';
import { blank, drawDataMatrix, rotate } from './helpers.mjs';

const allowed = (t) => /^sample\.(io|de)\//.test(t);

// 0, 15, ... 345 degrees: every quarter turn plus the angles in between
const angles = Array.from({ length: 24 }, (_, i) => i * 15);

// A square symbol, and the rectangular one asset labels often carry (12x26 modules, about 8 px per module in the photos)
const symbols = [
  { name: 'square', text: 'sample.de/t/r6k4xe', left: 80, top: 80, scale: 6, shape: 1 },
  { name: 'rectangular', text: 'sample.io/cra7q8', left: 46, top: 100, scale: 8, shape: 2 },
];

for (const symbol of symbols) {
  for (const degrees of angles) {
    test(`reads a ${symbol.name} Data Matrix code rotated by ${degrees} degrees`, async () => {
      const img = blank(300, 300);
      drawDataMatrix(img, symbol.text, symbol.left, symbol.top, symbol.scale, symbol.shape);
      const out = await scan(rotate(img, degrees), { isValid: allowed });
      assert.deepEqual(
        out.results.map((r) => [r.format, r.text]),
        [['DATA_MATRIX', symbol.text]],
      );
    });
  }
}
