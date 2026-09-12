import { NextResponse } from "next/server";
import { MODELS } from "@/src/config/models.ts";
import { OCR_SYSTEM_PROMPT } from "@/src/agent/prompts.ts";
import { callQwenVision } from "@/src/providers/server/QwenClient.ts";
import { normalizeObservation } from "@/src/providers/server/normalize.ts";

export const runtime = "nodejs";
export const maxDuration = 16;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const frame = form.get("frame");
    const metadataRaw = form.get("metadata");
    if (!(frame instanceof File) || frame.size === 0 || frame.size > 12_000_000) return NextResponse.json({ error: "A valid image under 12 MB is required." }, { status: 400 });
    const meta = JSON.parse(typeof metadataRaw === "string" ? metadataRaw : "{}") as { frameId?: string; capturedAt?: number; requestSentAt?: number; purpose?: string };
    if (!meta.frameId || !Number.isFinite(meta.capturedAt) || !Number.isFinite(meta.requestSentAt) || meta.purpose !== "ocr") return NextResponse.json({ error: "Invalid frame metadata." }, { status: 400 });
    const bytes = Buffer.from(await frame.arrayBuffer());
    const raw = await callQwenVision({
      imageDataUrl: `data:${frame.type || "image/jpeg"};base64,${bytes.toString("base64")}`,
      prompt: OCR_SYSTEM_PROMPT,
      model: MODELS.ocr,
      frameId: meta.frameId,
      timeoutMs: 13_000,
      maxTokens: 1_200,
      maxPixels: 2_621_440,
    });
    return NextResponse.json(normalizeObservation(raw, meta as { frameId: string; capturedAt: number; requestSentAt: number; purpose: "ocr" }, "ocr", MODELS.ocr));
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCR request failed";
    return NextResponse.json({ error: message }, { status: /not configured/i.test(message) ? 503 : 502 });
  }
}
