import { NextResponse } from "next/server";
import { REALTIME_AGENT_SYSTEM_PROMPT } from "@/src/agent/prompts.ts";
import { MODELS } from "@/src/config/models.ts";
import { callQwenText } from "@/src/providers/server/QwenClient.ts";

export const runtime = "nodejs";
export const maxDuration = 12;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { text?: unknown; context?: unknown };
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1_000) {
      return NextResponse.json({ error: "A non-empty request under 1,000 characters is required." }, { status: 400 });
    }
    const text = await callQwenText({
      text: body.text.trim(),
      context: typeof body.context === "string" ? body.context : undefined,
      prompt: REALTIME_AGENT_SYSTEM_PROMPT,
      model: MODELS.conversationFallback,
      timeoutMs: 9_000,
    });
    return NextResponse.json({ text, model: MODELS.conversationFallback }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Text fallback failed";
    return NextResponse.json({ error: message }, { status: /not configured/i.test(message) ? 503 : 502 });
  }
}
