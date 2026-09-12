import { NextResponse } from "next/server";
import { DASHSCOPE_BASE_URL, MODELS } from "@/src/config/models.ts";

export const runtime = "nodejs";

export async function POST() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Provider is not configured." }, { status: 503 });
  try {
    const origin = new URL(DASHSCOPE_BASE_URL).origin;
    const response = await fetch(`${origin}/api/v1/tokens?expire_in_seconds=300`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!response.ok) return NextResponse.json({ error: "Could not create a temporary realtime session." }, { status: 502 });
    const data = await response.json() as { token: string; expires_at: number };
    return NextResponse.json({ token: data.token, expiresAt: data.expires_at, model: MODELS.realtimePrimary }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not create a temporary realtime session." }, { status: 502 });
  }
}
