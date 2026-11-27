// Grid repair: reads QR codes whose finder patterns zxing-cpp cannot use (ink spread, a printed line running into a
// finder, a bridge between a finder's centre and its ring), although the data itself is within error correction.
// Finder candidates are found tolerantly along scan lines, three of them fix the module grid, the size is chosen by the
// timing patterns, every module is sampled, the function patterns are set to their standard values, and the code is
// redrawn cleanly for zxing-cpp, which does the error correction.
import { GrayImage, Point, toRGBA } from './image.js';
import { decode } from './decode.js';

interface Finder { x: number; y: number; m: number; n: number }
interface Triple { TL: Finder; TR: Finder; BL: Finder; m: number; d: number; err: number }
type Map = (u: number, v: number) => Point;

// alignment pattern centre positions, versions 1 to 20 (the sizes grid repair tries)
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];

// 1 where a pixel is darker than the mean of its (2r+1) x (2r+1) window by more than c, else 0
function binarize(image: GrayImage, r: number, c: number): Uint8Array {
  const { width: w, height: h, data: s } = image;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += s[y * w + x];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const mean = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
      out[y * w + x] = s[y * w + x] < mean - c ? 1 : 0;
    }
  }
  return out;
}

// the module size if five runs (dark, light, dark centre, light, dark) fit a finder pattern, tolerantly; else 0
function fitRuns(r: number[]): number {
  const u = (r[0] + r[1] + r[2] + r[3] + r[4]) / 7;
  const ring = (v: number) => v >= 0.3 * u && v <= 2.2 * u;
  return ring(r[0]) && ring(r[1]) && r[2] >= 1.6 * u && r[2] <= 5 * u && ring(r[3]) && ring(r[4]) ? u : 0;
}

// Finder candidates: the 1:1:3:1:1 pattern along a row, cross-checked through its centre vertically and along both
// diagonals; three of the four directions are enough, so damage on one side does not hide the finder.
function scanFinders(bin: Uint8Array, w: number, h: number): Finder[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : bin[y * w + x]);
  const through = (x: number, y: number, dx: number, dy: number): { u: number; off: number } | null => {
    if (at(x, y) !== 1) return null;
    const side = (sx: number, sy: number) => {
      const runs: number[] = [];
      let cx = x, cy = y, want = 1, n = 0;
      while (runs.length < 3) {
        const v = at(cx, cy);
        if (v === -1) break;
        if (v === want) { n++; cx += sx; cy += sy; continue; }
        runs.push(n); n = 0; want = 1 - want;
      }
      if (runs.length < 3 && n > 0) runs.push(n);
      return runs;
    };
    const f = side(dx, dy), b = side(-dx, -dy);
    if (f.length < 3 || b.length < 3) return null;
    const u = fitRuns([b[2], b[1], f[0] + b[0] - 1, f[1], f[2]]);
    return u ? { u: u * Math.hypot(dx, dy), off: (f[0] - b[0]) / 2 } : null;
  };
  const hits: { x: number; y: number; u: number }[] = [];
  for (let y = 0; y < h; y++) {
    const runs: number[] = [], starts: number[] = [];
    let v = bin[y * w], n = 0, st = 0;
    for (let x = 0; x <= w; x++) {
      const c = x < w ? bin[y * w + x] : -1;
      if (c === v) { n++; continue; }
      runs.push(n); starts.push(st); st = x; n = 1; v = c;
    }
    const firstDark = bin[y * w] === 1;
    for (let i = firstDark ? 0 : 1; i + 4 < runs.length; i += 2) {
      const r = runs.slice(i, i + 5);
      if (!fitRuns(r)) continue;
      const cx = Math.round(starts[i + 2] + r[2] / 2);
      let ok = 1, ycen = y;
      const us = [(r[0] + r[1] + r[2] + r[3] + r[4]) / 7];
      const vert = through(cx, y, 0, 1);
      if (vert) { ok++; us.push(vert.u); ycen = y + vert.off; }
      for (const [dx, dy] of [[1, 1], [1, -1]]) {
        const d = through(cx, Math.round(ycen), dx, dy);
        if (d) { ok++; us.push(d.u); }
      }
      if (ok >= 3) hits.push({ x: cx, y: ycen, u: us.reduce((a, b) => a + b, 0) / us.length });
    }
  }
  // one finder is crossed by many rows: cluster
  const clusters: { x: number; y: number; u: number; n: number }[] = [];
  for (const p of hits) {
    const c = clusters.find((q) => Math.hypot(q.x / q.n - p.x, q.y / q.n - p.y) < 2.5 * p.u);
    if (c) { c.x += p.x; c.y += p.y; c.u += p.u; c.n++; } else clusters.push({ x: p.x, y: p.y, u: p.u, n: 1 });
  }
  return clusters.filter((c) => c.n >= 2).map((c) => ({ x: c.x / c.n, y: c.y / c.n, m: c.u / c.n, n: c.n })).sort((a, b) => b.n - a.n).slice(0, 12);
}

