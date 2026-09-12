import sharp from "sharp";

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
  <rect width="960" height="540" fill="#ddd7ca"/>
  <rect y="300" width="960" height="240" fill="#7a5237"/>
  <rect x="90" y="335" width="145" height="150" rx="24" fill="#d32632"/>
  <path d="M225 365 C290 350 290 450 225 440" fill="none" stroke="#d32632" stroke-width="26"/>
  <rect x="365" y="410" width="115" height="38" rx="7" fill="#17191c"/>
  <rect x="475" y="418" width="34" height="22" fill="#c7c9cb"/>
  <text x="420" y="436" text-anchor="middle" font-family="Arial" font-size="20" fill="white">USB</text>
  <rect x="590" y="335" width="150" height="130" rx="8" fill="#2d63c8" stroke="white" stroke-width="5"/>
  <text x="665" y="405" text-anchor="middle" font-family="Arial" font-size="25" fill="white">FOR YOU</text>
  <circle cx="825" cy="410" r="24" fill="none" stroke="#d4af37" stroke-width="11"/>
  <path d="M847 410 H915 M890 410 V435 M910 410 V428" fill="none" stroke="#d4af37" stroke-width="11"/>
  <rect x="570" y="70" width="270" height="130" rx="10" fill="#fafafa" stroke="#111" stroke-width="8"/>
  <text x="705" y="152" text-anchor="middle" font-family="Arial" font-weight="700" font-size="64" fill="#111">EXIT</text>
</svg>`);
const png = await sharp(svg).png().toBuffer();
async function testVision(purpose, detailTier) {
  const form = new FormData();
  form.set("frame", new Blob([png], { type: "image/png" }), "smoke.png");
  form.set("metadata", JSON.stringify({ frameId: `smoke-${purpose}-${detailTier}-${Date.now()}`, capturedAt: Date.now(), requestSentAt: Date.now(), purpose, detailTier, goal: "Systematically inspect the full image" }));
  const startedAt = Date.now();
  const response = await fetch("http://localhost:3000/api/vision", { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${detailTier} smoke test failed (${response.status}): ${payload.error ?? "unknown error"}`);
  console.log(JSON.stringify({ ok: true, purpose, tier: detailTier, model: payload.model, latencyMs: Date.now() - startedAt, objects: payload.objects?.map((object) => [object.color, object.label].filter(Boolean).join(" ")) ?? [], sceneSummary: payload.sceneSummary }));
}

await testVision("background", "fast");
await testVision("detailed", "fast");
await testVision("detailed", "max");

const ocrForm = new FormData();
ocrForm.set("frame", new Blob([png], { type: "image/png" }), "smoke.png");
ocrForm.set("metadata", JSON.stringify({ frameId: `ocr-smoke-${Date.now()}`, capturedAt: Date.now(), requestSentAt: Date.now(), purpose: "ocr" }));
const ocrResponse = await fetch("http://localhost:3000/api/ocr", { method: "POST", body: ocrForm });
const ocrPayload = await ocrResponse.json();
if (!ocrResponse.ok) throw new Error(`OCR smoke test failed (${ocrResponse.status}): ${ocrPayload.error ?? "unknown error"}`);
console.log(JSON.stringify({ ok: true, model: ocrPayload.model, text: ocrPayload.text?.map((item) => item.text) ?? [] }));
