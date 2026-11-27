import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../dist/index.js';
import { clahe, gamma, tiles } from '../dist/image.js';
import { blank, drawQR, drawDataMatrix, dark, paste } from './helpers.mjs';

// A few tests read images from the public Barcode Reading Benchmark dataset (see fixtures/README.md). Their license is
// not stated, so they are not in the public repository; these tests are skipped when the image is not there.
const missing = (name) =>
  existsSync(new URL(`./fixtures/${name}`, import.meta.url)) ? false : `test image ${name} is not in this checkout`;

const img = (width, height, values) => ({ data: Uint8ClampedArray.from(values), width, height });
const found = (out) => out.results.map((r) => [r.format, r.text, r.pass]);

// Finder patterns whose centre is joined to the ring by a dark bridge (as in the public set's pathological 008 and
// 014, and like spread ink or a printed line in the damaged photos): no pass reads them, grid repair does.
// With bridges on all four sides every scan direction through a finder centre is blocked, and grid repair finds no
// finder: its limit.
for (const sides of [['right'], ['right', 'left']]) {
  test(`grid-repair reads a QR code whose finder centres are bridged to their rings (${sides.join(', ')})`, async () => {
    const S = 300, image = blank(S, S);
    drawQR(image, 'sample.io/abc123', 40, 40, 8); // version 1: 21 modules of 8 px from 72 (helpers add a 4-module margin), finders at modules 0 and 14
    const fill = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.data[y * S + x] = 0; };
    const bridge = { right: [40, 24, 48, 32], left: [8, 24, 16, 32], top: [24, 8, 32, 16], bottom: [24, 40, 32, 48] };
    for (const [fx, fy] of [[72, 72], [72 + 14 * 8, 72], [72, 72 + 14 * 8]]) for (const s of sides) { const [a, b, c, d] = bridge[s]; fill(fx + a, fy + b, fx + c, fy + d); }
    const out = await scan(image, { mode: 'all' });
    assert.deepEqual(found(out), [['QR_CODE', 'sample.io/abc123', 'grid-repair']]);
    // corners in the image's coordinates: the code spans 72 to 240
    for (const [p, q] of out.results[0].points.map((p, i) => [p, [[72, 72], [240, 72], [240, 240], [72, 240]][i]])) assert.ok(Math.hypot(p.x - q[0], p.y - q[1]) < 6, `corner ${JSON.stringify(p)} near ${q}`);
  });
}

test('grid repair finds nothing on an image without a code, quickly', async () => {
  const { gridRepair } = await import('../dist/grid.js');
  const image = blank(400, 300);
  for (let i = 0; i < image.data.length; i++) image.data[i] = (i * 7919) % 251; // deterministic texture
  const t0 = performance.now();
  assert.equal(await gridRepair(image), null);
  assert.ok(performance.now() - t0 < 1000);
});

// A QR code at gray levels 0 to 12: the earlier passes (v2) read nothing here.
function darkQR() {
  const page = blank(500, 500);
  drawQR(page, 'sample.io/dk4q7r', 120, 120, 6);
  return dark(page, 0, 12, 1, 2);
}

test('gamma 0.5 lifts dark tones and keeps black and white', () => {
  assert.deepEqual([...gamma(img(4, 1, [0, 16, 64, 255]), 0.5).data], [0, 64, 128, 255]);
});

test('tiles: an n x n grid of overlapping boxes covering the whole image', () => {
  const boxes = tiles(1000, 600, 2);
  assert.equal(boxes.length, 4);
  for (const b of boxes) assert.deepEqual([b.width, b.height], [650, 390]);
  assert.deepEqual(boxes.map((b) => [b.left, b.top]), [[0, 0], [0, 210], [350, 0], [350, 210]]);
});

test('gamma-tiles reads a very dark QR code in first mode', async () => {
  assert.deepEqual(found(await scan(darkQR(), { mode: 'first' })), [['QR_CODE', 'sample.io/dk4q7r', 'gamma-tiles']]);
});

test('extended passes also run in all mode when another code was already read', async () => {
  const page = blank(1000, 500);
  drawQR(page, 'sample.io/ok2m5s', 60, 120, 6);
  paste(page, darkQR(), 500, 0);
  const out = await scan(page, { mode: 'all' });
  assert.deepEqual(found(out).map(([f, t]) => [f, t]).sort(), [['QR_CODE', 'sample.io/dk4q7r'], ['QR_CODE', 'sample.io/ok2m5s']]);
  assert.ok(['gamma', 'gamma-tiles'].includes(found(out).find((r) => r[1] === 'sample.io/dk4q7r')[2]));
});

test('first mode stops before the extended passes when an earlier pass read a code', async () => {
  const page = blank(1000, 500);
  drawQR(page, 'sample.io/ok2m5s', 60, 120, 6);
  paste(page, darkQR(), 500, 0);
  assert.deepEqual(found(await scan(page, { mode: 'first' })).map((r) => r[2]), ['full']);
});

test('clahe spreads a narrow band of gray levels and keeps their order and the image size', () => {
  // the clip limit bounds the slope of the tone mapping, so the spread grows but stays moderate
  const low = img(16, 16, Array.from({ length: 256 }, (_, i) => (((i % 16) >> 2) + ((i >> 4) >> 2)) % 2 ? 132 : 120));
  const out = clahe(low, 2, 3);
  assert.deepEqual([out.width, out.height], [16, 16]);
  const spread = Math.max(...out.data) - Math.min(...out.data);
  assert.ok(spread > 12 && spread < 40, `spread ${spread}`);
  const ramp = clahe(img(8, 1, [10, 20, 30, 40, 50, 60, 70, 80]), 1, 3);
  for (let i = 1; i < 8; i++) assert.ok(ramp.data[i] >= ramp.data[i - 1]);
});

