import type { DetectedObject, MemoryEvent, VisionObservation } from "../types/index.ts";
import { isTransientBodyPart, prefersChinese, queryMatchesSubject } from "./ObjectIdentity.ts";

const STRUCTURAL_LABEL = /^(?:wall|floor|ceiling|room|surface|background|墙|地面|天花板|房间|背景)$/i;

export function hasUsefulObjectInventory(observation: VisionObservation, target?: string, color?: string): boolean {
  const useful = observation.objects.filter((object) => object.confidence >= 0.45
    && !isTransientBodyPart(object.label)
    && !STRUCTURAL_LABEL.test(object.label.trim()));
  if (!useful.length) return false;
  if (!target) return true;
  const query = [color, target].filter(Boolean).join(" ");
  return useful.some((object) => queryMatchesSubject(query, object.label, object.color));
}

export function namedObject(object: Pick<DetectedObject, "label" | "color">): string {
  return object.color ? `${object.color} ${object.label}` : object.label;
}

export function composeSceneInventory(observation: VisionObservation, query = ""): string {
  const items = observation.objects
    .filter((object) => object.confidence >= 0.45)
    .map((object) => {
      const name = namedObject(object);
      const place = object.spatialRelation?.filter(Boolean).join(" ");
      return place ? `${name} ${place}` : name;
    })
    .slice(0, 12);
  if (prefersChinese(query)) {
    if (!items.length) return `我看到：${observation.sceneSummary}`;
    return `我能看到${items.join("，")}。`;
  }
  if (!items.length) return `I can see: ${observation.sceneSummary}`;
  return `I can see ${items.join(", ")}.`;
}

export function composeAbsenceReply(subject: string, lastSeen?: MemoryEvent, query = ""): string {
  const location = lastSeen?.location ? ` ${lastSeen.location}` : "";
  if (prefersChinese(query || subject)) {
    return `我上次看到${subject}${location}。现在画面里看不到。它可能被挪走、被挡住，或者被拿起来了。我无法确认发生了什么。`;
  }
  return `I last saw ${subject}${location}. It’s not in the current view; it may have been moved, covered, or picked up. I can’t confirm what happened.`;
}

export function scanAddsNewObjects(previous: VisionObservation | undefined, next: VisionObservation): boolean {
  if (!previous) return next.objects.some((object) => object.confidence >= 0.45);
  const seen = new Set(previous.objects.map((object) => namedObject(object).toLowerCase()));
  return next.objects.some((object) => object.confidence >= 0.45 && !seen.has(namedObject(object).toLowerCase()));
}
