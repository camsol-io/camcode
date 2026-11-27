// Refit: a second chance for a QR code that zxing-cpp located but could not decode (checksum error). zxing-cpp
// samples one binarized pixel per module on a grid from its corner estimate; a grid a fraction of a module off
// turns a readable code into a checksum error. Here the four corners are refined so that the sampled grid matches the
// modules whose value the standard fixes (finders, separators, timing, alignment, dark module), each module is sampled
// as the mean of a 3 x 3 sub-grid, the threshold is set midway between the known dark and light modules, and the
// codewords are corrected with errors-only Reed-Solomon. The corrected codewords are written into a clean symbol that
// zxing-cpp then reads in pure mode, so the content is parsed by zxing-cpp's own decoder.
import { GrayImage, Point, isRGBA, grayFromRGBA } from './image.js';
import { Level, Matrix, MAX_VERSION, correct, cleanSymbol, dimension, knownModules, readCodewords, readFormat } from './qr.js';
import { decode } from './decode.js';

type Map2 = (u: number, v: number) => [number, number];

// homography taking the unit grid corners (0,0), (n,0), (n,n), (0,n) to the four image corners
function homography(n: number, p: number[]): Map2 {
  const src = [[0, 0], [n, 0], [n, n], [0, n]];
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const x = p[2 * i];
    const y = p[2 * i + 1];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) {
      if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) {
        piv = r;
      }
    }
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r !== c && A[c][c] !== 0) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= 8; k++) {
          A[r][k] -= f * A[c][k];
        }
      }
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return (u, v) => {
    const d = h[6] * u + h[7] * v + 1;
    return [(h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d];
  };
}

function bilinear(img: GrayImage, x: number, y: number): number {
  const { data, width: w, height: h } = img;
  x = Math.min(Math.max(x, 0), w - 1.001);
  y = Math.min(Math.max(y, 0), h - 1.001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy;
}

// mean of a 3 x 3 sub-grid spanning +-r modules around each module centre
function sample(img: GrayImage, map: Map2, n: number, r: number): Float32Array[] {
  const s = Array.from({ length: n }, () => new Float32Array(n));
  const offsets = [-r, 0, r];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (const du of offsets) {
        for (const dv of offsets) {
          const [px, py] = map(x + 0.5 + du, y + 0.5 + dv);
          acc += bilinear(img, px, py);
        }
      }
      s[y][x] = acc / 9;
    }
  }
  return s;
}

function calibrate(s: Float32Array[], known: [number, number, number][]): { threshold: number; contrast: number } {
  let dark = 0;
  let nd = 0;
  let light = 0;
  let nl = 0;
  for (const [x, y, v] of known) {
    if (v) {
      dark += s[y][x];
      nd++;
    } else {
      light += s[y][x];
      nl++;
    }
  }
  dark /= nd;
  light /= nl;
  return { threshold: (dark + light) / 2, contrast: light - dark };
}

// agreement of a sampled grid with the known modules, between -0.5 and 0.5 (higher is better)
function agreement(s: Float32Array[], known: [number, number, number][]): number {
  const { threshold, contrast } = calibrate(s, known);
  if (contrast <= 0) {
    return -1;
  }
  let score = 0;
  for (const [x, y, v] of known) {
    const z = Math.max(-0.5, Math.min(0.5, (s[y][x] - threshold) / contrast));
    score += v ? -z : z;
  }
  return score / known.length;
}

// coordinate descent on the 8 corner coordinates, steps of 1/2, 1/4 and 1/8 module
function refine(img: GrayImage, n: number, p0: number[], known: [number, number, number][]): number[] {
  const unit = Math.hypot(p0[2] - p0[0], p0[3] - p0[1]) / n;
  const score = (q: number[]) => agreement(sample(img, homography(n, q), n, 0.15), known);
  let p = p0.slice();
  let best = score(p);
  for (const step of [0.5, 0.25, 0.125]) {
    for (let iteration = 0; iteration < 3; iteration++) {
      let improved = false;
      for (let i = 0; i < 8; i++) {
        for (const sign of [-1, 1]) {
          const q = p.slice();
          q[i] += sign * step * unit;
          const s = score(q);
          if (s > best + 1e-6) {
            best = s;
            p = q;
            improved = true;
          }
        }
      }
      if (!improved) {
        break;
      }
    }
  }
  return p;
}

