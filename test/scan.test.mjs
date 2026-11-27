import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, grayFromRGBA } from '../dist/index.js';
import { blank, drawQR, drawDataMatrix, invert, inside } from './helpers.mjs';

const codes = (out) => out.results.map((r) => [r.format, r.text]);

test('grayFromRGBA weights RGB like ZXing and treats transparent pixels as white', async () => {
  const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 0]);
  const gray = grayFromRGBA(rgba, 4, 1);
  assert.deepEqual([...gray.data], [0, 255, 76, 255]);
  assert.equal(gray.width, 4);
  assert.equal(gray.height, 1);
});

test('reads a single QR code', async () => {
  const img = blank(300, 300);
  drawQR(img, 'sample.io/abc123', 50, 50);
  assert.deepEqual(codes(await scan(img)), [['QR_CODE', 'sample.io/abc123']]);
});

// A dark band or frame that runs straight into the code (no light quiet zone on that side), as in the public set's
// "pathological" images: no pass before edge-bands reads it.
for (const [what, bands] of [['a dark band below it', ['bottom']], ['a dark frame around it', ['top', 'left', 'bottom', 'right']]]) {
  test(`edge-bands reads a QR code with ${what}`, async () => {
    const img = blank(260, 260);
    drawQR(img, 'sample.io/abc123', 30, 30, 8); // the code covers 30 to 229
    const paint = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data[y * 260 + x] = 0; };
    const box = { top: [0, 0, 260, 30], left: [0, 0, 30, 260], bottom: [0, 230, 260, 260], right: [230, 0, 260, 260] };
    for (const b of bands) paint(...box[b]);
    const out = await scan(img, { mode: 'all' });
    assert.deepEqual(codes(out), [['QR_CODE', 'sample.io/abc123']]);
    assert.equal(out.results[0].pass, 'edge-bands');
    assert.ok(inside(out.results[0].points, { left: 20, top: 20, width: 220, height: 220 }), 'points in the frame of the original image');
  });
}

test('reads a Data Matrix code', async () => {
  const img = blank(300, 300);
  drawDataMatrix(img, 'sample.de/t/r6k4xe', 60, 60);
  assert.deepEqual(codes(await scan(img)), [['DATA_MATRIX', 'sample.de/t/r6k4xe']]);
});

test('returns points inside the code area of the original image', async () => {
  const img = blank(900, 700);
  const box = drawQR(img, 'sample.io/h2n8vb', 400, 250);
  const [result] = (await scan(img)).results;
  assert.ok(inside(result.points, box), JSON.stringify(result.points));
});

test('reads a light-on-dark QR code', async () => {
  const img = blank(300, 300);
  drawQR(img, 'sample.io/p5d9zc', 50, 50);
  assert.deepEqual(codes(await scan(invert(img))), [['QR_CODE', 'sample.io/p5d9zc']]);
});

test('returns no results for an image without a code', async () => {
  assert.deepEqual((await scan(blank(200, 200))).results, []);
});

test('returns no results, and does not fail, for very small or strangely shaped images', async () => {
  for (const [width, height] of [[1, 1], [2, 2], [5, 300], [300, 5], [119, 119]]) {
    for (const mode of ['first', 'all']) {
      assert.deepEqual((await scan(blank(width, height), { mode })).results, [], `${width}x${height} ${mode}`);
    }
  }
});

test('returns no results for an image of pure noise', async () => {
  const img = blank(400, 400);
  let seed = 1;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = (seed >> 16) & 255;
  }
  assert.deepEqual((await scan(img, { mode: 'all' })).results, []);
});

function twoCodes(textA, textB) {
  const img = blank(640, 300);
  drawQR(img, textA, 30, 60);
  drawQR(img, textB, 360, 60);
  return img;
}

const sorted = (pairs) => pairs.map((p) => p.join(' ')).sort();

test('first mode returns one code when two are present', async () => {
  assert.equal((await scan(twoCodes('sample.io/aaaaaa', 'sample.io/bbbbbb'), { mode: 'first' })).results.length, 1);
});

test('all mode returns every code in the image', async () => {
  const out = await scan(twoCodes('sample.io/aaaaaa', 'sample.io/bbbbbb'), { mode: 'all' });
  assert.deepEqual(sorted(codes(out)), ['QR_CODE sample.io/aaaaaa', 'QR_CODE sample.io/bbbbbb']);
});

test('all mode keeps two codes with the same text at different places', async () => {
  const out = await scan(twoCodes('Test', 'Test'), { mode: 'all' });
  assert.equal(out.results.length, 2);
  const [a, b] = out.results.map((r) => Math.min(...r.points.map((p) => p.x)));
  assert.ok(Math.abs(a - b) > 200, `x positions ${a} and ${b}`);
});

const allowed = (text) => /^sample\.(io|de)\//.test(text);

