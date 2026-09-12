import type { EncodedFrame, VisionObservation } from "../types/index.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type VisionDetailTier = "fast" | "max";

export type VisionClientErrorCode = "provider_auth" | "provider_rate_limit" | "provider_timeout" | "provider_response" | "invalid_json" | "vision_failed" | "network_error";

export class VisionClientError extends Error {
  constructor(message: string, readonly code: VisionClientErrorCode, readonly status?: number) {
    super(message);
    this.name = "VisionClientError";
  }
}

export interface DeepVisionProvider {
  analyzeFast(frame: EncodedFrame, goal?: string, signal?: AbortSignal): Promise<VisionObservation>;
  analyzeMax(frame: EncodedFrame, goal?: string, signal?: AbortSignal): Promise<VisionObservation>;
}

function abortError(reason: unknown): DOMException {
  return new DOMException(typeof reason === "string" ? reason : "Vision request aborted", "AbortError");
}

export class QwenDeepVisionProvider implements DeepVisionProvider {
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  analyzeFast(frame: EncodedFrame, goal = "Systematically describe the current view, including small recognizable objects", signal?: AbortSignal) {
    return this.analyze(frame, goal, "fast", 23_000, signal);
  }

  analyzeMax(frame: EncodedFrame, goal = "Systematically describe the current view, including small recognizable objects", signal?: AbortSignal) {
    return this.analyze(frame, goal, "max", 36_000, signal);
  }

  private async analyze(frame: EncodedFrame, goal: string, detailTier: VisionDetailTier, timeoutMs: number, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError(signal.reason);
    const form = new FormData();
    form.set("frame", frame.blob, `${frame.frameId}.jpg`);
    form.set("metadata", JSON.stringify({ frameId: frame.frameId, capturedAt: frame.capturedAt, requestSentAt: Date.now(), purpose: "detailed", detailTier, goal }));
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(`${detailTier}_vision_timeout`), timeoutMs);
    try {
      const response = await this.fetcher("/api/vision", { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) {
        let code: VisionClientErrorCode = response.status === 429 ? "provider_rate_limit" : response.status === 504 ? "provider_timeout" : "vision_failed";
        try {
          const payload = await response.json() as { code?: VisionClientErrorCode };
          if (payload.code) code = payload.code;
        } catch { /* Status-derived category remains available. */ }
        throw new VisionClientError(`${detailTier} vision failed (${response.status})`, code, response.status);
      }
      const observation = await response.json() as VisionObservation;
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      return observation;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (controller.signal.aborted) throw new VisionClientError(`${detailTier} vision timed out`, "provider_timeout");
      if (error instanceof VisionClientError) throw error;
      throw new VisionClientError(`${detailTier} vision network request failed`, "network_error");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

export function shouldTryMaxAfterFastFailure(error: unknown): boolean {
  // A slower model cannot repair a network timeout, missing access, or overload.
  return error instanceof VisionClientError && error.code === "invalid_json";
}

export async function runFastWithMaxFallback<T>(runFast: () => Promise<T>, runMax: () => Promise<T>): Promise<{ value: T; usedMaxFallback: boolean }> {
  try {
    return { value: await runFast(), usedMaxFallback: false };
  } catch (error) {
    if (!shouldTryMaxAfterFastFailure(error)) throw error;
    return { value: await runMax(), usedMaxFallback: true };
  }
}
