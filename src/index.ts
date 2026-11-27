import { Box, GrayImage, Point, binarize, boundsOf, clahe, clearEdgeBands, crop, fillHighlights, fillHoles, flatField, fromRotated, gamma, grayFromRGBA, isRGBA, normalize, openDark, removeThinLines, rotate, scale, shrink, tiles, toRGBA } from './image.js';
import { CodeFormat, DEFAULT_FORMATS, DecodeOptions, decode as decodeAll } from './decode.js';
import { gridRepair } from './grid.js';
import { gridQR, refitQR } from './refit.js';

export type { CodeFormat } from './decode.js';
export { ALL_FORMATS, DEFAULT_FORMATS } from './decode.js';
export type { GrayImage, Point } from './image.js';
export { grayFromRGBA } from './image.js';
export { prepare } from './decode.js';
export type { PrepareOptions } from './decode.js';
export { CameraScanner } from './camera.js';
export type { CameraScannerOptions, StartOptions } from './camera.js';

export interface ScanResult {
  text: string;
  format: CodeFormat;
  points: Point[];
  pass: string;
  // time from the start of the scan until this code was found
  elapsedMs: number;
}

export interface ScanOptions {
  // 'first' stops at the first valid code, 'all' collects every code it can find
  mode?: 'first' | 'all';
  isValid?: (text: string, format: CodeFormat) => boolean;
  // no new pass starts after this many milliseconds; a pass that has started runs to its end
  budgetMs?: number;
  // the code formats to read; default QR_CODE and DATA_MATRIX (DEFAULT_FORMATS). Every extra format costs time and
  // adds a chance of false reads, so list only what you expect.
  formats?: CodeFormat[];
}

export interface ScanOutput {
  results: ScanResult[];
  elapsedMs: number;
}

// A view is the image, or a part of it, prepared for one decode.
interface View {
  image: GrayImage;
  // a point found in `image`, in the coordinates of the image that was scanned
  toImage: (point: Point) => Point;
}

// Partner formats on one label: a QR code and a Data Matrix code with the same text.
const other: Partial<Record<CodeFormat, CodeFormat>> = { QR_CODE: 'DATA_MATRIX', DATA_MATRIX: 'QR_CODE' };

// Large photos are read first at a reduced size with a shorter side of at least this many pixels: 1/2 for a
// 1772 px photo, 1/3 for a 12-megapixel one. A label photographed with a phone fills enough of the photo that the reduced view
// reads most codes, in a fraction of the time.
const reducedSide = 800;

// Codes found in the reduced view with a longer side below this (in pixels of the scanned image) still get the
// full-size pass, because smaller codes nearby may only be readable there.
const smallCode = 300;

// The refit pass resamples at most this many located QR symbols per scan (about 20 ms each).
const maxRefits = 10;


