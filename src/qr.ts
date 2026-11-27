// QR code structure for versions 1 to 6 (ISO/IEC 18004): function patterns, format information, codeword placement,
// block interleaving, and errors-only Reed-Solomon decoding over GF(256). Used by the refit pass (refit.ts), which
// samples a symbol itself when zxing-cpp located it but could not decode it. Written for this package; no code copied.

export type Level = 'L' | 'M' | 'Q' | 'H';
export type Matrix = Uint8Array[]; // rows of modules, 1 = dark

// ---- GF(256) with the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255];
  }
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a: number, b: number) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
const pow = (i: number) => EXP[((i % 255) + 255) % 255];
// polynomials as arrays, lowest degree first
const pmul = (a: number[], b: number[]) => {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i]) {
      for (let j = 0; j < b.length; j++) {
        r[i + j] ^= mul(a[i], b[j]);
      }
    }
  }
  return r;
};
const peval = (p: number[], x: number) => {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) {
    y = mul(y, x) ^ p[i];
  }
  return y;
};

function syndromes(cw: number[], ec: number): number[] {
  const s = new Array(ec).fill(0);
  for (let j = 0; j < ec; j++) {
    let v = 0;
    for (const c of cw) {
      v = mul(v, pow(j)) ^ c;
    }
    s[j] = v;
  }
  return s;
}

export interface RSResult {
  ok: boolean;
  cw: number[];
  errors: number;
}

// Errors-only decoding of one block (codewords highest degree first, `ec` of them for error correction):
// Berlekamp-Massey, Chien search, Forney. ok is false when the block cannot be corrected.
export function rsDecode(cw: number[], ec: number): RSResult {
  const fail = { ok: false, cw, errors: 0 };
  const s = syndromes(cw, ec);
  if (s.every((v) => v === 0)) {
    return { ok: true, cw: cw.slice(), errors: 0 };
  }
  // Berlekamp-Massey: error locator C
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < ec; n++) {
    let d = s[n];
    for (let i = 1; i <= L; i++) {
      d ^= mul(C[i] || 0, s[n - i]);
    }
    if (d === 0) {
      m++;
      continue;
    }
    const coef = div(d, b);
    const T = C.slice();
    while (C.length < B.length + m) {
      C.push(0);
    }
    for (let i = 0; i < B.length; i++) {
      C[i + m] ^= mul(coef, B[i]);
    }
    if (2 * L <= n) {
      L = n + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  while (C.length > 1 && C[C.length - 1] === 0) {
    C.pop();
  }
  if (2 * L > ec || C.length - 1 !== L) {
    return fail;
  }
  const omega = pmul(s, C).slice(0, ec);
  const dC = C.map((c, i) => (i % 2 === 1 ? c : 0)).slice(1); // formal derivative
  const out = cw.slice();
  let found = 0;
  const n = cw.length;
  for (let k = 0; k < n; k++) {
    const X = pow(n - 1 - k);
    const Xi = pow(255 - (n - 1 - k));
    if (peval(C, Xi) !== 0) {
      continue;
    }
    const den = peval(dC, Xi);
    if (!den) {
      return fail;
    }
    out[k] ^= mul(X, div(peval(omega, Xi), den));
    found++;
  }
  if (found !== L || !syndromes(out, ec).every((v) => v === 0)) {
    return fail;
  }
  return { ok: true, cw: out, errors: found };
}

// ---- structure, versions 1 to 6 (larger versions carry version information, not handled here) ----
// [EC codewords per block, [[blocks, data codewords per block], ...]] per level (ISO/IEC 18004 Table 9)
const BLOCKS: Record<number, Record<Level, [number, [number, number][]]>> = {
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
export const MAX_VERSION = 6;
export const dimension = (version: number) => 17 + 4 * version;

const alignmentCentres = (version: number): [number, number][] => {
  const a = ALIGN[version];
  const last = a[a.length - 1];
  const out: [number, number][] = [];
  for (const cy of a) {
    for (const cx of a) {
      if (!((cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cy === 6 && cx === last))) {
        out.push([cx, cy]);
      }
    }
  }
  return out;
};

// 1 where a module belongs to a function pattern or the format information
export function functionMask(version: number): Matrix {
  const n = dimension(version);
  const f = Array.from({ length: n }, () => new Uint8Array(n));
  const region = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        f[y][x] = 1;
      }
    }
  };
  region(0, 0, 9, 9);
  region(n - 8, 0, 8, 9);
  region(0, n - 8, 9, 8);
  for (const [cx, cy] of alignmentCentres(version)) {
    region(cx - 2, cy - 2, 5, 5);
  }
  region(6, 9, 1, n - 17);
  region(9, 6, n - 17, 1);
  return f;
}

