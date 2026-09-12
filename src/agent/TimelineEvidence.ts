import type { CachedDetailedScene, MemoryEvent } from "../types/index.ts";

export function timelineEvidence(scenes: readonly CachedDetailedScene[], memory: readonly MemoryEvent[], now = Date.now()) {
  const recent = scenes.filter((scene) => now - scene.capturedAt >= 0 && now - scene.capturedAt <= 120_000)
    .sort((a, b) => a.capturedAt - b.capturedAt).slice(-6);
  const events = memory.filter((event) => now - event.timestamp >= 0 && now - event.timestamp <= 120_000)
    .sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  if (!recent.length && !events.length) return undefined;
  const latest = recent.at(-1);
  const age = Math.round((now - (latest?.capturedAt ?? events[0].timestamp)) / 1_000);
  const names = latest ? latest.objects.filter((item) => item.confidence >= 0.45).map((item) => [item.color, item.label].filter(Boolean).join(" ")) : events.map((item) => item.subject);
  const fallback = `In my recent observations (${age} seconds ago), I noted ${names.slice(0, 8).join(", ") || latest?.sceneSummary}. I can’t confirm the view is unchanged.`;
  const context = JSON.stringify({
    evidenceType: "HISTORICAL_OBSERVATIONS_NOT_LIVE_VIDEO",
    observations: recent.map((scene) => ({ capturedAt: scene.capturedAt, ageSeconds: Math.round((now - scene.capturedAt) / 1_000), summary: scene.sceneSummary.slice(0, 250),
      objects: scene.objects.filter((item) => item.confidence >= 0.45).slice(0, 6).map((item) => ({ label: item.label, color: item.color, confidence: item.confidence, location: item.spatialRelation })) })),
    memory: events.map((event) => ({ subject: event.subject, capturedAt: event.timestamp, location: event.location, state: event.epistemic })),
  });
  return { context, fallback };
}
