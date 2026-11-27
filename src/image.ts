export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Four bytes per pixel, as in a canvas ImageData. zxing-wasm reads this layout.
export type RGBAImage = GrayImage;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const isRGBA = (image: GrayImage): boolean => image.data.length === image.width * image.height * 4;

// Same weights and rounding as ZXing's canvas luminance source; fully transparent pixels count as white.
export function grayFromRGBA(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) {
    data[j] = rgba[i + 3] === 0 ? 0xff : (306 * rgba[i] + 601 * rgba[i + 1] + 117 * rgba[i + 2] + 0x200) >> 10;
  }
  return { data, width, height };
}

// Gray to RGBA, one 32-bit write per pixel.
export function toRGBA(image: GrayImage): RGBAImage {
  const n = image.width * image.height;
  const buffer = new ArrayBuffer(n * 4);
  const words = new Uint32Array(buffer);
  const src = image.data;
  for (let i = 0; i < n; i++) {
    words[i] = 0xff000000 | (src[i] * 0x010101); // the same in either byte order
  }
  return { data: new Uint8ClampedArray(buffer), width: image.width, height: image.height };
}

// 1/n size: each n x n block becomes its mean.
export function shrink(image: GrayImage, n: number): GrayImage {
  const width = Math.floor(image.width / n);
  const height = Math.floor(image.height / n);
  const w = image.width;
  const src = image.data;
  const data = new Uint8ClampedArray(width * height);
  if (n === 2) {
    // the common case, unrolled: about 2 ms for a 3-megapixel photo
    for (let y = 0; y < height; y++) {
      let i = 2 * y * w;
      let j = y * width;
      for (let x = 0; x < width; x++, i += 2, j++) {
        data[j] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1] + 2) >> 2;
      }
    }
    return { data, width, height };
  }
  const area = n * n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < n; dy++) {
        const row = (y * n + dy) * w + x * n;
        for (let dx = 0; dx < n; dx++) {
          sum += src[row + dx];
        }
      }
      data[y * width + x] = (sum + (area >> 1)) / area;
    }
  }
  return { data, width, height };
}

export function crop(image: GrayImage, box: Box): GrayImage {
  if (box.left === 0 && box.top === 0 && box.width === image.width && box.height === image.height) {
    return image;
  }
  const data = new Uint8ClampedArray(box.width * box.height);
  for (let y = 0; y < box.height; y++) {
    const start = (box.top + y) * image.width + box.left;
    data.set(image.data.subarray(start, start + box.width), y * box.width);
  }
  return { data, width: box.width, height: box.height };
}

// Bounding box of the points, grown by `margin` times its larger side on every edge, clipped to the image.
export function boundsOf(points: Point[], margin: number, image: Size): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const grow = margin * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const left = Math.max(0, Math.floor(Math.min(...xs) - grow));
  const top = Math.max(0, Math.floor(Math.min(...ys) - grow));
  const right = Math.min(image.width, Math.ceil(Math.max(...xs) + grow));
  const bottom = Math.min(image.height, Math.ceil(Math.max(...ys) + grow));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Any size by bilinear sampling. Used to enlarge small codes so their modules are several pixels wide.
