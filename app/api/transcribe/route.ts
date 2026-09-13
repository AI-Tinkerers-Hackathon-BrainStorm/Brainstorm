import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const execFileAsync = promisify(execFile);
const ASSET_DIR = path.join(process.cwd(), ".whisper");
const BINARY = path.join(ASSET_DIR, "whisper-cli");
const MODEL = path.join(ASSET_DIR, "ggml-base-q5_1.bin");

function sanitizeTranscript(output: string): string {
  return output
    .replace(/^\s*\[[^\]]+\]\s*/gmu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4_000);
}

async function assertRuntimeAssets(): Promise<void> {
  await Promise.all([access(BINARY), access(MODEL)]);
}

export async function POST(request: Request) {
  let inputPath: string | undefined;
  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.type !== "audio/wav" || audio.size < 256 || audio.size > 2_000_000) {
      return NextResponse.json({ error: "A PCM WAV clip under 2 MB is required." }, { status: 400 });
    }
    await assertRuntimeAssets();
    inputPath = path.join("/tmp", `sightloop-${randomUUID()}.wav`);
    await writeFile(inputPath, Buffer.from(await audio.arrayBuffer()), { mode: 0o600 });
    const { stdout } = await execFileAsync(BINARY, ["-m", MODEL, "-f", inputPath, "-nt", "-np", "-l", "auto"], {
      timeout: 55_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    return NextResponse.json({ text: sanitizeTranscript(stdout) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Whisper transcription failed";
    const unavailable = /ENOENT|no such file|not accessible/i.test(message);
    return NextResponse.json(
      { error: unavailable ? "Whisper runtime assets are unavailable. Redeploy with the Vercel build command." : "Whisper transcription failed." },
      { status: unavailable ? 503 : /timed out/i.test(message) ? 504 : 502 },
    );
  } finally {
    if (inputPath) await rm(inputPath, { force: true }).catch(() => undefined);
  }
}
