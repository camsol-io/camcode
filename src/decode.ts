import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
import type { Point, RGBAImage } from './image.js';

// 2D codes and 1D barcodes zxing-cpp reads. Names follow ZXing's BarcodeFormat.
export type CodeFormat =
  | 'QR_CODE'
  | 'DATA_MATRIX'
  | 'AZTEC'
  | 'PDF_417'
  | 'CODE_128'
  | 'CODE_39'
  | 'CODE_93'
  | 'CODABAR'
  | 'EAN_13'
  | 'EAN_8'
  | 'UPC_A'
  | 'UPC_E'
  | 'ITF'
  | 'DATABAR'
  | 'DATABAR_EXPANDED';

// What scan() reads when no formats are given.
export const DEFAULT_FORMATS: CodeFormat[] = ['QR_CODE', 'DATA_MATRIX'];

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

const names: Record<CodeFormat, string> = {
  QR_CODE: 'QRCode',
  DATA_MATRIX: 'DataMatrix',
  AZTEC: 'Aztec',
  PDF_417: 'PDF417',
  CODE_128: 'Code128',
  CODE_39: 'Code39',
  CODE_93: 'Code93',
  CODABAR: 'Codabar',
  EAN_13: 'EAN-13',
  EAN_8: 'EAN-8',
  UPC_A: 'UPC-A',
  UPC_E: 'UPC-E',
  ITF: 'ITF',
  DATABAR: 'DataBar',
  DATABAR_EXPANDED: 'DataBarExp',
};
// zxing-cpp reports formats in its own spelling ('EAN-13', 'DataBarExp', 'QRCode', ...): compare letters and digits only
const key = (name: string) => name.replace(/[^a-z0-9]/gi, '').toLowerCase();
const formatOf: Record<string, CodeFormat> = Object.fromEntries((Object.entries(names) as [CodeFormat, string][]).map(([f, n]) => [key(n), f]));
formatOf[key('DataBarOmni')] = 'DATABAR';

export const ALL_FORMATS = Object.keys(names) as CodeFormat[];

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
    formats: (options.formats ?? DEFAULT_FORMATS).map((f) => names[f]) as ReaderOptions['formats'],
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
    const format = formatOf[key(String(r.format))];
    if (!format || (!r.isValid && !options.located)) {
      continue;
    }
    const p = r.position;
    const points = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => ({ x: q.x, y: q.y }));
    if (r.isValid) {
      // zxing-cpp gives UPC-A in its EAN-13 form (a leading 0); the UPC-A text has 12 digits
      const text = format === 'UPC_A' && /^0\d{12}$/.test(r.text) ? r.text.slice(1) : r.text;
      out.push({ text, format, points });
    } else {
      const s = r.symbol;
      const symbol = Array.from({ length: s.height }, (_, y) => Uint8Array.from({ length: s.width }, (_, x) => (s.data[y * s.width + x] ? 0 : 1)));
      out.push({ text: '', format, points, error: r.error || 'not decoded', version: Number(r.version) || 0, symbol });
    }
  }
  return out;
}
