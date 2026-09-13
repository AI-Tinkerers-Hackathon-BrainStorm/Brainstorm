import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const assetDir = join(root, ".whisper");
const sourceDir = join(root, ".whisper-build");
const binary = join(assetDir, "whisper-cli");
const model = join(assetDir, "ggml-base-q5_1.bin");
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";

if (!process.env.VERCEL) {
  console.log("Skipping whisper.cpp asset build outside Vercel.");
  process.exit(0);
}

mkdirSync(assetDir, { recursive: true });
if (!existsSync(binary)) {
  rmSync(sourceDir, { recursive: true, force: true });
  execFileSync("git", ["clone", "--depth", "1", "https://github.com/ggerganov/whisper.cpp.git", sourceDir], { stdio: "inherit" });
  execFileSync("cmake", ["-S", sourceDir, "-B", join(sourceDir, "build"), "-DWHISPER_BUILD_EXAMPLES=ON", "-DGGML_NATIVE=OFF"], { stdio: "inherit" });
  execFileSync("cmake", ["--build", join(sourceDir, "build"), "--config", "Release", "--target", "whisper-cli", "-j", "2"], { stdio: "inherit" });
  cpSync(join(sourceDir, "build", "bin", "whisper-cli"), binary);
  chmodSync(binary, 0o755);
}

if (!existsSync(model)) {
  const response = await fetch(modelUrl);
  if (!response.ok || !response.body) throw new Error(`Unable to download Whisper model: ${response.status}`);
  writeFileSync(model, Buffer.from(await response.arrayBuffer()), { mode: 0o644 });
}

console.log("whisper.cpp base q5_1 runtime assets are ready.");
