import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrink, scale, rotate, fromRotated, toRGBA, normalize, clearEdgeBands, removeThinLines } from '../dist/image.js';

test('removeThinLines removes a 1 px dark line and keeps a 4 px dark block', () => {
  // 10 x 10 white, a dark line in column 2 (1 px wide), a dark 4 x 4 block at rows 3-6, columns 5-8
  const values = Array.from({ length: 100 }, (_, i) => { const x = i % 10, y = Math.floor(i / 10); return x === 2 || (x >= 5 && x <= 8 && y >= 3 && y <= 6) ? 0 : 255; });
  const out = removeThinLines(img(10, 10, values), 1);
  const at = (x, y) => out.data[y * 10 + x];
  assert.deepEqual([at(2, 0), at(2, 5), at(2, 9)], [255, 255, 255], 'the line is gone');
  assert.deepEqual([at(5, 3), at(8, 6), at(6, 4)], [0, 0, 0], 'the block keeps its size');
  assert.deepEqual([at(4, 4), at(9, 4), at(6, 2), at(6, 7)], [255, 255, 255, 255], 'and does not grow');
});

const img = (width, height, values) => ({ data: Uint8ClampedArray.from(values), width, height });

test('clearEdgeBands returns null when no image edge is dark', () => {
  // a dark square in the middle, light edges all round
  const values = Array.from({ length: 36 }, (_, i) => ((i % 6) > 1 && (i % 6) < 4 && i > 11 && i < 24 ? 0 : 255));
  assert.equal(clearEdgeBands(img(6, 6, values), 0.5), null);
});

test('clearEdgeBands paints a dark band at the edge white and adds a white margin', () => {
  // 6 x 6: a dark pattern in the middle, the bottom row a solid dark band
  const values = Array.from({ length: 36 }, (_, i) => (i >= 30 ? 0 : (i % 6) === 2 && i > 5 ? 0 : 255));
  const out = clearEdgeBands(img(6, 6, values), 0.5);
  assert.equal(out.offset, 3);
  assert.deepEqual([out.image.width, out.image.height], [12, 12]);
  const at = (x, y) => out.image.data[(y + out.offset) * out.image.width + x + out.offset];
  assert.deepEqual([at(0, 5), at(3, 5), at(5, 5)], [255, 255, 255], 'the band is white');
  assert.deepEqual([at(2, 1), at(2, 4), at(0, 1)], [0, 0, 255], 'the rest of the image is unchanged');
  assert.equal(out.image.data[0], 255, 'the margin is white');
});

test('shrink by 2 averages each 2x2 block', () => {
  const out = shrink(img(4, 2, [0, 10, 200, 210, 20, 30, 220, 230]), 2);
  assert.deepEqual([out.width, out.height, ...out.data], [2, 1, 15, 215]);
});

test('shrink by 3 averages each 3x3 block and drops the remainder', () => {
  const out = shrink(img(4, 3, [0, 0, 90, 7, 0, 0, 90, 7, 0, 0, 90, 7]), 3);
  assert.deepEqual([out.width, out.height, ...out.data], [1, 1, 30]);
});

test('normalize gives a dim and a bright copy of the same pattern the same contrast', () => {
  const pattern = (low, high) => img(8, 8, Array.from({ length: 64 }, (_, i) => ((i % 8) + (i >> 3)) % 2 ? high : low));
  const dim = normalize(pattern(40, 70), 2);
  const bright = normalize(pattern(160, 250), 2);
  const spread = (out) => Math.max(...out.data) - Math.min(...out.data);
  assert.ok(spread(dim) > 100, `dim spread ${spread(dim)}`);
  assert.ok(Math.abs(spread(dim) - spread(bright)) < 25, `${spread(dim)} vs ${spread(bright)}`);
});

test('normalize leaves a flat image at mid-gray', () => {
  assert.deepEqual([...normalize(img(3, 3, new Array(9).fill(200)), 1).data], new Array(9).fill(128));
});

test('scale by 2 keeps flat areas flat and blends at an edge', () => {
  const out = scale(img(2, 1, [0, 255]), 2);
  assert.deepEqual([out.width, out.height], [4, 2]);
  assert.deepEqual([...out.data.slice(0, 4)], [0, 64, 191, 255]);
});

test('toRGBA writes each gray value to R, G and B, with full alpha', () => {
  const out = toRGBA(img(2, 1, [0, 200]));
  assert.deepEqual([...out.data], [0, 0, 0, 255, 200, 200, 200, 255]);
});

test('rotate by 90 turns the image clockwise', () => {
  const out = rotate(img(3, 2, [1, 2, 3, 4, 5, 6]), 90);
  assert.deepEqual([out.width, out.height, ...Array.from(out.data, Math.round)], [2, 3, 4, 1, 5, 2, 6, 3]);
});

test('rotate grows the canvas to hold the whole image and fills the new corners with white', () => {
  const out = rotate(img(10, 10, new Array(100).fill(0)), 45);
  assert.deepEqual([out.width, out.height], [15, 15]);
  assert.equal(out.data[0], 255);
  assert.equal(out.data[7 * 15 + 7], 0);
});

test('fromRotated maps a spot of the rotated image back to where it was', () => {
  const src = img(40, 20, new Array(800).fill(255));
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      src.data[(5 + dy) * 40 + 30 + dx] = 0;
    }
  }
  for (const degrees of [37, 45, 90, 200]) {
    const out = rotate(src, degrees);
    let sx = 0;
    let sy = 0;
    let weight = 0;
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const w = 255 - out.data[y * out.width + x];
        sx += w * x;
        sy += w * y;
        weight += w;
      }
    }
    const back = fromRotated({ x: sx / weight, y: sy / weight }, degrees, src, out);
    assert.ok(Math.abs(back.x - 30) < 0.5 && Math.abs(back.y - 5) < 0.5, `${degrees} degrees: ${JSON.stringify(back)}`);
  }
});
