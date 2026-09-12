/// <reference lib="webworker" />
export {};

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = async (event: MessageEvent<{ id: string; bitmap: ImageBitmap; width: number; height: number; quality: number }>) => {
  const { id, bitmap, width, height, quality } = event.data;
  const startedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Offscreen canvas is unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    worker.postMessage({ id, blob, width, height, encodeMs: performance.now() - startedAt });
  } catch (error) {
    bitmap.close();
    worker.postMessage({ id, error: error instanceof Error ? error.message : "Frame encoding failed" });
  }
};