// (top-left, top-right, bottom-left) triples: two equal sides at a right angle, similar module sizes; best first
function triples(fs: Finder[]): Triple[] {
  const out: Triple[] = [];
  for (let i = 0; i < fs.length; i++) for (let j = 0; j < fs.length; j++) for (let k = j + 1; k < fs.length; k++) {
    if (i === j || i === k) continue;
    const A = fs[i], B = fs[j], C = fs[k];
    if (Math.max(A.m, B.m, C.m) / Math.min(A.m, B.m, C.m) > 1.6) continue;
    const dAB = Math.hypot(B.x - A.x, B.y - A.y), dAC = Math.hypot(C.x - A.x, C.y - A.y), dBC = Math.hypot(C.x - B.x, C.y - B.y);
    const err = Math.abs(dAB - dAC) / Math.max(dAB, dAC);
    if (err > 0.25 || Math.abs(dBC / ((dAB + dAC) / 2) - Math.SQRT2) > 0.25) continue;
    const m = (A.m + B.m + C.m) / 3;
    if ((dAB + dAC) / 2 / m < 10) continue;
    // with y pointing down, (TR - TL) x (BL - TL) > 0
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    out.push({ TL: A, TR: cross > 0 ? B : C, BL: cross > 0 ? C : B, m, d: (dAB + dAC) / 2, err });
  }
  return out.sort((a, b) => a.err - b.err);
}

// standard value of a function module (1 dark, 0 light), or null for data, format and version modules
function functionModule(version: number, N: number, r: number, c: number): number | null {
  for (const [r0, c0] of [[0, 0], [0, N - 7], [N - 7, 0]]) {
    if (r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7) {
      const rr = r - r0, cc = c - c0;
      return rr === 0 || rr === 6 || cc === 0 || cc === 6 || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4) ? 1 : 0;
    }
  }
  if ((r === 7 && (c <= 7 || c >= N - 8)) || (c === 7 && (r <= 7 || r >= N - 8)) || (r === N - 8 && c <= 7) || (c === N - 8 && r <= 7)) return 0;
  if (r === N - 8 && c === 8) return 1;
  if (r === 6 && c >= 8 && c <= N - 9) return c % 2 === 0 ? 1 : 0;
  if (c === 6 && r >= 8 && r <= N - 9) return r % 2 === 0 ? 1 : 0;
  const pos = ALIGN[version] ?? [];
  const last = pos[pos.length - 1];
  for (const ar of pos) for (const ac of pos) {
    if ((ar === 6 && ac === 6) || (ar === 6 && ac === last) || (ar === last && ac === 6)) continue;
    if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return Math.max(Math.abs(r - ar), Math.abs(c - ac)) === 1 ? 0 : 1;
  }
  return null;
}

// homography from four point pairs (module coordinates to image), by Gaussian elimination
function homography(src: [number, number][], dst: Point[]): Map | null {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], { x, y } = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const H = b.map((x, i) => x / A[i][i]);
  return (u, v) => { const z = H[6] * u + H[7] * v + 1; return { x: (H[0] * u + H[1] * v + H[2]) / z, y: (H[3] * u + H[4] * v + H[5]) / z }; };
}

export interface GridResult { text: string; points: Point[] }

