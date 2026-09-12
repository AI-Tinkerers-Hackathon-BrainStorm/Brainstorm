type VideoFrameSource = Pick<HTMLVideoElement, "readyState" | "videoWidth" | "videoHeight">;
type VideoStreamSource = Pick<MediaStream, "active" | "getVideoTracks">;

export function hasLiveVideoTrack(stream?: VideoStreamSource | null): boolean {
  return Boolean(stream?.active && stream.getVideoTracks().some((track) => track.enabled && track.readyState === "live"));
}

export function isVideoFrameReady(video?: VideoFrameSource | null): boolean {
  return Boolean(video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
}

export async function waitForVideoFrame(video: VideoFrameSource, timeoutMs = 4_000): Promise<void> {
  if (isVideoFrameReady(video)) return;
  const startedAt = Date.now();
  while (!isVideoFrameReady(video)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("camera_frame_timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function waitForFreshVideoFrame(video: HTMLVideoElement, timeoutMs = 1_500): Promise<void> {
  await waitForVideoFrame(video, timeoutMs);
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let callbackId = 0;
      const timer = setTimeout(() => {
        video.cancelVideoFrameCallback?.(callbackId);
        finish(new Error("camera_fresh_frame_timeout"));
      }, timeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      callbackId = video.requestVideoFrameCallback(() => finish());
    });
    return;
  }
  const initialTime = video.currentTime;
  const startedAt = Date.now();
  while (video.currentTime === initialTime) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("camera_fresh_frame_timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function waitForCapturableFrame(video: HTMLVideoElement, timeoutMs = 2_500): Promise<void> {
  try {
    await waitForFreshVideoFrame(video, timeoutMs);
  } catch (error) {
    // iOS may delay requestVideoFrameCallback while the decoded preview remains drawable.
    if (!isVideoFrameReady(video)) throw error;
  }
}

export class CameraManager {
  private stream?: MediaStream;
  private preview?: HTMLVideoElement;

  async start(video: HTMLVideoElement, previewHeight = 720): Promise<MediaStream> {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: Math.round(previewHeight * 16 / 9) },
        height: { ideal: previewHeight },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.preview = video;
    video.srcObject = this.stream;
    try {
      await video.play();
      await waitForVideoFrame(video);
      return this.stream;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    const stream = this.stream;
    const preview = this.preview;
    stream?.getTracks().forEach((track) => track.stop());
    if (preview && preview.srcObject === stream) preview.srcObject = null;
    this.stream = undefined;
    this.preview = undefined;
  }

  get active() { return hasLiveVideoTrack(this.stream); }
}