export function scale(image: GrayImage, factor: number): GrayImage {
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const w = image.width;
  const src = image.data;
  const data = new Uint8ClampedArray(width * height);
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(maxY, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(maxY, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(maxX, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(maxX, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx;
      const bottom = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
      data[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { data, width, height };
}

// Turns clockwise about the centre by `degrees` onto a canvas big enough for the whole image, white around it.
export function rotate(image: GrayImage, degrees: number): GrayImage {
  const { cos, sin } = turn(degrees);
  const width = Math.ceil(Math.abs(image.width * cos) + Math.abs(image.height * sin) - 1e-9);
  const height = Math.ceil(Math.abs(image.width * sin) + Math.abs(image.height * cos) - 1e-9);
  const data = new Uint8ClampedArray(width * height).fill(255);
  const src = image.data;
  const w = image.width;
  const h = image.height;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 255 : src[y * w + x]);
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - height / 2;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - width / 2;
      const sx = dx * cos + dy * sin + w / 2 - 0.5;
      const sy = -dx * sin + dy * cos + h / 2 - 0.5;
      if (sx <= -1 || sy <= -1 || sx >= w || sy >= h) {
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      data[y * width + x] =
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    }
  }
  return { data, width, height };
}

// A point found in `rotate(original, degrees)` (which has the size `rotated`) in the coordinates of `original`.
export function fromRotated(point: Point, degrees: number, original: Size, rotated: Size): Point {
  const { cos, sin } = turn(degrees);
  const dx = point.x + 0.5 - rotated.width / 2;
  const dy = point.y + 0.5 - rotated.height / 2;
  return { x: dx * cos + dy * sin + original.width / 2 - 0.5, y: -dx * sin + dy * cos + original.height / 2 - 0.5 };
}

function turn(degrees: number): { cos: number; sin: number } {
  const radians = (degrees * Math.PI) / 180;
  return { cos: Math.cos(radians), sin: Math.sin(radians) };
}

// Local contrast: each pixel relative to the mean and spread of the (2r+1) x (2r+1) window around it.
// Worn, engraved or unevenly lit codes get even contrast everywhere. Sums come from integral images.
export function normalize(image: GrayImage, r: number): GrayImage {
  const { width: w, height: h, data: src } = image;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      rowSum += v;
      rowSq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rowSum;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rowSq;
    }
  }
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      const s2 = sq[y1 * W + x1] - sq[y0 * W + x1] - sq[y1 * W + x0] + sq[y0 * W + x0];
      const mean = s / n;
      const variance = Math.max(0, s2 / n - mean * mean);
      data[y * w + x] = 128 + (60 * (src[y * w + x] - mean)) / Math.sqrt(variance + 25);
    }
  }
  return { data, width: w, height: h };
}

// Tone curve v' = 255 * (v / 255) ^ g. With g = 0.5 dark tones spread out (16 -> 64, 64 -> 128), so a code that sits
// in a few dark gray levels gets contrast the binarizer can use; black and white stay as they are.
export function gamma(image: GrayImage, g: number): GrayImage {
  const table = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    table[v] = 255 * Math.pow(v / 255, g);
  }
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = table[image.data[i]];
  }
  return { data, width: image.width, height: image.height };
}

// An n x n grid of boxes over an image of the given size, each 1.3 times a grid cell, so neighbouring boxes overlap
// by 30% and a code on a cell border lies whole in one box. Column by column, top to bottom.
export function tiles(width: number, height: number, n: number): Box[] {
  const w = Math.min(width, Math.ceil((width / n) * 1.3));
  const h = Math.min(height, Math.ceil((height / n) * 1.3));
  const boxes: Box[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const left = n > 1 ? Math.round((a * (width - w)) / (n - 1)) : 0;
      const top = n > 1 ? Math.round((b * (height - h)) / (n - 1)) : 0;
      boxes.push({ left, top, width: w, height: h });
    }
  }
  return boxes;
}

