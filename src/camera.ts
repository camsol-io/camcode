import { PASSES, scan, type PassName, type ScanResult } from './index.js';
import type { CodeFormat } from './decode.js';

export interface CameraScannerOptions {
  // Accept only codes that pass this check, for example a URL pattern.
  isValid?: (text: string, format: CodeFormat) => boolean;
  // Time per frame in milliseconds after which no new scan pass starts. Keeps the camera loop responsive:
  // frames without a code end after about this long instead of running every pass. Default 100.
  budgetMs?: number;
  // Frames larger than this (longer side, in pixels) are shrunk before scanning. Default 1280.
  maxSide?: number;
  // Pause after a code was found, in milliseconds, so one code is not reported many times a second. Default 500.
  pauseAfterCodeMs?: number;
  // The code formats to read. Default QR_CODE and DATA_MATRIX.
  formats?: CodeFormat[];
  // A 1D barcode is reported only after the same text was read in this many frames within confirmWindowMs.
  // 1D barcodes have only a weak checksum, so a single blurred frame can give a wrong text. QR codes, Data Matrix,
  // Aztec and PDF417 carry error correction and are reported at once. Default 2; 1 turns the check off.
  confirmBarcodeFrames?: number;
  // See confirmBarcodeFrames. Default 1500.
  confirmWindowMs?: number;
  // The scan stages per frame, used in turn (one entry per frame). Neighbouring frames show nearly the same picture,
  // so the stages are spread over frames instead of running all of them on every frame: each frame stays short, and
  // every stage gets its turn within a few frames. Default DEFAULT_SCHEDULE.
  schedule?: PassName[][];
  // Called after every scanned frame, for example to show the frame rate.
  onFrame?: (frame: FrameInfo) => void;
}

export interface FrameInfo {
  // the frame as scanned, in pixels
  width: number;
  height: number;
  // copying the video frame into a canvas and reading its pixels
  grabMs: number;
  scanMs: number;
  passes: PassName[];
  found: boolean;
}

// The standard stage every second frame. In between, in turn, the stages that read codes the standard stage misses
// in camera frames: diagonal codes (rotated-45, rotated-30) most often, since a hand-held code is often turned, then
// low contrast, dark codes and light-on-dark codes.
export const DEFAULT_SCHEDULE: PassName[][] = [
  ['standard'],
  ['rotated-45'],
  ['standard'],
  ['rotated-30'],
  ['standard'],
  ['normalized'],
  ['standard'],
  ['rotated-45'],
  ['standard'],
  ['rotated-30'],
  ['standard'],
  ['gamma'],
  ['standard'],
  ['rotated-45'],
  ['standard'],
  ['inverted'],
];

const MATRIX_FORMATS: CodeFormat[] = ['QR_CODE', 'DATA_MATRIX', 'AZTEC', 'PDF_417'];

export interface StartOptions {
  // A camera from listCameras(). Without it the back camera is asked for (facingMode "environment").
  deviceId?: string;
  // Full getUserMedia constraints. Overrides deviceId.
  constraints?: MediaStreamConstraints;
}

// Reads codes from a camera stream shown in a <video> element: QR and Data Matrix by default, other formats on request.
//
//   const scanner = new CameraScanner({ isValid: (t) => t.startsWith('https://example.com/') });
//   await scanner.start(video, {}, (code) => console.log(code.text), (error) => console.error(error));
//   scanner.stop();
export class CameraScanner {
  private readonly options: Required<Omit<CameraScannerOptions, 'isValid' | 'formats' | 'onFrame'>> & Pick<CameraScannerOptions, 'isValid' | 'formats' | 'onFrame'>;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  // incremented by stop() and start(), so a loop from an earlier start ends by itself
  private run = 0;

  constructor(options: CameraScannerOptions = {}) {
    this.options = {
      isValid: options.isValid,
      formats: options.formats,
      budgetMs: options.budgetMs ?? 100,
      maxSide: options.maxSide ?? 1280,
      pauseAfterCodeMs: options.pauseAfterCodeMs ?? 500,
      confirmBarcodeFrames: Math.max(1, options.confirmBarcodeFrames ?? 2),
      confirmWindowMs: options.confirmWindowMs ?? 1500,
      schedule: options.schedule?.length ? options.schedule : DEFAULT_SCHEDULE,
      onFrame: options.onFrame,
    };
  }

  // The cameras of this device. Browsers fill in the labels only after the user has allowed camera access once.
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  get running(): boolean {
    return this.stream !== null;
  }

