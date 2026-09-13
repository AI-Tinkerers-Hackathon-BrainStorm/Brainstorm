import type { DetectedObject, GoalAssessment, NormalizedBBox, OCRText, PlacementObservation, SpatialPosition, VisionObservation } from "../../types/index.ts";

const clamp = (value: unknown) => Math.max(0, Math.min(1, Number(value) || 0));

function normalizeBox(value: unknown): NormalizedBBox | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value)
    ? { x1: value[0], y1: value[1], x2: value[2], y2: value[3] }
    : value as Record<string, unknown>;
  const values = [raw.x1, raw.y1, raw.x2, raw.y2].map(Number);
  if (values.some((item) => !Number.isFinite(item))) return undefined;
  const divisor = Math.max(...values) > 1 ? 999 : 1;
  const [x1, y1, x2, y2] = values.map((item) => clamp(item / divisor));
  if (x2 <= x1 || y2 <= y1) return undefined;
  return { x1, y1, x2, y2 };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean))].slice(0, 8);
  return items.length ? items : undefined;
}

function limitedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : undefined;
}

export function normalizeObservation(
  raw: Record<string, unknown>,
  meta: { frameId: string; capturedAt: number; requestSentAt: number; purpose: VisionObservation["purpose"] },
  source: VisionObservation["source"],
  model: string,
): VisionObservation {
  const objects = Array.isArray(raw.objects) ? raw.objects.slice(0, 30).map((item): DetectedObject | null => {
    const value = item as Record<string, unknown>;
    const label = limitedString(value.label, 100);
    if (!label) return null;
    const bbox = normalizeBox(value.bbox);
    return {
      label,
      aliases: stringArray(value.aliases),
      bbox,
      center: bbox ? { x: (bbox.x1 + bbox.x2) / 2, y: (bbox.y1 + bbox.y2) / 2 } : undefined,
      color: limitedString(value.color, 40),
      appearance: limitedString(value.appearance, 240),
      attributes: stringArray(value.attributes),
      spatialRelation: stringArray(value.spatialRelation),
      confidence: clamp(value.confidence),
      source,
    };
  }).filter((item): item is DetectedObject => item !== null) : [];

  const text = Array.isArray(raw.text) ? raw.text.slice(0, 50).map((item): OCRText | null => {
    const value = item as Record<string, unknown>;
    if (typeof value.text !== "string" || !value.text.trim()) return null;
    return { text: value.text.slice(0, 2_000), bbox: normalizeBox(value.bbox), confidence: value.confidence === undefined ? undefined : clamp(value.confidence) };
  }).filter((item): item is OCRText => item !== null) : [];

  const placementEvents = Array.isArray(raw.placementEvents) ? raw.placementEvents.slice(0, 4).map((item): PlacementObservation | null => {
    const value = item as Record<string, unknown>;
    const subject = limitedString(value.subject, 100);
    const relation = limitedString(value.relation, 80);
    const anchor = limitedString(value.anchor, 100);
    const location = limitedString(value.location, 240);
    if (value.type !== "PUT_DOWN" || !subject || !relation || !anchor || !location) return null;
    return {
      type: "PUT_DOWN",
      subject,
      relation,
      anchor,
      location,
      appearance: limitedString(value.appearance, 240),
      color: limitedString(value.color, 40),
      confidence: clamp(value.confidence),
    };
  }).filter((item): item is PlacementObservation => item !== null) : [];

  const goalRaw = raw.goalAssessment as Record<string, unknown> | undefined;
  const positions: SpatialPosition[] = ["far-left", "left", "center-left", "center", "center-right", "right", "far-right"];
  const guidances: NonNullable<GoalAssessment["guidance"]>[] = ["LEFT", "RIGHT", "CENTER", "HOLD", "NONE"];
  const candidateObjectIndex = Number(goalRaw?.candidateObjectIndex);
  const goalAssessment = goalRaw ? {
    relevant: Boolean(goalRaw.relevant),
    targetVisible: Boolean(goalRaw.targetVisible),
    candidateConfidence: clamp(goalRaw.candidateConfidence),
    candidateObjectIndex: Number.isInteger(candidateObjectIndex)
      && candidateObjectIndex >= 0
      && candidateObjectIndex < objects.length
      ? candidateObjectIndex
      : undefined,
    spatialPosition: positions.includes(goalRaw.spatialPosition as SpatialPosition) ? goalRaw.spatialPosition as SpatialPosition : undefined,
    guidance: guidances.includes(goalRaw.guidance as NonNullable<GoalAssessment["guidance"]>) ? goalRaw.guidance as NonNullable<GoalAssessment["guidance"]> : "NONE",
    shouldSpeak: Boolean(goalRaw.shouldSpeak),
    speech: typeof goalRaw.speech === "string" ? goalRaw.speech.slice(0, 280) : undefined,
  } satisfies GoalAssessment : undefined;

  const receivedAt = Date.now();
  const staleAfterMs = meta.purpose === "background" ? 7_000 : meta.purpose === "ocr" ? 15_000 : 20_000;
  const stale = receivedAt - meta.capturedAt > staleAfterMs;
  return {
    id: `obs-${meta.frameId}`,
    frameId: meta.frameId,
    capturedAt: meta.capturedAt,
    requestSentAt: meta.requestSentAt,
    receivedAt,
    freshness: stale ? "STALE" : "FRESH",
    purpose: meta.purpose,
    staleReason: stale ? `captured_${receivedAt - meta.capturedAt}ms_before_response` : undefined,
    sceneSummary: typeof raw.sceneSummary === "string" ? raw.sceneSummary.slice(0, 500) : "No reliable scene summary.",
    objects,
    text,
    cameraMotion: raw.cameraMotion === "medium" || raw.cameraMotion === "high" ? raw.cameraMotion : "low",
    source,
    goalAssessment,
    placementEvents,
    model,
  };
}
