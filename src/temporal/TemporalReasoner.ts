import type { DetectedObject, TemporalEvent, VisionObservation } from "../types/index.ts";

function area(object?: DetectedObject) {
  if (!object?.bbox) return 0;
  return Math.max(0, object.bbox.x2 - object.bbox.x1) * Math.max(0, object.bbox.y2 - object.bbox.y1);
}

function sameObject(a: DetectedObject, b: DetectedObject) {
  return a.id && b.id ? a.id === b.id : a.label.toLowerCase() === b.label.toLowerCase() && (!a.color || !b.color || a.color === b.color);
}

function center(object?: DetectedObject) {
  if (!object) return undefined;
  return object.center ?? (object.bbox ? { x: (object.bbox.x1 + object.bbox.x2) / 2, y: (object.bbox.y1 + object.bbox.y2) / 2 } : undefined);
}

export class TemporalReasoner {
  analyze(history: readonly VisionObservation[]): TemporalEvent[] {
    if (history.length < 2) return [];
    const current = history.at(-1)!;
    const previous = history.at(-2)!;
    const events: TemporalEvent[] = [];

    for (const object of previous.objects) {
      const now = current.objects.find((candidate) => sameObject(object, candidate));
      if (!now) {
        events.push({
          type: "NOT_IN_CURRENT_VIEW",
          subject: object.label,
          confidence: current.cameraMotion === "high" ? 0.9 : 0.65,
          evidenceFrameIds: [previous.frameId, current.frameId],
          description: current.cameraMotion === "high" ? "Camera moved; removal is not established." : "Object is not visible; occlusion or removal remains uncertain.",
        });
      }
    }

    if (history.length >= 3) {
      const last = history.slice(-3);
      if (last.some((item) => item.freshness === "STALE" || item.cameraMotion !== "low")) return events;
      for (const object of current.objects) {
        const sequence = last.map((item) => item.objects.find((candidate) => sameObject(object, candidate)));
        if (sequence.every(Boolean) && sequence.every((item) => (item?.confidence ?? 0) >= 0.78)) {
          const areas = sequence.map((item) => area(item));
          const centers = sequence.map((item) => center(item));
          const stableCenter = centers.every(Boolean)
            && Math.hypot(centers[2]!.x - centers[0]!.x, centers[2]!.y - centers[0]!.y) <= 0.12;
          if (stableCenter && areas[0] > 0 && areas[1] > areas[0] * 1.12 && areas[2] > areas[1] * 1.12) {
            events.push({
              type: "APPROACHING",
              subject: object.label,
              confidence: Math.min(0.95, 0.72 + (areas[2] / areas[0] - 1) * 0.2),
              evidenceFrameIds: last.map((item) => item.frameId),
              description: "Relative image area increased across three observations; no distance is inferred.",
            });
          }
        }
      }
    }
    return events;
  }
}