// Accepts a gray image (one byte per pixel) or an RGBA image (four bytes per pixel, as in a canvas ImageData).
// The image is never modified.
export async function scan(image: GrayImage, options: ScanOptions = {}): Promise<ScanOutput> {
  const start = performance.now();
  const elapsed = () => performance.now() - start;
  const mode = options.mode ?? 'first';
  const isValid = options.isValid ?? (() => true);
  const budget = options.budgetMs ?? Infinity;
  const results: ScanResult[] = [];
  const done = () => mode === 'first' && results.length > 0;
  const timeLeft = () => elapsed() < budget;
  // zxing-cpp can stop at its first code, but only when every code is acceptable
  const one = mode === 'first' && !options.isValid;
  // Every pass reads through `decode`, which keeps to the formats asked for. A pass that looks for one format
  // (the partner pass) reads nothing when that format was not asked for. The QR repair passes run only for QR codes.
  const formats = options.formats?.length ? options.formats : DEFAULT_FORMATS;
  const qr = formats.includes('QR_CODE');
  const decode: typeof decodeAll = async (image, o = {}) => {
    const wanted = o.formats ? o.formats.filter((f) => formats.includes(f)) : formats;
    return wanted.length ? decodeAll(image, { ...o, formats: wanted }) : [];
  };

  let grayImage: GrayImage | null = isRGBA(image) ? null : image;
  const gray = () => (grayImage ??= grayFromRGBA(image.data, image.width, image.height));
  const whole = (view: GrayImage): View => ({ image: view, toImage: (p) => p });

  const read = async (view: View, pass: string, decodeOptions: DecodeOptions = {}) => {
    const rgba = view.image === image && isRGBA(image) ? image : toRGBA(view.image);
    for (const found of await decode(rgba, { one, ...decodeOptions })) {
      const points = found.points.map(view.toImage);
      if (!isValid(found.text, found.format) || results.some((r) => same(r, found.format, found.text, points))) {
        continue;
      }
      results.push({ text: found.text, format: found.format, points, pass, elapsedMs: elapsed() });
      if (done()) {
        return;
      }
    }
  };

  // 1. Reduced size, for large photos.
  const factor = Math.max(1, Math.floor(Math.min(image.width, image.height) / reducedSide));
  const large = factor > 1;
  let reduced: GrayImage | null = null;
  const base = () => (reduced ??= large ? shrink(gray(), factor) : gray());
  if (large) {
    await read(scaled(base(), factor), 'reduced');
  }

  // Partner: the other code of a tag next to a code that was read. An asset label often carries a QR code and a Data Matrix
  // code with the same text, within about one tag length of each other. A full-resolution window around the found
  // code, enlarged, gives zxing-cpp the small or blurred partner at a readable size. 'all' mode only.
  const tried = new Set<ScanResult>();
  const partners = async () => {
    if (mode !== 'all') {
      return;
    }
    for (const found of [...results]) {
      const partner = other[found.format];
      if (!partner || !timeLeft() || tried.has(found) || hasPartner(results, found)) {
        continue;
      }
      tried.add(found);
      const box = boundsOf(found.points, 1, image);
      await read(window(gray(), box, 900), 'partner', { formats: [partner], denoise: true });
    }
  };

  // 2. Partners of the codes found at reduced size.
  await partners();

  // 3. Full size: when nothing was found yet, or when a code still lacks its partner and is small enough that more
  // codes, or the partner itself, may only show at full resolution.
  const needFull = () => results.length === 0 || results.some((r) => !hasPartner(results, r) && longSide(r.points) < smallCode);
  if (!done() && timeLeft() && (!large || needFull())) {
    await read(whole(isRGBA(image) ? image : gray()), 'full');
    await partners();
  }

  // 4. Fallbacks, only when nothing was found, in the order they paid off on photos of asset labels: worn or unevenly lit
  // codes (local contrast), codes at angles the detectors miss, and light-on-dark codes.
  // Large photos use the reduced view here, so each fallback costs about 15 to 30 ms.
  const fallbacks: [string, () => View | null, DecodeOptions][] = [
    ['normalized', () => scaled(normalize(base(), Math.max(8, Math.round(Math.min(base().width, base().height) / 70))), factor), { binarizer: 'fixed' }],
    ['rotated-45', () => turned(base(), 45, factor), { binarizer: 'fixed' }],
    ['inverted', () => scaled(invert(base()), factor), {}],
  ];
  for (const [pass, view, decodeOptions] of fallbacks) {
    if (results.length > 0 || !timeLeft()) {
      break;
    }
    const v = view();
    if (v) {
      await read(v, pass, decodeOptions);
    }
  }

  // 5. Extended passes, after the fallbacks and cheapest first. In 'first' mode they run only when nothing was found.
  // In 'all' mode they always run: on the benchmark photos the codes they find sit next to codes the earlier passes
  // read about as often as on their own.
  const readEach = async (views: View[], pass: string, decodeOptions: DecodeOptions = {}) => {
    for (const view of views) {
      if (done() || !timeLeft()) {
        return;
      }
      await read(view, pass, decodeOptions);
    }
  };
  const extended: [string, () => Promise<void>][] = [
    // Dark codes, cheaply: gamma 0.5 on the reduced view (the whole image when it is small).
    ['gamma', () => readEach([scaled(gamma(base(), 0.5), factor)], 'gamma')],
    // Codes at angles the detectors miss, next to rotated-45: the reduced view turned 30 degrees.
    ['rotated-30', () => readEach([turned(base(), 30, factor)], 'rotated-30')],
    // Codes the local threshold breaks up: the full-size photo with the global-histogram threshold, denoised.
    ['global-denoise', () => readEach([whole(gray())], 'global-denoise', { binarizer: 'global', denoise: true })],
    // Small images with small codes: the whole image enlarged 2x (only up to a longer side of 2100 px).
    ['upscale-2', () => (Math.max(image.width, image.height) * 2 > 2100 ? Promise.resolve() : readEach([{ image: scale(gray(), 2), toImage: (p) => ({ x: (p.x + 0.5) / 2 - 0.5, y: (p.y + 0.5) / 2 - 0.5 }) }], 'upscale-2'))],
    // Very dark codes: gamma 0.5 spreads the dark gray levels, and 2 x 2 overlapping tiles of the full-size image,
    // each enlarged to 1000 px, give small codes more pixels per module; denoised.
    ['gamma-tiles', () => { const g = gamma(gray(), 0.5); return readEach(tiles(g.width, g.height, 2).map((box) => window(g, box, 1000)), 'gamma-tiles', { denoise: true }); }],
    // Faint or unevenly lit codes: CLAHE (8 x 8 tiles, clip 3) on the full-size photo.
    ['clahe', () => readEach([whole(clahe(gray(), 8, 3))], 'clahe')],
    // Symbols zxing-cpp found but could not decode: a window 1.6 times the symbol, enlarged to 600 px, read as it is,
    // with gamma 0.5, with CLAHE, denoised and with the global-histogram threshold, until one reads.
    ['located', () => located()],
    // Glare and uneven light: specular highlights filled from their surroundings, then flat-field corrected, on the
    // reduced view (the whole image when it is small), global-histogram threshold.
    ['highlights', () => { const b = base(); const m = Math.min(b.width, b.height); return readEach([scaled(flatField(fillHighlights(b, 235, Math.max(3, Math.round(m / 60))), Math.max(4, Math.round(m / 20))), factor)], 'highlights', { binarizer: 'global' }); }],
    // Small codes in large photos, the most expensive pass, so the last: 3 x 3 overlapping tiles of the full-size photo, enlarged to 1000 px, denoised.
    ['tiles-3', () => { const g = gray(); return readEach(tiles(g.width, g.height, 3).map((box) => window(g, box, 1000)), 'tiles-3', { denoise: true }); }],
  ];
  const located = async () => {
    const symbols: Point[][] = [];
    const failedQR: { points: Point[]; symbol: Uint8Array[]; version: number }[] = [];
    const collect = async (view: View, viewOptions: DecodeOptions) => {
      for (const found of await decode(toRGBA(view.image), { located: true, ...viewOptions })) {
        if (found.error) {
          const points = found.points.map(view.toImage);
          symbols.push(points);
          if (found.format === 'QR_CODE' && /checksum/i.test(found.error) && found.symbol && found.version) {
            failedQR.push({ points, symbol: found.symbol, version: found.version });
          }
        }
      }
    };
    for (const view of large ? [scaled(base(), factor), whole(gray())] : [whole(gray())]) {
      await collect(view, {});
    }
    const g = gray();
    // Refit first: QR symbols with a checksum error, resampled on a grid fitted to their function patterns (refit.ts).
    // At most `maxRefits` symbols, and none next to a code that was already read.
    let refits = 0;
    let unread = 0;
    const refitAll = async (from: number) => {
      for (const f of failedQR.slice(from)) {
        if (done() || !timeLeft() || refits >= maxRefits) {
          return;
        }
        const c = centre(f.points);
        const b = boundsOf(f.points, 0, image);
        const near = (r: ScanResult) => { const q = centre(r.points); return Math.abs(q.x - c.x) < b.width / 2 && Math.abs(q.y - c.y) < b.height / 2; };
        if (results.some(near)) {
          continue;
        }
        refits++;
        const out = await refitQR(g, f.points, f.symbol, f.version);
        if (out && isValid(out.text, 'QR_CODE') && !results.some((r) => same(r, 'QR_CODE', out.text, out.points))) {
          results.push({ text: out.text, format: 'QR_CODE', points: out.points, pass: 'refit', elapsedMs: elapsed() });
        } else {
          unread++;
        }
      }
    };
    await refitAll(0);
    // A QR symbol that still failed: the denoised full-size view (small gaps closed) gives zxing-cpp other corner
    // estimates to refit, and its located symbols join the windows below.
    if (unread > 0 && !done() && timeLeft()) {
      const from = failedQR.length;
      await collect(whole(g), { denoise: true });
      await refitAll(from);
    }
    const seen: Point[] = [];
    for (const points of symbols) {
      const b = boundsOf(points, 0, image);
      const c = centre(points);
      const side = 1.6 * Math.max(b.width, b.height, 16);
      const near = (p: Point, d: number) => Math.abs(p.x - c.x) < d && Math.abs(p.y - c.y) < d;
      if (seen.some((p) => near(p, side / 4)) || results.some((r) => near(centre(r.points), side / 3))) {
        continue;
      }
      seen.push(c);
      const left = Math.max(0, Math.floor(c.x - side / 2));
      const top = Math.max(0, Math.floor(c.y - side / 2));
      const w = window(g, { left, top, width: Math.max(2, Math.min(g.width, Math.ceil(c.x + side / 2)) - left), height: Math.max(2, Math.min(g.height, Math.ceil(c.y + side / 2)) - top) }, 600);
      const variants: [GrayImage, DecodeOptions][] = [[w.image, {}], [gamma(w.image, 0.5), {}], [clahe(w.image, 4, 3), {}], [w.image, { denoise: true }], [w.image, { binarizer: 'global' }]];
      for (const [variant, decodeOptions] of variants) {
        if (done() || !timeLeft()) {
          return;
        }
        const before = results.length;
        await read({ image: variant, toImage: w.toImage }, 'located', decodeOptions);
        if (results.length > before) {
          break;
        }
      }
    }
  };
  for (const [, pass] of extended) {
    if ((mode === 'first' && results.length > 0) || !timeLeft()) {
      break;
    }
    await pass();
  }
  // 6. Last resorts, only when every pass found nothing. They read codes no pass reads, so they come after all passes:
  // placed earlier, they cost their time on images a later pass reads anyway.
  const lastResorts: [string, () => View | null, DecodeOptions][] = [
    // A dark band or frame at the image edge that touches the code: painted white, with a white margin added.
    // Skipped (null) when no edge is dark.
    ['edge-bands', () => { const c = clearEdgeBands(base(), 0.1); return c && { image: c.image, toImage: (p) => ({ x: (p.x - c.offset) * factor, y: (p.y - c.offset) * factor }) }; }, {}],
    // Thin dark lines over the code (a printed grid, hairlines): removed with a 3 x 3 grey closing. Images up to
    // 1000 px only: in photos it found no code and cost about 100 ms per image without a read.
    ['thin-lines', () => (Math.max(image.width, image.height) > 1000 ? null : scaled(removeThinLines(base(), 1), factor)), {}],
    // A computer-made image of the code alone (up to 1000 px): pure mode samples the grid from the bounding box and
    // does not need intact finder patterns. Skipped for larger images.
    ['pure', () => (Math.max(image.width, image.height) > 1000 ? null : whole(gray())), { pure: true }],
  ];
  for (const [pass, view, decodeOptions] of lastResorts) {
    if (results.length > 0 || !timeLeft()) {
      break;
    }
    const v = view();
    if (v) {
      await read(v, pass, decodeOptions);
    }
  }

  // 7. Grid repair, the last resort when every pass found nothing: QR codes whose finder patterns zxing-cpp cannot
  // use (spread ink, a printed line or a bridge on a finder) although the data is within error correction. Own
  // tolerant finder search on the reduced view, grid fit, function patterns reset, clean redraw for zxing-cpp.
  if (qr && results.length === 0 && timeLeft()) {
    const found = await gridRepair(base());
    if (found && isValid(found.text, 'QR_CODE')) {
      results.push({ text: found.text, format: 'QR_CODE', points: found.points.map((p) => ({ x: p.x * factor, y: p.y * factor })), pass: 'grid-repair', elapsedMs: elapsed() });
    }
  }

  // 8. Morphology and the bounding-box grid, after grid repair and only when nothing was found: codes whose finder
  // patterns are broken by a printed defect (the public set's synthetic "pathological" codes). Pixel-scale morphology
  // only makes sense on a two-tone image (a rendered or cleanly scanned code), so it runs only when under 10% of the
  // reduced view's pixels are mid-tones (41 to 214); photos have 28% or more. Otsu-binarized reduced view.
  if (results.length === 0 && timeLeft() && midTones(base()) < 0.1) {
    const b = base();
    const views: [string, () => GrayImage][] = [
      // holes in finder centres closed: thin dark lines opened away first (3 x 3 square), then enclosed white
      // regions up to 1.5 module areas filled
      ['fill-holes', () => fillHoles(openDark(binarize(b), 1), 'module')],
    ];
    for (const [pass, view] of views) {
      if (results.length > 0 || !timeLeft()) {
        break;
      }
      await read(scaled(view(), factor), pass, { binarizer: 'fixed' });
    }
    // The code as the only dark structure: its bounding box gives the corners of an upright symbol, read as a grid.
    if (results.length === 0 && timeLeft()) {
      const box = darkBounds(binarize(b));
      if (box) {
        const corners = [{ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom }];
        const out = await gridQR(b, corners);
        if (out && isValid(out.text, 'QR_CODE')) {
          results.push({ text: out.text, format: 'QR_CODE', points: out.points.map((q) => ({ x: q.x * factor, y: q.y * factor })), pass: 'bbox-grid', elapsedMs: elapsed() });
        }
      }
    }
  }

  return { results, elapsedMs: elapsed() };
}

