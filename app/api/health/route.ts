import { NextResponse } from "next/server";
import { MODELS } from "@/src/config/models.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = Boolean(process.env.DASHSCOPE_API_KEY);
  return NextResponse.json(
    { ok: configured, provider: "dashscope", model: MODELS.deepVision, detailedModel: MODELS.deepVisionMax, realtimeModel: MODELS.realtimePrimary },
    { status: configured ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
