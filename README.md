# @camsol.io/camcode

Reads QR codes, Data Matrix codes and, when you ask for them, other 2D codes and 1D barcodes from photos and camera streams, in the browser and in Node.

camcode uses [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) through [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) for decoding. Around it, camcode decides which views of the image to decode and in which order: first a small view, then the full image, then views for hard cases (blur, glare, low contrast, damaged finder patterns, odd angles). It stops as soon as it has what you asked for.

```bash
npm install @camsol.io/camcode
```

## Scan an image

```js
import { scan, prepare } from '@camsol.io/camcode';

await prepare(); // optional: loads the WebAssembly module before the first scan

const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
const out = await scan({ data, width, height }, { mode: 'first' });

for (const code of out.results) {
  console.log(code.format, code.text); // for example 'QR_CODE', and the decoded text
}
```

`scan(image, options)` returns a promise of `{ results, elapsedMs }`.

- `image` is `{ data, width, height }`. `data` holds 4 bytes per pixel (RGBA, as `getImageData` returns it) or 1 byte per pixel (gray). The image is not changed.
- `mode`: `'first'` (default) stops at the first valid code. `'all'` looks for every code in the image.
- `isValid(text, format)`: skip codes that fail your check, for example a URL pattern.
- `formats`: the code formats to read (see below). Default `['QR_CODE', 'DATA_MATRIX']`.
- `passes`: run only these stages, in this order (names in `PASSES`: `standard` is the reduced view, the partner search and the full-size view; then `normalized`, `rotated-45`, `inverted`, `gamma`, `rotated-30` and the more expensive ones). Without it every stage runs in that order.
- `budgetMs`: no new pass starts after this many milliseconds. Without it, an image without a readable code runs every pass, which can take a second or more on a large photo.

## Formats

By default camcode reads QR codes and Data Matrix codes. Pass `formats` to read others:

```js
import { scan, ALL_FORMATS } from '@camsol.io/camcode';

await scan(image, { formats: ['QR_CODE', 'CODE_128', 'EAN_13'] });
await scan(image, { formats: ALL_FORMATS }); // everything below
```

| Kind | Formats |
|---|---|
| 2D codes | `QR_CODE`, `DATA_MATRIX`, `AZTEC`, `PDF_417` |
| 1D barcodes | `CODE_128`, `CODE_39`, `CODE_93`, `CODABAR`, `EAN_13`, `EAN_8`, `UPC_A`, `UPC_E`, `ITF`, `DATABAR`, `DATABAR_EXPANDED` |

List only the formats you expect: each one costs a little time per image and adds a small chance of a false read. The extra passes for hard cases (contrast, rotation, tiles) work for every format; the repair passes for damaged finder patterns work for QR codes only. UPC-A is returned with 12 digits.

Each result has `text`, `format`, `points` (the four corners: top-left, top-right, bottom-right, bottom-left, in image pixels), `pass` (which view found it) and `elapsedMs` (time from the start of the scan until it was found).

## Scan from a camera

```js
import { CameraScanner, prepare } from '@camsol.io/camcode';

await prepare({ wasmUrl: '/static/zxing_reader.wasm' });

const scanner = new CameraScanner({ isValid: (text) => text.startsWith('https://') });
await scanner.start(
  document.querySelector('video'),
  {},                                // or { deviceId } from CameraScanner.listCameras()
  (code) => console.log(code.text),  // called for each code found
  (error) => console.error(error),   // errors while scanning a frame; the loop keeps going
);

// later
scanner.stop();
```

- `start` opens the back camera (`facingMode: 'environment'`) unless you pass a `deviceId` or full `constraints`. It throws when the camera cannot be opened.
- `CameraScanner.listCameras()` lists the cameras. Browsers fill in the labels only after the user has allowed camera access once.
- Options: `formats` (default QR code and Data Matrix), `budgetMs` per frame (default 100), `maxSide` to shrink large frames (default 1280 px), `pauseAfterCodeMs` after a code was found (default 500).
- 1D barcodes are reported only after the same text was read in 2 frames within 1.5 s (`confirmBarcodeFrames`, `confirmWindowMs`). Their checksum is weak, and a single blurred frame can give a wrong text. 2D codes carry error correction and are reported at once.
- The scan stages are spread over frames (`schedule`, default `DEFAULT_SCHEDULE`): the standard stage every second frame, in between in turn the diagonal stages (`rotated-45`, `rotated-30`) and the contrast stages. Neighbouring frames show nearly the same picture, so each frame stays short and every stage gets its turn within a few frames. A barcode waiting for confirmation gets the stage that found it again in the next frame.
- `onFrame(info)` is called after every frame with its size, `grabMs`, `scanMs`, the stages used and whether a code was found, for example to show the frame rate.
- The camera is asked for 1920 × 1080 (it gives its nearest size) and, where the browser allows it, for continuous autofocus. `scanner.track` gives the video track, for example to read its settings.
- Small codes need pixels: a barcode needs at least about 2 pixels per bar width in the scanned frame, a QR code about 3 pixels per module. Hold the code close, or raise `maxSide` to 1920 for barcodes.
- The camera needs a secure page (HTTPS or localhost).

## Where the .wasm file comes from

zxing-wasm needs its WebAssembly file (`zxing_reader.wasm`, about 1 MB).

- **Browser:** by default zxing-wasm fetches it from the jsDelivr CDN. To serve it yourself, copy `node_modules/zxing-wasm/dist/reader/zxing_reader.wasm` into your static files and call `prepare({ wasmUrl: '<its URL>' })` before the first scan. With a bundler, a copy step does this. For Vite: `import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'`.
- **Node:** nothing to do. zxing-wasm loads the file from `node_modules`.

## Development

```bash
npm install
npm test
```

`npm test` builds `dist/` and runs the tests in `test/`. Most test images are drawn with ZXing's own encoders. Six tests use images from the public Barcode Reading Benchmark dataset, whose license is not stated. Those images are not in this repository, so the six tests are skipped (see `test/fixtures/README.md`).

## License

MIT, Camsol Services GmbH. zxing-wasm is MIT, zxing-cpp is Apache-2.0.
