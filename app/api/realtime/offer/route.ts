import { NextResponse } from "next/server";
import { DASHSCOPE_BASE_URL, MODELS } from "@/src/config/models.ts";
import { resolveRealtimeEndpoint } from "@/src/providers/server/RealtimeEndpoint.ts";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(request: Request) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Provider is not configured." }, { status: 503 });
  const sdp = await request.text();
  if (!sdp.startsWith("v=0") || sdp.length > 100_000) return NextResponse.json({ error: "Invalid SDP offer." }, { status: 400 });
  try {
    const endpoint = resolveRealtimeEndpoint(DASHSCOPE_BASE_URL, MODELS.realtimePrimary);
    if (!endpoint.configured || !endpoint.url) {
      return NextResponse.json(
        { error: "Realtime requires a workspace-specific DASHSCOPE_BASE_URL.", code: endpoint.issue },
        { status: 503 },
      );
    }
    const response = await fetch(endpoint.url, {
      method: "POST",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/sdp" },
      body: sdp,
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: `Realtime provider rejected the offer (${response.status}).`, code: "realtime_provider_rejected_offer" },
        { status: 502 },
      );
    }
    return new NextResponse(await response.text(), { status: 200, headers: { "Content-Type": "application/sdp", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Realtime signaling failed." }, { status: 502 });
  }
}
