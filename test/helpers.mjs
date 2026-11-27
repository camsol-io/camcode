// Test images: grayscale buffers with codes drawn by ZXing's own encoders.
import { QRCodeWriter, DataMatrixWriter, BarcodeFormat, EncodeHintType } from '@zxing/library';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule } from 'zxing-wasm/reader';

// zxing-wasm in Node fetches its .wasm from a CDN by default, so the tests failed without a network; every test file
// that scans imports this module, which loads the package's own file once (the same module instance dist/ uses)
const wasm = createRequire(import.meta.url).resolve('zxing-wasm/reader').replace(/[\\/](es|cjs)[\\/]reader[\\/]index\.c?js$/, '/reader/zxing_reader.wasm');
await prepareZXingModule({ overrides: { wasmBinary: readFileSync(wasm) }, fireImmediately: true });

export function blank(width, height, value = 255) {
  return { data: new Uint8ClampedArray(width * height).fill(value), width, height };
}

export function invert(img) {
  return { data: img.data.map((v) => 255 - v), width: img.width, height: img.height };
}

// Draws a bit matrix with its top-left corner at (left, top), `scale` pixels per module.
function drawMatrix(img, matrix, left, top, scale) {
  for (let y = 0; y < matrix.getHeight(); y++) {
    for (let x = 0; x < matrix.getWidth(); x++) {
      const v = matrix.get(x, y) ? 0 : 255;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          img.data[(top + y * scale + dy) * img.width + left + x * scale + dx] = v;
        }
      }
    }
  }
  return { left, top, width: matrix.getWidth() * scale, height: matrix.getHeight() * scale };
}

// Returns the box the code occupies, quiet zone included.
export function drawQR(img, text, left, top, scale = 4) {
  const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, new Map([[EncodeHintType.MARGIN, 4]]));
  return drawMatrix(img, matrix, left, top, scale);
}

// Square symbols by default. Asset labels often carry rectangular ones (about 2.2 to 1, 12x26 modules), so
// pass `shape` 2 for those. 1 and 2 are SymbolShapeHint.FORCE_SQUARE and FORCE_RECTANGLE, which the package does not export.
export function drawDataMatrix(img, text, left, top, scale = 6, shape = 1) {
  const matrix = new DataMatrixWriter().encode(text, BarcodeFormat.DATA_MATRIX, 0, 0, new Map([[EncodeHintType.DATA_MATRIX_SHAPE, shape]]));
  return drawMatrix(img, matrix, left, top, scale);
}

// Rotates the image clockwise about its centre onto a canvas big enough to hold all of it, `fill` outside.
// Bilinear sampling, like a camera that sees the code at an angle.
export function rotate(img, degrees, fill = 255) {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const width = Math.ceil(Math.abs(img.width * cos) + Math.abs(img.height * sin) - 1e-9);
  const height = Math.ceil(Math.abs(img.width * sin) + Math.abs(img.height * cos) - 1e-9);
  const out = blank(width, height, fill);
  const at = (x, y) => (x < 0 || y < 0 || x >= img.width || y >= img.height ? fill : img.data[y * img.width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - width / 2;
      const dy = y + 0.5 - height / 2;
      const sx = dx * cos + dy * sin + img.width / 2 - 0.5;
      const sy = -dx * sin + dy * cos + img.height / 2 - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      out.data[y * width + x] =
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    }
  }
  return out;
}

export function inside(points, box) {
  return points.every((p) => p.x >= box.left && p.x <= box.left + box.width && p.y >= box.top && p.y <= box.top + box.height);
}

// A code photographed in a very dark room: blurred (three passes of a box blur of radius r), its values squeezed into
// [low, high], then deterministic noise of +/- amp. Codes like this sit in the public benchmark's bright_spots and
// Data Matrix sets, where only a few gray levels separate modules from background.
export function dark(img, low, high, r = 1, amp = 2, seed = 7) {
  const w = img.width, h = img.height;
  let a = Float32Array.from(img.data), b = new Float32Array(a.length);
  const pass = (src, dst, horizontal) => {
    for (let o = 0; o < (horizontal ? h : w); o++) {
      const at = (i) => (horizontal ? src[o * w + Math.min(w - 1, Math.max(0, i))] : src[Math.min(h - 1, Math.max(0, i)) * w + o]);
      const n = horizontal ? w : h; let s = 0;
      for (let i = -r; i <= r; i++) s += at(i);
      for (let i = 0; i < n; i++) { dst[horizontal ? o * w + i : i * w + o] = s / (2 * r + 1); s += at(i + r + 1) - at(i - r); }
    }
  };
  for (let p = 0; p < 3; p++) { pass(a, b, true); pass(b, a, false); }
  const out = blank(w, h, 0);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < out.data.length; i++) out.data[i] = low + ((high - low) * Uint8ClampedArray.of(a[i])[0]) / 255 + (rnd() - 0.5) * 2 * amp;
  return out;
}

// Copies `src` into `dst` with its top-left corner at (left, top).
export function paste(dst, src, left, top) {
  for (let y = 0; y < src.height; y++) dst.data.set(src.data.subarray(y * src.width, (y + 1) * src.width), (top + y) * dst.width + left);
  return dst;
}

// Draws any format zxing-cpp can write (barcodes too) with its top-left corner at (left, top), `scale` pixels per
// module, by rendering a PNG with zxing-wasm's writer. Returns the box the symbol occupies.
export async function drawBarcode(img, format, text, left, top, scale = 3) {
  const { writeBarcode } = await import('zxing-wasm/writer');
  const { PNG } = await import('pngjs');
  const written = await writeBarcode(text, { format, scale });
  if (written.error) throw new Error(written.error);
  const png = PNG.sync.read(Buffer.from(await written.image.arrayBuffer()));
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      img.data[(top + y) * img.width + left + x] = png.data[i + 3] === 0 ? 255 : png.data[i];
    }
  }
  return { left, top, width: png.width, height: png.height };
}