test('clahe pass reads a QR code with ten gray levels of contrast', async () => {
  const page = blank(600, 600);
  drawQR(page, 'sample.de/cl4h3e', 150, 150, 6);
  assert.deepEqual(found(await scan(dark(page, 60, 70, 1, 3), { mode: 'first' })), [['QR_CODE', 'sample.de/cl4h3e', 'clahe']]);
});

test('gamma pass reads a very dark Data Matrix code on the whole view, before the tiles', async () => {
  const page = blank(500, 500);
  drawDataMatrix(page, 'sample.io/gm05aa', 120, 160, 8, 2);
  const out = await scan(dark(page, 2, 10, 1, 1), { mode: 'first' });
  assert.deepEqual(found(out), [['DATA_MATRIX', 'sample.io/gm05aa', 'gamma']]);
});

test('located pass reads a code zxing located but could not decode, from an enlarged window around it', async () => {
  const page = blank(1700, 1700);
  drawDataMatrix(page, 'sample.io/lw9x2k', 700, 900, 3, 2);
  const out = await scan(dark(page, 40, 200, 1, 0), { mode: 'all' });
  assert.deepEqual(found(out), [['DATA_MATRIX', 'sample.io/lw9x2k', 'located']]);
});

test('rotated-30 reads a QR code with disturbed finder patterns that the detectors miss upright', { skip: missing('qr-pathological-image007.png') }, async () => {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const png = PNG.sync.read(fs.readFileSync(new URL('./fixtures/qr-pathological-image007.png', import.meta.url)));
  const image = { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  assert.deepEqual(found(await scan(image, { mode: 'first' })), [['QR_CODE', 'MAILTO:name@myemail.com', 'rotated-30']]);
});

test('pure reads a computer-made QR code whose finder patterns the detectors reject', { skip: missing('qr-pathological-image006.png') }, async () => {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const png = PNG.sync.read(fs.readFileSync(new URL('./fixtures/qr-pathological-image006.png', import.meta.url)));
  const image = { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  assert.deepEqual(found(await scan(image, { mode: 'first' })), [['QR_CODE', 'MAILTO:name@myemail.com', 'pure']]);
});

// A grid of 1 px dark lines over the whole image (as in the public set's pathological image023): no earlier pass reads it.
test('thin-lines reads a QR code under a grid of thin lines', async () => {
  const S = 260, img = blank(S, S);
  drawQR(img, 'sample.io/abc123', 30, 30, 8);
  for (let k = 4; k < S; k += 8) for (let t = 0; t < S; t++) { img.data[k * S + t] = 0; img.data[t * S + k] = 0; }
  assert.deepEqual(found(await scan(img, { mode: 'all' })), [['QR_CODE', 'sample.io/abc123', 'thin-lines']]);
});

test('global-denoise reads a damaged QR code that the local threshold breaks up', { skip: missing('qr-damaged-image008-third.png') }, async () => {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const { grayFromRGBA } = await import('../dist/index.js');
  const png = PNG.sync.read(fs.readFileSync(new URL('./fixtures/qr-damaged-image008-third.png', import.meta.url)));
  const image = grayFromRGBA(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.deepEqual(found(await scan(image, { mode: 'first' })).map((r) => r[2]), ['global-denoise']);
});

test('upscale-2 reads a small blurred QR code in a small image', { skip: missing('qr-blurred-image015-crop.png') }, async () => {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const { grayFromRGBA } = await import('../dist/index.js');
  const png = PNG.sync.read(fs.readFileSync(new URL('./fixtures/qr-blurred-image015-crop.png', import.meta.url)));
  const image = grayFromRGBA(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.deepEqual(found(await scan(image, { mode: 'first' })).map((r) => r[2]), ['upscale-2']);
});

test('highlights reads a Data Matrix code under glare and uneven light', { skip: missing('dm-dmx3a-crop.png') }, async () => {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const { grayFromRGBA } = await import('../dist/index.js');
  const png = PNG.sync.read(fs.readFileSync(new URL('./fixtures/dm-dmx3a-crop.png', import.meta.url)));
  const image = grayFromRGBA(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.deepEqual(found(await scan(image, { mode: 'first' })).map((r) => r[2]), ['highlights']);
});

test('fillHighlights replaces only saturated pixels, from their surroundings', async () => {
  const { fillHighlights } = await import('../dist/image.js');
  const out = fillHighlights(img(5, 1, [100, 100, 250, 100, 100]), 235, 1);
  assert.deepEqual([out.data[0], out.data[1], out.data[3], out.data[4]], [100, 100, 100, 100]);
  assert.ok(Math.abs(out.data[2] - 100) <= 1, String(out.data[2]));
});

test('tiles-3 finds a second, small QR code in all mode that the other passes miss', { skip: missing('qr-blurred-image027.png') }, async () => {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const { grayFromRGBA } = await import('../dist/index.js');
  const png = PNG.sync.read(fs.readFileSync(new URL('./fixtures/qr-blurred-image027.png', import.meta.url)));
  const image = grayFromRGBA(new Uint8ClampedArray(png.data), png.width, png.height);
  const passes = found(await scan(image, { mode: 'all' })).map((r) => r[2]);
  assert.equal(passes.length, 2, passes.join());
  assert.ok(passes.includes('tiles-3'), passes.join());
});