const MASKS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];
const LEVEL_BITS: Record<Level, number> = { M: 0, L: 1, H: 2, Q: 3 };

export function formatCode(level: Level, mask: number): number {
  const d = (LEVEL_BITS[level] << 3) | mask;
  let r = d << 10;
  for (let i = 14; i >= 10; i--) {
    if (r & (1 << i)) {
      r ^= 0x537 << (i - 10);
    }
  }
  return ((d << 10) | r) ^ 0x5412;
}

// positions [x, y] of the 15 format bits, most significant first, for both copies
function formatPositions(n: number): [[number, number][], [number, number][]] {
  const p1: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    p1.push([i, 8]);
  }
  p1.push([7, 8], [8, 8], [8, 7]);
  for (let j = 5; j >= 0; j--) {
    p1.push([8, j]);
  }
  const p2: [number, number][] = [];
  for (let j = n - 1; j >= n - 7; j--) {
    p2.push([8, j]);
  }
  for (let i = n - 8; i < n; i++) {
    p2.push([i, 8]);
  }
  return [p1, p2];
}

const popcount = (x: number) => {
  let c = 0;
  for (; x; x >>= 1) {
    c += x & 1;
  }
  return c;
};

// Level and mask from the format information: the code word nearest to either copy (distance up to 3 is safe).
export function readFormat(m: Matrix): { level: Level; mask: number; distance: number } {
  const [p1, p2] = formatPositions(m.length);
  const value = (ps: [number, number][]) => ps.reduce((a, [x, y]) => (a << 1) | m[y][x], 0);
  const b1 = value(p1);
  const b2 = value(p2);
  let best = { level: 'L' as Level, mask: 0, distance: 99 };
  for (const level of ['L', 'M', 'Q', 'H'] as Level[]) {
    for (let mask = 0; mask < 8; mask++) {
      const c = formatCode(level, mask);
      const d = Math.min(popcount(c ^ b1), popcount(c ^ b2));
      if (d < best.distance) {
        best = { level, mask, distance: d };
      }
    }
  }
  return best;
}

// data modules in reading order (two-column zigzag from the bottom right)
function placement(version: number): [number, number][] {
  const n = dimension(version);
  const f = functionMask(version);
  const order: [number, number][] = [];
  let up = true;
  for (let j = n - 1; j > 0; j -= 2) {
    if (j === 6) {
      j--;
    }
    for (let c = 0; c < n; c++) {
      const i = up ? n - 1 - c : c;
      for (let col = 0; col < 2; col++) {
        if (!f[i][j - col]) {
          order.push([j - col, i]);
        }
      }
    }
    up = !up;
  }
  return order;
}

function blockSpec(version: number, level: Level): { ec: number; lens: number[] } {
  const [ec, groups] = BLOCKS[version][level];
  const lens: number[] = [];
  for (const [count, d] of groups) {
    for (let i = 0; i < count; i++) {
      lens.push(d);
    }
  }
  return { ec, lens };
}

// raw (interleaved) codewords of a module matrix, unmasked
export function readCodewords(m: Matrix, version: number, mask: number): { cws: number[] } {
  const order = placement(version);
  const { ec, lens } = blockSpec(version, 'L');
  const total = lens.reduce((a, d) => a + d + ec, 0);
  const cws: number[] = [];
  for (let k = 0; k < total; k++) {
    let b = 0;
    for (let t = 0; t < 8; t++) {
      const [x, y] = order[k * 8 + t];
      b = (b << 1) | (m[y][x] ^ (MASKS[mask](y, x) ? 1 : 0));
    }
    cws.push(b);
  }
  return { cws };
}

