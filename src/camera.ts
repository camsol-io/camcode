import { scan, type ScanResult } from './index.js';
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
}

export interface StartOptions {
  // A camera from listCameras(). Without it the back camera is asked for (facingMode "environment").
  deviceId?: string;
  // Full getUserMedia constraints. Overrides deviceId.
  constraints?: MediaStreamConstraints;
}

// Reads QR and Data Matrix codes from a camera stream shown in a <video> element.
//
//   const scanner = new CameraScanner({ isValid: (t) => t.startsWith('https://example.com/') });
//   await scanner.start(video, {}, (code) => console.log(code.text), (error) => console.error(error));
//   scanner.stop();
export class CameraScanner {
  private readonly options: Required<Omit<CameraScannerOptions, 'isValid'>> & Pick<CameraScannerOptions, 'isValid'>;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  // incremented by stop() and start(), so a loop from an earlier start ends by itself
  private run = 0;

  constructor(options: CameraScannerOptions = {}) {
    this.options = {
      isValid: options.isValid,
      budgetMs: options.budgetMs ?? 100,
      maxSide: options.maxSide ?? 1280,
      pauseAfterCodeMs: options.pauseAfterCodeMs ?? 500,
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
    const constraints: MediaStreamConstraints = startOptions.constraints ?? {
      video: startOptions.deviceId ? { deviceId: { exact: startOptions.deviceId } } : { facingMode: 'environment' },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (run !== this.run) {
      // stop() or another start() came while the camera was opening
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
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
    while (run === this.run) {
      const frame = this.grab();
      if (!frame) {
        await nextFrame();
        continue;
      }
      try {
        const out = await scan(frame.pixels, { mode: 'first', isValid: this.options.isValid, budgetMs: this.options.budgetMs });
        if (run !== this.run) {
          return;
        }
        const found = out.results[0];
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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
