import type { EncodedFrame } from "../types/index.ts";
import { LatestFrameProcessor } from "./LatestFrameProcessor.ts";
import { isVideoFrameReady, waitForCapturableFrame } from "./CameraManager.ts";

type PendingBitmap = { bitmap: ImageBitmap; frameId: string; capturedAt: number };

export class FrameSampler {
  private worker = new Worker(new URL("./frame.worker.ts", import.meta.url), { type: "module" });
  private queue: LatestFrameProcessor<PendingBitmap>;
  private active = false;
  private fps = 0.8;
  private lastCapturedAt = 0;
  private sequence = 0;
  private timeout?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (frame: EncodedFrame, encodeMs: number) => Promise<void>,
    onDrop: () => void,
  ) {
    this.queue = new LatestFrameProcessor(
      (item) => this.encode(item),
      (item) => item.bitmap.close(),
      onDrop,
    );
  }

  setFps(fps: number) { this.fps = Math.max(0.2, Math.min(2, fps)); }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.timeout) clearTimeout(this.timeout);
    this.queue.stop();
    this.worker.terminate();
  }

  private schedule() {
    if (!this.active) return;
    const video = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: (now: number) => void) => number };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now) => { void this.maybeCapture(now); this.schedule(); });
    else this.timeout = setTimeout(() => { void this.maybeCapture(performance.now()); this.schedule(); }, 100);
  }

  private async maybeCapture(now: number) {
    if (!this.active || !isVideoFrameReady(this.video) || now - this.lastCapturedAt < 1_000 / this.fps) return;
    this.lastCapturedAt = now;
    try {
      const bitmap = await createImageBitmap(this.video);
      this.queue.push({ bitmap, frameId: `frame-${Date.now()}-${++this.sequence}`, capturedAt: Date.now() });
    } catch { /* The next video callback retries. */ }
  }

  private encode(item: PendingBitmap): Promise<void> {
    const id = item.frameId;
    return new Promise((resolve, reject) => {
      const handler = (event: MessageEvent<{ id: string; blob?: Blob; width?: number; height?: number; encodeMs?: number; error?: string }>) => {
        if (event.data.id !== id) return;
        this.worker.removeEventListener("message", handler);
        if (event.data.error || !event.data.blob) { reject(new Error(event.data.error ?? "Frame encoding failed")); return; }
        void this.onFrame({
          frameId: id,
          capturedAt: item.capturedAt,
          blob: event.data.blob,
          width: event.data.width ?? 640,
          height: event.data.height ?? 360,
        }, event.data.encodeMs ?? 0).then(resolve, reject);
      };
      this.worker.addEventListener("message", handler);
      this.worker.postMessage({ id, bitmap: item.bitmap, width: 640, height: 360, quality: 0.7 }, [item.bitmap]);
    });
  }
}

export async function captureHighResolution(video: HTMLVideoElement): Promise<EncodedFrame> {
  await waitForCapturableFrame(video, 2_500);
  const width = Math.min(1600, video.videoWidth);
  const height = Math.round(width * video.videoHeight / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas is unavailable");
  const capturedAt = Date.now();
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Capture failed")), "image/jpeg", 0.86));
  return { frameId: `scan-${capturedAt}`, capturedAt, blob, width, height, manual: true };
}