  // The camera's video track while running, for example to read its settings or switch on the torch.
  get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  // Opens the camera, shows it in `video` and scans its frames until stop() is called.
  // `onCode` gets each code found; `onError` gets errors from scanning a frame (the loop keeps going).
  // Throws when the camera cannot be opened (no permission, no camera).
  async start(
    video: HTMLVideoElement,
    startOptions: StartOptions,
    onCode: (result: ScanResult) => void,
    onError: (error: unknown) => void = (error) => console.error(error),
  ): Promise<void> {
    this.stop();
    const run = ++this.run;
    // 1920 x 1080 as a wish, not a must: more pixels per bar and module for small codes; cameras that cannot do it
    // give their nearest size.
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const constraints: MediaStreamConstraints = startOptions.constraints ?? {
      video: startOptions.deviceId ? { deviceId: { exact: startOptions.deviceId }, ...size } : { facingMode: 'environment', ...size },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (run !== this.run) {
      // stop() or another start() came while the camera was opening
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    await continuousFocus(stream.getVideoTracks()[0]);
    this.video = video;
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true'); // iOS: play inline instead of fullscreen
    video.muted = true;
    await video.play().catch(() => undefined); // autoplay can be refused; frames still arrive once it plays
    void this.loop(run, onCode, onError);
  }

  // Stops scanning and the camera. Safe to call more than once.
  stop(): void {
    this.run++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
  }

  private async loop(run: number, onCode: (result: ScanResult) => void, onError: (error: unknown) => void): Promise<void> {
    let pending: { key: string; count: number; at: number; stage: PassName } | null = null;
    let turn = 0;
    while (run === this.run) {
      const grabStart = performance.now();
      const frame = this.grab();
      const grabMs = performance.now() - grabStart;
      if (!frame) {
        await nextFrame();
        continue;
      }
      try {
        // A barcode waiting for confirmation: repeat the stage that read it, so the next frame can confirm it at once.
        const confirming = pending && Date.now() - pending.at <= this.options.confirmWindowMs;
        const passes = confirming && pending ? [pending.stage] : this.options.schedule[turn++ % this.options.schedule.length];
        const out = await scan(frame.pixels, { mode: 'first', isValid: this.options.isValid, budgetMs: this.options.budgetMs, formats: this.options.formats, passes });
        if (run !== this.run) {
          return;
        }
        const found = out.results[0];
        this.options.onFrame?.({ width: frame.pixels.width, height: frame.pixels.height, grabMs, scanMs: out.elapsedMs, passes, found: !!found });
        if (found && !MATRIX_FORMATS.includes(found.format) && this.options.confirmBarcodeFrames > 1) {
          const key = `${found.format} ${found.text}`;
          const now = Date.now();
          const stage = stageOf(found.pass);
          pending = pending && pending.key === key && now - pending.at <= this.options.confirmWindowMs ? { key, count: pending.count + 1, at: now, stage } : { key, count: 1, at: now, stage };
          if (pending.count < this.options.confirmBarcodeFrames) {
            await nextFrame();
            continue;
          }
          pending = null;
        }
        if (found) {
          const points = found.points.map((p) => ({ x: p.x / frame.scale, y: p.y / frame.scale }));
          onCode({ ...found, points });
          await wait(this.options.pauseAfterCodeMs);
          continue;
        }
      } catch (error) {
        onError(error);
      }
      await nextFrame();
    }
  }

  // The current video frame as RGBA pixels, shrunk to maxSide; null while the video has no frame yet.
  private grab(): { pixels: { data: Uint8ClampedArray; width: number; height: number }; scale: number } | null {
    const video = this.video;
    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      return null;
    }
    const scale = Math.min(1, this.options.maxSide / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    this.canvas ??= document.createElement('canvas');
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return { pixels: { data, width, height }, scale };
  }
}

// The stage a result's pass belongs to: the reduced view, the partner search and the full-size view are 'standard'.
function stageOf(pass: string): PassName {
  return (PASSES as readonly string[]).includes(pass) ? (pass as PassName) : 'standard';
}

// Asks the camera to keep refocusing, where the browser and camera allow it (Chrome on Android and many webcams).
// Without it some cameras keep the focus they had at start, and close codes stay blurred.
async function continuousFocus(track: MediaStreamTrack | undefined): Promise<void> {
  try {
    const capabilities = (track?.getCapabilities?.() ?? {}) as { focusMode?: string[] };
    if (track && capabilities.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    }
  } catch {
    // not supported here: keep the camera's own focus behaviour
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