// Tries up to `maxTriples` finder triples; returns the first code that decodes, in the coordinates of `image`.
export async function gridRepair(image: GrayImage, maxTriples = 6): Promise<GridResult | null> {
  const { width: w, height: h, data } = image;
  const bin = binarize(image, Math.max(6, Math.round(Math.min(w, h) / 30)), 3);
  const value = (x: number, y: number) => {
    const xi = Math.min(w - 2, Math.max(0, Math.floor(x))), yi = Math.min(h - 2, Math.max(0, Math.floor(y)));
    const fx = x - xi, fy = y - yi, p = (a: number, b: number) => data[b * w + a];
    return (1 - fy) * ((1 - fx) * p(xi, yi) + fx * p(xi + 1, yi)) + fy * ((1 - fx) * p(xi, yi + 1) + fx * p(xi + 1, yi + 1));
  };
  const sampler = (map: Map) => (r: number, c: number) => {
    let s = 0;
    for (const a of [0.3, 0.5, 0.7]) for (const b of [0.3, 0.5, 0.7]) { const p = map(c + a, r + b); s += value(p.x, p.y); }
    return s / 9;
  };
  // midpoint of the finders' dark centres and light rings
  const thresholdFor = (N: number, map: Map) => {
    let dark = 0, light = 0;
    for (const [u0, v0] of [[0, 0], [N - 7, 0], [0, N - 7]]) {
      const p = map(u0 + 3.5, v0 + 3.5);
      dark += value(p.x, p.y) / 3;
      for (const [du, dv] of [[1.5, 3.5], [5.5, 3.5], [3.5, 1.5], [3.5, 5.5]]) { const q = map(u0 + du, v0 + dv); light += value(q.x, q.y) / 12; }
    }
    return (dark + light) / 2;
  };
  const timing = (N: number, sample: (r: number, c: number) => number, thr: number) => {
    let match = 0, total = 0;
    for (let k = 8; k <= N - 9; k++) {
      total += 2;
      if ((sample(6, k) < thr ? 1 : 0) === (k % 2 === 0 ? 1 : 0)) match++;
      if ((sample(k, 6) < thr ? 1 : 0) === (k % 2 === 0 ? 1 : 0)) match++;
    }
    return match / total;
  };
  for (const t of triples(scanFinders(bin, w, h)).slice(0, maxTriples)) {
    const affine = (N: number): Map => {
      const span = N - 7; // finder centres sit 3.5 modules in from the sides
      return (u, v) => ({
        x: t.TL.x + ((t.TR.x - t.TL.x) * (u - 3.5) + (t.BL.x - t.TL.x) * (v - 3.5)) / span,
        y: t.TL.y + ((t.TR.y - t.TL.y) * (u - 3.5) + (t.BL.y - t.TL.y) * (v - 3.5)) / span,
      });
    };
    // the size: every version in reach, chosen by how well the timing patterns alternate
    const estimate = t.d / t.m + 7;
    let best: { N: number; map: Map; thr: number; score: number } | null = null;
    for (let version = 1; version <= 20; version++) {
      const N = 4 * version + 17;
      if (Math.abs(N - estimate) > Math.max(8, estimate * 0.3)) continue;
      const map = affine(N), thr = thresholdFor(N, map), score = timing(N, sampler(map), thr);
      if (!best || score > best.score) best = { N, map, thr, score };
    }
    if (!best || best.score < 0.75) continue;
    const { N, thr } = best, version = (N - 17) / 4;
    // perspective: move the virtual fourth finder centre by up to 2 modules and keep the grids that sample the
    // modules most sharply (a grid on the modules samples clean dark and light, a shifted grid samples their edges)
    const sharpness = (map: Map) => { let s = 0; for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const p = map(c + 0.5, r + 0.5); s += Math.abs(value(p.x, p.y) - thr); } return s; };
    const maps: Map[] = [best.map];
    const a = N - 3.5, pred = best.map(a, a);
    const ux = { x: (t.TR.x - t.TL.x) / (N - 7), y: (t.TR.y - t.TL.y) / (N - 7) }, vy = { x: (t.BL.x - t.TL.x) / (N - 7), y: (t.BL.y - t.TL.y) / (N - 7) };
    const s0 = sharpness(best.map);
    const shifted: { map: Map; sharp: number }[] = [];
    for (let dv = -2; dv <= 2; dv += 0.5) for (let du = -2; du <= 2; du += 0.5) {
      if (du === 0 && dv === 0) continue;
      const map = homography([[3.5, 3.5], [N - 3.5, 3.5], [3.5, N - 3.5], [a, a]], [t.TL, t.TR, t.BL, { x: pred.x + du * ux.x + dv * vy.x, y: pred.y + du * ux.y + dv * vy.y }]);
      if (map) shifted.push({ map, sharp: sharpness(map) });
    }
    shifted.sort((p, q) => q.sharp - p.sharp);
    for (const s of shifted.slice(0, 3)) if (s.sharp > s0) maps.push(s.map);
    for (const map of maps) {
      const sample = sampler(map), th = thresholdFor(N, map);
      const raw: number[][] = [];
      for (let r = 0; r < N; r++) { raw.push([]); for (let c = 0; c < N; c++) raw[r].push(sample(r, c)); }
      // two readings of the samples: the finder threshold, and the darker of it and the module's 7 x 7 neighbourhood mean
      const local = (r: number, c: number) => {
        let s = 0, n = 0;
        for (let rr = Math.max(0, r - 3); rr <= Math.min(N - 1, r + 3); rr++) for (let cc = Math.max(0, c - 3); cc <= Math.min(N - 1, c + 3); cc++) { s += raw[rr][cc]; n++; }
        return Math.min(th + 20, s / n);
      };
      for (const cut of [(_r: number, _c: number) => th, local]) {
        const M = 6, W = (N + 8) * M, d = new Uint8ClampedArray(W * W).fill(255);
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          const f = functionModule(version, N, r, c);
          if (!(f === null ? raw[r][c] < cut(r, c) : f === 1)) continue;
          for (let y = 0; y < M; y++) d.fill(0, ((r + 4) * M + y) * W + (c + 4) * M, ((r + 4) * M + y) * W + (c + 5) * M);
        }
        const found = await decode(toRGBA({ data: d, width: W, height: W }), { formats: ['QR_CODE'], pure: true, one: true });
        if (found.length) return { text: found[0].text, points: [map(0, 0), map(N, 0), map(N, N), map(0, N)] };
      }
    }
  }
  return null;
}
