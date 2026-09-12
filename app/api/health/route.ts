import { NextResponse } from "next/server";
import { DASHSCOPE_BASE_URL, MODELS } from "@/src/config/models.ts";
import { resolveRealtimeEndpoint } from "@/src/providers/server/RealtimeEndpoint.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = Boolean(process.env.DASHSCOPE_API_KEY);
  const realtime = resolveRealtimeEndpoint(DASHSCOPE_BASE_URL, MODELS.realtimePrimary);
  return NextResponse.json(
    {
      ok: configured,
      provider: "dashscope",
      model: MODELS.deepVision,
      detailedModel: MODELS.deepVisionMax,
      realtimeModel: MODELS.realtimePrimary,
      realtimeConfigured: configured && realtime.configured,
      realtimeIssue: realtime.issue,
    },
    { status: configured ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