// Contrast-limited adaptive histogram equalization (CLAHE): a tiles x tiles grid, each tile's histogram clipped at
// `clip` times the mean bin height (the excess spread evenly over all bins), equalized, and the tile maps blended
// bilinearly. Faint codes and unevenly lit ones get contrast without one bright area deciding for the whole image.
export function clahe(image: GrayImage, tiles: number, clip: number): GrayImage {
  const { width: w, height: h, data } = image;
  const tw = Math.ceil(w / tiles);
  const th = Math.ceil(h / tiles);
  const maps: Uint8ClampedArray[] = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const hist = new Float64Array(256);
      let n = 0;
      for (let y = ty * th; y < Math.min(h, (ty + 1) * th); y++) {
        for (let x = tx * tw; x < Math.min(w, (tx + 1) * tw); x++) {
          hist[data[y * w + x]]++;
          n++;
        }
      }
      const limit = Math.max(1, (clip * n) / 256);
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const map = new Uint8ClampedArray(256);
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        sum += hist[i] + excess / 256;
        map[i] = n ? (255 * sum) / n : i;
      }
      maps.push(map);
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(tiles - 1, Math.max(0, (y + 0.5) / th - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(tiles - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(tiles - 1, Math.max(0, (x + 0.5) / tw - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(tiles - 1, x0 + 1);
      const fx = gx - x0;
      const v = data[y * w + x];
      const top = maps[y0 * tiles + x0][v] * (1 - fx) + maps[y0 * tiles + x1][v] * fx;
      const bottom = maps[y1 * tiles + x0][v] * (1 - fx) + maps[y1 * tiles + x1][v] * fx;
      out[y * w + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { data: out, width: w, height: h };
}

// Box blur of radius r, three passes (close to a Gaussian), on floating-point values; edges repeat the border pixel.
export function blurValues(values: ArrayLike<number>, width: number, height: number, r: number): Float32Array {
  let a = Float32Array.from(values);
  let b = new Float32Array(a.length);
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const lines = horizontal ? height : width;
    const n = horizontal ? width : height;
    for (let o = 0; o < lines; o++) {
      const at = (i: number) => {
        const k = Math.min(n - 1, Math.max(0, i));
        return horizontal ? src[o * width + k] : src[k * width + o];
      };
      let s = 0;
      for (let i = -r; i <= r; i++) {
        s += at(i);
      }
      for (let i = 0; i < n; i++) {
        dst[horizontal ? o * width + i : i * width + o] = s / (2 * r + 1);
        s += at(i + r + 1) - at(i - r);
      }
    }
  };
  for (let p = 0; p < 3; p++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

// Specular highlights: pixels at `threshold` or brighter are replaced by the average of the unsaturated pixels around
// them (normalized convolution with a blur of radius r); all other pixels stay as they are.
export function fillHighlights(image: GrayImage, threshold: number, r: number): GrayImage {
  const n = image.data.length;
  const mask = new Float32Array(n);
  const masked = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (image.data[i] < threshold) {
      mask[i] = 1;
      masked[i] = image.data[i];
    } else {
      any = true;
    }
  }
  if (!any) {
    return image;
  }
  const weight = blurValues(mask, image.width, image.height, r);
  const sum = blurValues(masked, image.width, image.height, r);
  const data = Uint8ClampedArray.from(image.data);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) {
      data[i] = weight[i] > 0.02 ? sum[i] / weight[i] : 128;
    }
  }
  return { data, width: image.width, height: image.height };
}

// Flat-field correction: each pixel divided by a heavily blurred copy (radius r), which evens out broad shading.
export function flatField(image: GrayImage, r: number): GrayImage {
  const background = blurValues(image.data, image.width, image.height, r);
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = (170 * image.data[i]) / (background[i] + 8);
  }
  return { data, width: image.width, height: image.height };
}

// Quiet-zone repair. A QR finder pattern is only recognised with light around it; a dark band or frame that runs into
// the code at the image edge hides it. Rows and columns at the edges that are almost entirely dark (at least 90% of
// their pixels below the image mean, at most a quarter of the side from each edge) are painted white, and a white
// margin of `margin` times the longer side is added around the image. Returns null when no edge is dark, so the pass
// costs nothing on ordinary photos. A point (x, y) in the result is (x - offset, y - offset) in `image`.
export function clearEdgeBands(image: GrayImage, margin: number): { image: GrayImage; offset: number } | null {
  const { width: w, height: h, data: src } = image;
  let total = 0;
  for (let i = 0; i < src.length; i++) {
    total += src[i];
  }
  const mean = total / src.length;
  const darkRow = (y: number) => {
    let n = 0;
    for (let x = 0; x < w; x++) n += src[y * w + x] < mean ? 1 : 0;
    return n >= 0.9 * w;
  };
  const darkColumn = (x: number) => {
    let n = 0;
    for (let y = 0; y < h; y++) n += src[y * w + x] < mean ? 1 : 0;
    return n >= 0.9 * h;
  };
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  while (top < h / 4 && darkRow(top)) top++;
  while (bottom < h / 4 && darkRow(h - 1 - bottom)) bottom++;
  while (left < w / 4 && darkColumn(left)) left++;
  while (right < w / 4 && darkColumn(w - 1 - right)) right++;
  if (top + bottom + left + right === 0) {
    return null;
  }
  const offset = Math.round(margin * Math.max(w, h));
  const W = w + 2 * offset;
  const H = h + 2 * offset;
  const data = new Uint8ClampedArray(W * H).fill(255);
  for (let y = top; y < h - bottom; y++) {
    data.set(src.subarray(y * w + left, y * w + w - right), (y + offset) * W + offset + left);
  }
  return { image: { data, width: W, height: H }, offset };
}

// Thin dark lines (a printed grid, scratches, hairlines) removed: a grey closing, the 3 x 3 maximum (r = 1) and then
// the minimum of that. Dark structures thinner than 2r + 1 pixels vanish; modules wider than that keep their size.
export function removeThinLines(image: GrayImage, r: number): GrayImage {
  const pass = (src: Uint8ClampedArray, w: number, h: number, max: boolean, horizontal: boolean) => {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = max ? 0 : 255;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          const s = src[yy * w + xx];
          v = max ? (s > v ? s : v) : (s < v ? s : v);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  const { width: w, height: h } = image;
  const lighter = pass(pass(image.data, w, h, true, true), w, h, true, false);
  return { data: pass(pass(lighter, w, h, false, true), w, h, false, false), width: w, height: h };
}

// Otsu's threshold of a gray image: the level that best separates dark from light (maximum between-class variance).
export function otsu(image: GrayImage): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < image.data.length; i++) {
    hist[image.data[i]]++;
  }
  const total = image.data.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    sum += v * hist[v];
  }
  let sumDark = 0;
  let nDark = 0;
  let best = 0;
  let level = 128;
  for (let v = 0; v < 256; v++) {
    nDark += hist[v];
    if (nDark === 0 || nDark === total) {
      continue;
    }
    sumDark += v * hist[v];
    const mDark = sumDark / nDark;
    const mLight = (sum - sumDark) / (total - nDark);
    const between = nDark * (total - nDark) * (mDark - mLight) ** 2;
    if (between > best) {
      best = between;
      level = v;
    }
  }
  return level;
}