export function deinterleave(raw: number[], version: number, level: Level): { ec: number; blocks: { d: number; cw: number[] }[] } {
  const { ec, lens } = blockSpec(version, level);
  const blocks = lens.map((d) => ({ d, cw: new Array<number>(d + ec) }));
  let off = 0;
  const maxD = Math.max(...lens);
  for (let i = 0; i < maxD; i++) {
    for (const b of blocks) {
      if (i < b.d) {
        b.cw[i] = raw[off++];
      }
    }
  }
  for (let i = 0; i < ec; i++) {
    for (const b of blocks) {
      b.cw[b.d + i] = raw[off++];
    }
  }
  return { ec, blocks };
}

function interleave(blocks: { d: number; cw: number[] }[], ec: number): number[] {
  const out: number[] = [];
  const maxD = Math.max(...blocks.map((b) => b.d));
  for (let i = 0; i < maxD; i++) {
    for (const b of blocks) {
      if (i < b.d) {
        out.push(b.cw[i]);
      }
    }
  }
  for (let i = 0; i < ec; i++) {
    for (const b of blocks) {
      out.push(b.cw[b.d + i]);
    }
  }
  return out;
}

// A clean symbol: function patterns and format information of (level, mask), data modules from `raw` codewords.
export function cleanSymbol(version: number, level: Level, mask: number, raw: number[]): Matrix {
  const n = dimension(version);
  const m = Array.from({ length: n }, () => new Uint8Array(n));
  const finder = (x0: number, y0: number) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        m[y0 + y][x0 + x] = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4) ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  for (let i = 8; i < n - 8; i++) {
    m[6][i] = m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  for (const [cx, cy] of alignmentCentres(version)) {
    for (let y = -2; y <= 2; y++) {
      for (let x = -2; x <= 2; x++) {
        m[cy + y][cx + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1 ? 1 : 0;
      }
    }
  }
  m[n - 8][8] = 1; // dark module
  const code = formatCode(level, mask);
  const [p1, p2] = formatPositions(n);
  for (let t = 0; t < 15; t++) {
    const bit = (code >> (14 - t)) & 1;
    m[p1[t][1]][p1[t][0]] = bit;
    m[p2[t][1]][p2[t][0]] = bit;
  }
  const order = placement(version);
  for (let t = 0; t < order.length; t++) {
    const [x, y] = order[t];
    const k = t >> 3;
    const bit = k < raw.length ? (raw[k] >> (7 - (t & 7))) & 1 : 0;
    m[y][x] = bit ^ (MASKS[mask](y, x) ? 1 : 0);
  }
  return m;
}

// Known modules of a version (value fixed by the standard): finders, separators, timing, alignment, dark module.
export function knownModules(version: number): [number, number, number][] {
  const template = cleanSymbol(version, 'M', 0, []);
  const f = functionMask(version);
  const n = dimension(version);
  const [p1, p2] = formatPositions(n);
  const format = new Set([...p1, ...p2].map(([x, y]) => y * n + x));
  const out: [number, number, number][] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (f[y][x] && !format.has(y * n + x)) {
        out.push([x, y, template[y][x]]);
      }
    }
  }
  return out;
}

// Errors-only decoding of all blocks. Accepted only if every block keeps at least `minSpare` EC codewords unused
// (2 x errors + minSpare <= ec), which keeps the chance of a wrong correction far below that of decoding at full radius.
export function correct(raw: number[], version: number, level: Level, minSpare: number): number[] | null {
  const { ec, blocks } = deinterleave(raw, version, level);
  for (const b of blocks) {
    const r = rsDecode(b.cw, ec);
    if (!r.ok || ec - 2 * r.errors < minSpare) {
      return null;
    }
    b.cw = r.cw;
  }
  return interleave(blocks, ec);
}