function hasPartner(results: ScanResult[], code: ScanResult): boolean {
  return results.some((r) => r.format === other[code.format] && r.text === code.text);
}

function longSide(points: Point[]): number {
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    best = Math.max(best, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return best;
}

// The same code found twice: same format and text, and the centre of one inside the bounds of the other.
// Two tags with the same text at different places stay two results.
function same(result: ScanResult, format: CodeFormat, text: string, points: Point[]): boolean {
  if (result.format !== format || result.text !== text) {
    return false;
  }
  const c = centre(points);
  const b = boundsOf(result.points, 0.25, { width: Infinity, height: Infinity });
  return c.x >= b.left && c.x <= b.left + b.width && c.y >= b.top && c.y <= b.top + b.height;
}

// bounding box of the black pixels of a binarized image (right and bottom exclusive), or null when there are none
function darkBounds(image: GrayImage): { left: number; top: number; right: number; bottom: number } | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[y * image.width + x] === 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

// share of pixels that are neither near black nor near white
function midTones(image: GrayImage): number {
  let k = 0;
  for (let i = 0; i < image.data.length; i++) {
    const v = image.data[i];
    if (v > 40 && v < 215) {
      k++;
    }
  }
  return k / image.data.length;
}

function centre(points: Point[]): Point {
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}

// The box cut out of `image` and scaled so its longer side is `side` pixels (never shrunk, at most 3x enlarged).
function window(image: GrayImage, box: Box, side: number): View {
  const part = crop(image, box);
  const factor = Math.min(3, Math.max(1, side / Math.max(part.width, part.height, 1)));
  const view = factor > 1.05 ? scale(part, factor) : part;
  const f = view === part ? 1 : factor;
  return { image: view, toImage: (p) => ({ x: box.left + (p.x + 0.5) / f - 0.5, y: box.top + (p.y + 0.5) / f - 0.5 }) };
}

// A view of the whole image at reduced size; `factor` maps its coordinates back (2 for a half-size view).
function scaled(image: GrayImage, factor: number): View {
  return { image, toImage: (p) => ({ x: p.x * factor, y: p.y * factor }) };
}

// `image` turned by `degrees`; `factor` maps its coordinates back to the scanned image (2 for a half-size view).
function turned(image: GrayImage, degrees: number, factor: number): View {
  const view = rotate(image, degrees);
  return { image: view, toImage: (p) => {
    const q = fromRotated(p, degrees, image, view);
    return { x: q.x * factor, y: q.y * factor };
  } };
}

function invert(image: GrayImage): GrayImage {
  return { data: image.data.map((v) => 255 - v), width: image.width, height: image.height };
}
