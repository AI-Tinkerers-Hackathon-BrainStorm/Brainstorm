import { NextResponse } from "next/server";
import { visionPrompt } from "@/src/agent/prompts.ts";
import { callQwenVision, QwenRequestError } from "@/src/providers/server/QwenClient.ts";
import { normalizeObservation } from "@/src/providers/server/normalize.ts";
import { selectVisionRoute, type VisionDetailTier } from "@/src/providers/server/VisionRouting.ts";

export const runtime = "nodejs";
export const maxDuration = 40;

type Meta = { frameId: string; capturedAt: number; requestSentAt: number; goal?: string; recentContext?: string; purpose: "background" | "detailed"; detailTier?: VisionDetailTier };

function parseMeta(value: FormDataEntryValue | null): Meta {
  const meta = JSON.parse(typeof value === "string" ? value : "{}") as Partial<Meta>;
  if (typeof meta.frameId !== "string" || !Number.isFinite(meta.capturedAt) || !Number.isFinite(meta.requestSentAt)) throw new Error("Invalid frame metadata");
  if (meta.purpose !== "background" && meta.purpose !== "detailed") throw new Error("Invalid vision purpose");
  if (meta.detailTier !== undefined && meta.detailTier !== "fast" && meta.detailTier !== "max") throw new Error("Invalid vision detail tier");
  return meta as Meta;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const frame = form.get("frame");
    if (!(frame instanceof File) || frame.size === 0 || frame.size > 8_000_000 || !["image/jpeg", "image/png", "image/webp"].includes(frame.type)) {
      return NextResponse.json({ error: "A JPEG, PNG, or WebP frame under 8 MB is required." }, { status: 400 });
    }
    const meta = parseMeta(form.get("metadata"));
    const bytes = Buffer.from(await frame.arrayBuffer());
    const dataUrl = `data:${frame.type};base64,${bytes.toString("base64")}`;
    const detailed = meta.purpose === "detailed";
    const plan = selectVisionRoute(meta.purpose, meta.detailTier);
    const raw = await callQwenVision({
      imageDataUrl: dataUrl,
      prompt: visionPrompt((meta.goal ?? "").slice(0, 300), (meta.recentContext ?? "").slice(0, 1_000), detailed, meta.detailTier !== "max"),
      model: plan.model,
      frameId: meta.frameId,
      timeoutMs: plan.timeoutMs,
      maxTokens: plan.maxTokens,
      maxPixels: plan.maxPixels,
      signal: request.signal,
    });
    return NextResponse.json(normalizeObservation(raw, meta, detailed ? "deep_vision" : "realtime", plan.model));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vision request failed";
    const code = error instanceof QwenRequestError ? error.code : /not configured/i.test(message) ? "provider_not_configured" : /Invalid (?:frame metadata|vision purpose|vision detail tier)/.test(message) ? "invalid_request" : "vision_failed";
    const status = code === "provider_not_configured" ? 503 : code === "invalid_request" ? 400 : code === "provider_rate_limit" ? 429 : code === "provider_timeout" ? 504 : 502;
    return NextResponse.json({ error: message, code }, { status });
  }
}
