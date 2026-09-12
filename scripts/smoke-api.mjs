import sharp from "sharp";

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
  <rect width="960" height="540" fill="#d8d2c6"/>
  <rect y="390" width="960" height="150" fill="#6b4d35"/>
  <rect x="120" y="150" width="150" height="250" rx="50" fill="#c92832"/>
  <rect x="158" y="115" width="74" height="55" rx="12" fill="#871a23"/>
  <rect x="570" y="120" width="270" height="130" rx="10" fill="#fafafa" stroke="#111" stroke-width="8"/>
  <text x="705" y="202" text-anchor="middle" font-family="Arial" font-weight="700" font-size="64" fill="#111">EXIT</text>
</svg>`);
const png = await sharp(svg).png().toBuffer();
async function testVision(detailTier) {
  const form = new FormData();
  form.set("frame", new Blob([png], { type: "image/png" }), "smoke.png");
  form.set("metadata", JSON.stringify({ frameId: `smoke-${detailTier}-${Date.now()}`, capturedAt: Date.now(), requestSentAt: Date.now(), purpose: "detailed", detailTier, goal: "Systematically inspect the full image" }));
  const startedAt = Date.now();
  const response = await fetch("http://localhost:3000/api/vision", { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${detailTier} smoke test failed (${response.status}): ${payload.error ?? "unknown error"}`);
  console.log(JSON.stringify({ ok: true, tier: detailTier, model: payload.model, latencyMs: Date.now() - startedAt, objectCount: payload.objects?.length ?? 0, sceneSummary: payload.sceneSummary }));
}

await testVision("fast");
await testVision("max");

const ocrForm = new FormData();
ocrForm.set("frame", new Blob([png], { type: "image/png" }), "smoke.png");
ocrForm.set("metadata", JSON.stringify({ frameId: `ocr-smoke-${Date.now()}`, capturedAt: Date.now(), requestSentAt: Date.now(), purpose: "ocr" }));
const ocrResponse = await fetch("http://localhost:3000/api/ocr", { method: "POST", body: ocrForm });
const ocrPayload = await ocrResponse.json();
if (!ocrResponse.ok) throw new Error(`OCR smoke test failed (${ocrResponse.status}): ${ocrPayload.error ?? "unknown error"}`);
console.log(JSON.stringify({ ok: true, model: ocrPayload.model, text: ocrPayload.text?.map((item) => item.text) ?? [] }));
