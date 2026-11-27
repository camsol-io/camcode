import { test } from 'node:test';
import assert from 'node:assert/strict';
import zxing from '@zxing/library';
const { QRCodeEncoder: Encoder, QRCodeDecoderErrorCorrectionLevel: ErrorCorrectionLevel, ReedSolomonEncoder, GenericGF } = zxing;
import { rsDecode, formatCode, readFormat, readCodewords, deinterleave, dimension } from '../dist/qr.js';
import { refitQR } from '../dist/refit.js';
import { blank } from './helpers.mjs';

// A QR code from ZXing's encoder: the module matrix (rows of 0/1, dark = 1), version, level and mask.
function encode(text, level = 'M') {
  const qr = Encoder.encode(text, ErrorCorrectionLevel.fromString(level), new Map());
  const m = qr.getMatrix();
  const rows = [];
  for (let y = 0; y < m.getHeight(); y++) rows.push(Uint8Array.from({ length: m.getWidth() }, (_, x) => (m.get(x, y) === 1 ? 1 : 0)));
  return { rows, version: qr.getVersion().getVersionNumber(), mask: qr.getMaskPattern(), level };
}

// Draws a module matrix with a 4-module quiet zone, `scale` pixels per module; returns the image and the code's corners.
function draw(rows, scale) {
  const n = rows.length, side = (n + 8) * scale, img = blank(side, side);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rows[y][x]) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) img.data[(4 * scale + y * scale + dy) * side + 4 * scale + x * scale + dx] = 0;
  const a = 4 * scale, b = (4 + n) * scale;
  return { img, corners: [{ x: a, y: a }, { x: b, y: a }, { x: b, y: b }, { x: a, y: b }] };
}

test('rsDecode corrects up to half the EC codewords and refuses more', () => {
  const data = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255);
  const ec = 10;
  const msg = Int32Array.from([...data, ...new Array(ec).fill(0)]);
  new ReedSolomonEncoder(GenericGF.QR_CODE_FIELD_256).encode(msg, ec);
  const block = Array.from(msg);
  assert.deepEqual(rsDecode(block, ec).cw, block, 'a clean block decodes unchanged');
  const five = block.slice(); for (const k of [0, 3, 9, 17, 25]) five[k] ^= 0x5a;
  const r5 = rsDecode(five, ec);
  assert.ok(r5.ok); assert.equal(r5.errors, 5); assert.deepEqual(r5.cw, block);
  const six = five.slice(); six[12] ^= 0x33;
  const r6 = rsDecode(six, ec);
  assert.ok(!r6.ok || r6.errors > 5 || r6.cw.join() !== block.join(), 'six errors are not silently "corrected" to the sent block');
});

test('readFormat finds level and mask with up to 3 flipped format bits', () => {
  const { rows, level, mask } = encode('sample.io/abc123', 'Q');
  const flipped = rows.map((r) => Uint8Array.from(r));
  for (const [x, y] of [[0, 8], [2, 8], [8, 1]]) flipped[y][x] ^= 1; // 3 bits of the first copy
  const f = readFormat(flipped);
  assert.deepEqual([f.level, f.mask], [level, mask]);
  assert.equal(formatCode('M', 0), 0x5412);
});

test('readCodewords and deinterleave give blocks that pass the RS check', () => {
  const { rows, version, mask, level } = encode('http://www.radians.com/sizing_charts/', 'M');
  assert.equal(rows.length, dimension(version));
  const { cws } = readCodewords(rows, version, mask);
  const { ec, blocks } = deinterleave(cws, version, level);
  for (const b of blocks) assert.equal(rsDecode(b.cw, ec).errors, 0);
});

test('refitQR reads a code from corners that are off by up to half a module', async () => {
  const { rows, version } = encode('amzn.to/socialqr', 'M');
  const scale = 6;
  const { img, corners } = draw(rows, scale);
  const jitter = [[0.45, -0.3], [-0.4, 0.35], [0.3, 0.45], [-0.45, -0.4]].map(([dx, dy]) => [dx * scale, dy * scale]);
  const off = corners.map((p, i) => ({ x: p.x + jitter[i][0], y: p.y + jitter[i][1] }));
  const out = await refitQR(img, off, rows, version);
  assert.ok(out, 'decoded');
  assert.equal(out.text, 'amzn.to/socialqr');
  for (let i = 0; i < 4; i++) assert.ok(Math.hypot(out.points[i].x - corners[i].x, out.points[i].y - corners[i].y) < scale, `corner ${i} within a module`);
});

test('refitQR returns null on an image without a code', async () => {
  const { rows, version } = encode('amzn.to/socialqr', 'M');
  const img = blank(200, 200, 200);
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 7919) % 251; // noise
  const out = await refitQR(img, [{ x: 20, y: 20 }, { x: 170, y: 20 }, { x: 170, y: 170 }, { x: 20, y: 170 }], rows, version);
  assert.equal(out, null);
});
