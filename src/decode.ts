import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
import type { Point, RGBAImage } from './image.js';

export type CodeFormat = 'QR_CODE' | 'DATA_MATRIX';

export interface Decoded {
  text: string;
  // set when zxing-cpp found a symbol here but could not decode it (only with `located`)
  error?: string;
  // with `located`, for symbols that were not decoded: the version and the modules zxing-cpp sampled (rows, 1 = dark)
  version?: number;
  symbol?: Uint8Array[];
  format: CodeFormat;
  // corners in the order top-left, top-right, bottom-right, bottom-left of the symbol
  points: Point[];
}

export interface DecodeOptions {
  formats?: CodeFormat[];
  // stop after the first code; zxing-cpp then skips the rest of the image
  one?: boolean;
  // also look for light-on-dark codes; costs a second pass over the view
  inverted?: boolean;
  // close small gaps between modules before detecting; helps blurred and worn codes
  denoise?: boolean;
  // 'fixed' splits black from white at mid-gray for the whole view, 'global' at the valley of the view's histogram;
  // the default thresholds by local averages
  binarizer?: 'local' | 'fixed' | 'global';
  // also return symbols that were found but not decoded, with `error` set
  located?: boolean;
  // the view is the code alone, upright and with its quiet zone (a computer-made image): zxing-cpp then samples the
  // grid from the bounding box and does not need intact finder patterns
  pure?: boolean;
}

const names: Record<CodeFormat, 'QRCode' | 'DataMatrix'> = { QR_CODE: 'QRCode', DATA_MATRIX: 'DataMatrix' };
const formatOf: Record<string, CodeFormat> = { QRCode: 'QR_CODE', DataMatrix: 'DATA_MATRIX' };

export interface PrepareOptions {
  // URL of zxing_reader.wasm (from the zxing-wasm package, dist/reader/) as your app serves it
  wasmUrl?: string;
  // full control over where zxing-wasm loads its files from; overrides wasmUrl
  locateFile?: (path: string, prefix: string) => string;
}

// Loads the zxing-cpp WebAssembly module ahead of the first scan. Without it the first scan loads it.
// In a browser, zxing-wasm fetches the .wasm file from the jsDelivr CDN unless told otherwise. To serve it yourself,
// copy node_modules/zxing-wasm/dist/reader/zxing_reader.wasm to your static files and pass its URL:
// prepare({ wasmUrl: '/static/zxing_reader.wasm' })
// In Node no options are needed: zxing-wasm loads the file from node_modules.
export async function prepare(options: PrepareOptions = {}): Promise<void> {
  const { wasmUrl } = options;
  const locateFile = options.locateFile ?? (wasmUrl ? (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) : undefined);
  // an empty overrides object would replace zxing-wasm's own defaults, which find the file in Node
  await prepareZXingModule(locateFile ? { overrides: { locateFile }, fireImmediately: true } : { fireImmediately: true });
}

// One zxing-cpp read of one view. zxing-cpp finds every code in the view in one call.
export async function decode(image: RGBAImage, options: DecodeOptions = {}): Promise<Decoded[]> {
  const readerOptions: ReaderOptions = {
    formats: (options.formats ?? ['QR_CODE', 'DATA_MATRIX']).map((f) => names[f]),
    textMode: 'Plain',
    tryHarder: true,
    tryRotate: true,
    tryInvert: options.inverted ?? false,
    tryDenoise: options.denoise ?? false,
    maxNumberOfSymbols: options.one ? 1 : 255,
    binarizer: options.binarizer === 'fixed' ? 'FixedThreshold' : options.binarizer === 'global' ? 'GlobalHistogram' : 'LocalAverage',
    returnErrors: options.located ?? false,
    isPure: options.pure ?? false,
  };
  const imageData = { data: image.data, width: image.width, height: image.height, colorSpace: 'srgb' } as unknown as Parameters<typeof readBarcodes>[0];
  const found = await readBarcodes(imageData, readerOptions);
  const out: Decoded[] = [];
  for (const r of found) {
    const format = formatOf[r.format];
    if (!format || (!r.isValid && !options.located)) {
      continue;
    }
    const p = r.position;
    const points = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => ({ x: q.x, y: q.y }));
    if (r.isValid) {
      out.push({ text: r.text, format, points });
    } else {
      const s = r.symbol;
      const symbol = Array.from({ length: s.height }, (_, y) => Uint8Array.from({ length: s.width }, (_, x) => (s.data[y * s.width + x] ? 0 : 1)));
      out.push({ text: '', format, points, error: r.error || 'not decoded', version: Number(r.version) || 0, symbol });
    }
  }
  return out;
}
