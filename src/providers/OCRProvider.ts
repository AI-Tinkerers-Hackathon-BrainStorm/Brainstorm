import type { EncodedFrame, VisionObservation } from "../types/index.ts";

export interface OCRProvider {
  read(frame: EncodedFrame, signal?: AbortSignal): Promise<VisionObservation>;
}

export class QwenOCRProvider implements OCRProvider {
  async read(frame: EncodedFrame, signal?: AbortSignal) {
    const form = new FormData();
    form.set("frame", frame.blob, `${frame.frameId}.jpg`);
    form.set("metadata", JSON.stringify({ frameId: frame.frameId, capturedAt: frame.capturedAt, requestSentAt: Date.now(), purpose: "ocr" }));
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort("ocr_timeout"), 14_000);
    try {
      const response = await fetch("/api/ocr", { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) throw new Error(`OCR failed (${response.status})`);
      return response.json() as Promise<VisionObservation>;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