test('isValid rejects codes that fail the check', async () => {
  const img = blank(300, 300);
  drawQR(img, 'hello', 50, 50);
  assert.deepEqual((await scan(img, { isValid: allowed })).results, []);
});

test('isValid skips an invalid code and finds the valid one', async () => {
  const out = await scan(twoCodes('hello', 'sample.io/abc123'), { isValid: allowed });
  assert.deepEqual(codes(out), [['QR_CODE', 'sample.io/abc123']]);
});

test('leaves the caller image unchanged', async () => {
  const img = twoCodes('sample.io/aaaaaa', 'sample.io/bbbbbb');
  const before = img.data.slice();
  await scan(img, { mode: 'all' });
  assert.deepEqual(img.data, before);
});

test('records how long after the start each code was found', async () => {
  const out = await scan(twoCodes('sample.io/aaaaaa', 'sample.io/bbbbbb'), { mode: 'all' });
  const times = out.results.map((r) => r.elapsedMs);
  assert.ok(times.every((t) => Number.isFinite(t) && t >= 0 && t <= out.elapsedMs), JSON.stringify(times));
  assert.ok(times[0] <= times[1], JSON.stringify(times));
});

test('reads an RGBA image (four bytes per pixel) like the same gray image', async () => {
  const img = blank(300, 300);
  drawQR(img, 'sample.io/rgba01', 50, 50);
  const rgba = new Uint8ClampedArray(img.data.length * 4);
  img.data.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
  const out = await scan({ data: rgba, width: 300, height: 300 });
  assert.deepEqual(codes(out), [['QR_CODE', 'sample.io/rgba01']]);
  const gray = await scan(img);
  assert.deepEqual(out.results[0].points, gray.results[0].points);
});

test('starts no new pass once the budget is spent', async () => {
  // light-on-dark, so only the last fallback pass can read it; with no budget left no pass starts
  const img = blank(300, 300);
  drawQR(img, 'sample.io/budget', 50, 50);
  assert.deepEqual((await scan(invert(img), { budgetMs: 0 })).results, []);
  assert.equal((await scan(invert(img), { budgetMs: Infinity })).results.length, 1);
});

// The public set's synthetic "pathological" codes: a white hole in the centre of each finder pattern, and thin dark
// grid lines between all modules. zxing-cpp's finder search rejects both; only the morphology fallbacks read them.
// grid-repair runs before fill-holes and reads this synthetic case first; fill-holes stays for the photographed ones
test('a QR code with holes in its finder centres is read by grid-repair or fill-holes', async () => {
  const img = blank(300, 300);
  drawQR(img, 'sample.io/abc123', 20, 20, 8); // 29 modules with the 4-module quiet zone: the code covers 52 to 220
  const n = 21; // modules per side (version 1)
  for (const [mx, my] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    const cx = 52 + mx * 8 + 4, cy = 52 + my * 8 + 4;
    for (let y = cy - 3; y < cy + 3; y++) for (let x = cx - 3; x < cx + 3; x++) img.data[y * 300 + x] = 255;
  }
  const out = await scan(img, { mode: 'all' });
  assert.deepEqual(codes(out), [['QR_CODE', 'sample.io/abc123']]);
  assert.ok(['grid-repair', 'fill-holes'].includes(out.results[0].pass), out.results[0].pass);
});

test('thin-lines reads a QR code covered by a grid of thin dark lines', async () => {
  const img = blank(300, 300);
  drawQR(img, 'sample.io/abc123', 20, 20, 8);
  for (let k = 20; k <= 252; k += 8) for (let t = 0; t < 300; t++) { img.data[k * 300 + t] = 40; img.data[t * 300 + k] = 40; }
  const out = await scan(img, { mode: 'all' });
  assert.deepEqual(codes(out), [['QR_CODE', 'sample.io/abc123']]);
  assert.equal(out.results[0].pass, 'thin-lines');
});

// Finder patterns with gaps in their rings: no finder search reads them; the grid read from the code's bounding box does.
test('bbox-grid reads a QR code whose finder rings have gaps', async () => {
  const img = blank(300, 300);
  drawQR(img, 'sample.io/abc123', 20, 20, 8); // the code covers 52 to 220
  const n = 21;
  for (const [mx, my] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    // a 2-module gap in the top and left side of each outer ring
    for (let y = 52 + my * 8; y < 52 + my * 8 + 8; y++) for (let x = 52 + (mx + 2) * 8; x < 52 + (mx + 4) * 8; x++) img.data[y * 300 + x] = 255;
    for (let x = 52 + mx * 8; x < 52 + mx * 8 + 8; x++) for (let y = 52 + (my + 2) * 8; y < 52 + (my + 4) * 8; y++) img.data[y * 300 + x] = 255;
  }
  const out = await scan(img, { mode: 'all' });
  assert.deepEqual(codes(out), [['QR_CODE', 'sample.io/abc123']]);
  assert.equal(out.results[0].pass, 'bbox-grid');
});