// Spare EC codewords required per block: 3 keeps a wrong correction below about 3e-10 even for version 1-L.
const MIN_SPARE = 3;

// `points`: zxing-cpp's corners (top-left, top-right, bottom-right, bottom-left of the symbol), `symbol`: its sampled
// modules (format information is read from them), `version`: 1 to 6. Returns the text and the refined corners, or null.
export async function refitQR(image: GrayImage, points: Point[], symbol: Matrix, version: number): Promise<{ text: string; points: Point[] } | null> {
  if (version < 1 || version > MAX_VERSION || symbol.length !== dimension(version)) {
    return null;
  }
  const format = readFormat(symbol);
  if (format.distance > 3) {
    return null;
  }
  const img = isRGBA(image) ? grayFromRGBA(image.data, image.width, image.height) : image;
  const n = dimension(version);
  const known = knownModules(version);
  const p0 = points.flatMap((q) => [q.x, q.y]);
  // zxing-cpp's corners first (cheap, enough when only the binarization failed), then the refined grid
  let refined: number[] | null = null;
  for (const corners of [p0, null]) {
    const p = corners ?? (refined ??= refine(img, n, p0, known));
    const s = sample(img, homography(n, p), n, 0.2);
    const { threshold, contrast } = calibrate(s, known);
    if (contrast <= 0) {
      continue;
    }
    const m = s.map((row) => Uint8Array.from(row, (v) => (v < threshold ? 1 : 0)));
    const raw = correct(readCodewords(m, version, format.mask).cws, version, format.level as Level, MIN_SPARE);
    if (!raw) {
      continue;
    }
    const text = await readClean(cleanSymbol(version, format.level, format.mask, raw));
    if (text !== null) {
      return { text, points: [0, 1, 2, 3].map((i) => ({ x: p[2 * i], y: p[2 * i + 1] })) };
    }
  }
  return null;
}

// zxing-cpp parses the content of a clean, corrected symbol (4 pixels per module, 4-module quiet zone, pure mode)
async function readClean(m: Matrix): Promise<string | null> {
  const n = m.length;
  const scale = 4;
  const side = (n + 8) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) {
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + 4) * scale + dy) * side + (x + 4) * scale + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
  }
  const found = await decode({ data, width: side, height: side }, { formats: ['QR_CODE'], pure: true });
  return found.length === 1 ? found[0].text : null;
}

// Grid read without any finder search, for an upright code whose four corners are known (top-left, top-right,
// bottom-right, bottom-left in the image): the grid is sampled for every version 1 to 6, in the four orientations,
// and accepted only when the format information is within distance 3 and every RS block corrects with 3 EC codewords
// to spare. Broken finder patterns do not matter, since nothing searches for them.
export async function gridQR(image: GrayImage, corners: Point[]): Promise<{ text: string; points: Point[] } | null> {
  const img = isRGBA(image) ? grayFromRGBA(image.data, image.width, image.height) : image;
  const p = corners.flatMap((q) => [q.x, q.y]);
  for (let version = 1; version <= MAX_VERSION; version++) {
    const n = dimension(version);
    const s = sample(img, homography(n, p), n, 0.2);
    let m: Matrix = s.map(() => new Uint8Array(n));
    const known = knownModules(version);
    for (let k = 0; k < 4; k++) {
      const sk = k === 0 ? s : rotateGrid(s, k);
      const { threshold, contrast } = calibrate(sk, known);
      if (contrast <= 0) {
        continue;
      }
      m = sk.map((row) => Uint8Array.from(row, (v) => (v < threshold ? 1 : 0)));
      const format = readFormat(m);
      if (format.distance > 3) {
        continue;
      }
      const raw = correct(readCodewords(m, version, format.mask).cws, version, format.level, MIN_SPARE);
      if (!raw) {
        continue;
      }
      const text = await readClean(cleanSymbol(version, format.level, format.mask, raw));
      if (text !== null) {
        return { text, points: [0, 1, 2, 3].map((i) => corners[(i - k + 4) % 4]) };
      }
    }
  }
  return null;
}

// the sampled grid turned clockwise k quarter turns
function rotateGrid(s: Float32Array[], k: number): Float32Array[] {
  let out = s;
  for (let t = 0; t < k; t++) {
    const n = out.length;
    const src = out;
    out = Array.from({ length: n }, (_, y) => Float32Array.from({ length: n }, (_, x) => src[n - 1 - x][y]));
  }
  return out;
}
