import { DASHSCOPE_BASE_URL } from "../../config/models.ts";
import { getServerEnv } from "../../config/env.ts";
import { logger } from "../../lib/logger.ts";
import { VISION_RESPONSE_FORMAT } from "./VisionSchema.ts";

export type QwenErrorCode = "provider_auth" | "provider_rate_limit" | "provider_timeout" | "provider_response" | "invalid_json";

export class QwenRequestError extends Error {
  constructor(message: string, readonly code: QwenErrorCode, readonly providerStatus?: number) {
    super(message);
    this.name = "QwenRequestError";
  }
}

function contentAsString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : (item as { text?: string }).text ?? "").join("");
  return "";
}

export function parseJsonContent(content: unknown): Record<string, unknown> {
  const text = contentAsString(content).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(text) as Record<string, unknown>; } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const candidate = text
        .slice(start, end + 1)
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, "$1\"$2\":");
      try { return JSON.parse(candidate) as Record<string, unknown>; } catch { /* Use conservative text fallback below. */ }
    }
    if (text.length && text.length <= 4_000) {
      const extracted = [...text.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
        .map((match) => {
          try { return JSON.parse(`"${match[1]}"`) as string; } catch { return match[1]; }
        })
        .filter(Boolean);
      if (extracted.length) {
        return {
          sceneSummary: "Text was extracted without reliable structured localization.",
          text: extracted.map((value) => ({ text: value, confidence: 0.75 })),
        };
      }
    }
    throw new QwenRequestError("Provider returned invalid JSON", "invalid_json");
  }
}

export async function callQwenVision(input: {
  imageDataUrl: string;
  prompt: string;
  model: string;
  frameId: string;
  timeoutMs: number;
  maxTokens?: number;
  maxPixels?: number;
}) {
  const { DASHSCOPE_API_KEY } = getServerEnv();
  if (!DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("provider_timeout"), input.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "user", content: [
            { type: "image_url", image_url: { url: input.imageDataUrl }, min_pixels: 65_536, max_pixels: input.maxPixels ?? 1_310_720 },
            { type: "text", text: input.prompt },
          ] },
        ],
        temperature: 0.1,
        max_tokens: input.maxTokens ?? 1_200,
        enable_thinking: false,
        response_format: VISION_RESPONSE_FORMAT,
      }),
    });
    if (!response.ok) {
      const errorType = response.status === 401 ? "authentication" : response.status === 429 ? "rate_limit" : "provider_error";
      logger.error("qwen_request_failed", { frameId: input.frameId, model: input.model, status: response.status, errorType });
      const code: QwenErrorCode = response.status === 401 || response.status === 403
        ? "provider_auth"
        : response.status === 429
          ? "provider_rate_limit"
          : "provider_response";
      throw new QwenRequestError(`Qwen request failed (${response.status}, ${errorType})`, code, response.status);
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    logger.info("qwen_request_complete", { frameId: input.frameId, model: input.model, latencyMs: Date.now() - startedAt });
    return parseJsonContent(payload.choices?.[0]?.message?.content);
  } catch (error) {
    if (controller.signal.aborted) {
      logger.error("qwen_request_timeout", { frameId: input.frameId, model: input.model, latencyMs: Date.now() - startedAt });
      throw new QwenRequestError("Qwen vision request timed out", "provider_timeout");
    }
    if (error instanceof QwenRequestError) throw error;
    logger.error("qwen_request_failed", { frameId: input.frameId, model: input.model, errorType: "network_or_parse" });
    throw new QwenRequestError("Qwen vision request failed", "provider_response");
  } finally {
    clearTimeout(timeout);
  }
}

export async function callQwenText(input: { text: string; context?: string; prompt: string; model: string; timeoutMs: number }) {
  const { DASHSCOPE_API_KEY } = getServerEnv();
  if (!DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("provider_timeout"), input.timeoutMs);
  try {
    const context = input.context?.trim() ? `\nCurrent structured scene context (may be stale): ${input.context.slice(0, 1_000)}` : "";
    const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: `${input.prompt}${context}` },
          { role: "user", content: input.text.slice(0, 1_000) },
        ],
        temperature: 0.3,
        max_tokens: 240,
        enable_thinking: false,
      }),
    });
    if (!response.ok) throw new Error(`Qwen text fallback failed (${response.status})`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = contentAsString(payload.choices?.[0]?.message?.content).trim();
    if (!text) throw new Error("Qwen text fallback returned no text");
    return text.slice(0, 1_000);
  } finally {
    clearTimeout(timeout);
  }
}