// Black (0) and white (255) at Otsu's threshold.
export function binarize(image: GrayImage): GrayImage {
  const t = otsu(image);
  return { data: image.data.map((v) => (v <= t ? 0 : 255)), width: image.width, height: image.height };
}

// Fills white regions enclosed by black (not touching the image border) of at most `maxArea` pixels, in a binarized
// image. A finder pattern with a hole in its centre becomes whole again; white modules inside a code are filled too,
// so this view only serves codes whose finders were the problem.
export function fillHoles(image: GrayImage, maxArea: number | 'module'): GrayImage {
  const { width: w, height: h } = image;
  const data = Uint8ClampedArray.from(image.data);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const region: number[] = [];
  const enclosed: number[][] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || data[start] === 0) {
      continue;
    }
    stack.push(start);
    seen[start] = 1;
    region.length = 0;
    let border = false;
    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        border = true;
      }
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && data[j] !== 0) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (!border) {
      enclosed.push(region.slice());
    }
  }
  // 'module': the module area is taken as the smallest enclosed white size that occurs at least 3 times (single white
  // modules); holes up to 1.5 times that are filled
  let limit = typeof maxArea === 'number' ? maxArea : 0;
  if (maxArea === 'module') {
    const counts = new Map<number, number>();
    for (const r of enclosed) {
      counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    }
    const sizes = [...counts.entries()].filter(([s, c]) => c >= 3 && s >= 4).map(([s]) => s).sort((a, b) => a - b);
    limit = sizes.length ? Math.floor(1.5 * sizes[0]) : 0;
  }
  for (const r of enclosed) {
    if (r.length <= limit) {
      for (const i of r) {
        data[i] = 0;
      }
    }
  }
  return { data, width: w, height: h };
}

// Opening of the dark parts of a binarized image with a (2r+1) square: dark structures thinner than 2r+1 pixels
// (lines between modules) disappear, wider ones (modules) keep their shape.
export function openDark(image: GrayImage, r: number): GrayImage {
  // erosion of dark = maximum filter, dilation of dark = minimum filter (separable)
  const filter = (src: Uint8ClampedArray, w: number, h: number, take: (a: number, b: number) => number) => {
    const tmp = new Uint8ClampedArray(src.length);
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = src[y * w + x];
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
          v = take(v, src[y * w + k]);
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = tmp[y * w + x];
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
          v = take(v, tmp[k * w + x]);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  const { width: w, height: h } = image;
  if (r === 1) {
    return { data: minMax3(minMax3(image.data, w, h, true), w, h, false), width: w, height: h };
  }
  const eroded = filter(image.data, w, h, Math.max);
  return { data: filter(eroded, w, h, Math.min), width: w, height: h };
}

// 3 x 3 maximum (or minimum) filter, separable, without function calls in the inner loops
function minMax3(src: Uint8ClampedArray, w: number, h: number, max: boolean): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[row + (x > 0 ? x - 1 : x)];
      const b = src[row + x];
      const c = src[row + (x < w - 1 ? x + 1 : x)];
      tmp[row + x] = max ? (a > b ? (a > c ? a : c) : b > c ? b : c) : a < b ? (a < c ? a : c) : b < c ? b : c;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w;
    const row = y * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const a = tmp[up + x];
      const b = tmp[row + x];
      const c = tmp[down + x];
      out[row + x] = max ? (a > b ? (a > c ? a : c) : b > c ? b : c) : a < b ? (a < c ? a : c) : b < c ? b : c;
    }
  }
  return out;
}
