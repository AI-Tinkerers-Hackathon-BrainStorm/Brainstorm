import { isTransientBodyPart, prefersChinese, queryMatchesSubject, subjectKey } from "../agent/ObjectIdentity.ts";
import type { CachedDetailedScene, DetectedObject, EpistemicState, MemoryEvent, TemporalEvent, VisionObservation } from "../types/index.ts";

function locationOf(object: DetectedObject): string {
  if (object.spatialRelation?.length) return object.spatialRelation.join(" ");
  const x = object.center?.x ?? (object.bbox ? (object.bbox.x1 + object.bbox.x2) / 2 : undefined);
  if (x === undefined) return "in the observed scene";
  return x < 0.36 ? "on the left side of the view" : x > 0.64 ? "on the right side of the view" : "near the center of the view";
}

function eventColor(event: MemoryEvent): string | undefined {
  return typeof event.attributes?.color === "string" ? event.attributes.color : undefined;
}

function eventLabel(event: MemoryEvent): string {
  return typeof event.attributes?.label === "string" ? event.attributes.label : event.subject;
}

function eventMatches(subject: string, requestedColor: string | undefined, event: MemoryEvent): boolean {
  const query = [requestedColor, subject].filter(Boolean).join(" ");
  const aliases = Array.isArray(event.attributes?.aliases) ? event.attributes.aliases.filter((item): item is string => typeof item === "string") : [];
  return [eventLabel(event), event.subject, ...aliases].some((name) => queryMatchesSubject(query, name, eventColor(event)));
}

export class EpisodicMemory {
  private events: MemoryEvent[];

  constructor(events: MemoryEvent[] = [], private readonly maxItems = 100) {
    this.events = events.slice(-maxItems);
  }

  remember(event: MemoryEvent): void {
    const duplicate = this.events.findIndex((item) => item.action === event.action && eventMatches(event.subject, eventColor(event), item));
    if (duplicate >= 0) {
      if (this.events[duplicate].timestamp > event.timestamp) return;
      this.events.splice(duplicate, 1);
    }
    if (event.epistemic === "LAST_SEEN") {
      this.events = this.events.filter((item) => item.epistemic !== "INFERRED" || !eventMatches(event.subject, eventColor(event), item));
    }
    this.events.push({ ...event, epistemic: event.epistemic === "UNKNOWN" ? "INFERRED" : event.epistemic });
    this.events = this.events.slice(-this.maxItems);
  }

  ingestObservation(observation: VisionObservation): MemoryEvent[] {
    const threshold = observation.purpose === "background" ? 0.72 : 0.58;
    const stable = observation.objects.filter((object) => object.confidence >= threshold && !isTransientBodyPart(object.label));
    const added: MemoryEvent[] = [];
    for (const [index, object] of stable.entries()) {
      const event: MemoryEvent = {
        id: `seen-${observation.frameId}-${index}`,
        timestamp: observation.capturedAt,
        subject: subjectKey(object.color, object.label),
        action: "LAST_SEEN",
        location: locationOf(object),
        attributes: {
          label: object.label,
          aliases: object.aliases,
          color: object.color,
          contextLabels: stable.filter((candidate) => candidate !== object).map((candidate) => candidate.label).slice(0, 6),
        },
        confidence: object.confidence,
        evidence: { frameIds: [observation.frameId], observationIds: [observation.id] },
        lastConfirmedAt: observation.capturedAt,
        epistemic: "LAST_SEEN",
      };
      this.remember(event);
      added.push(event);
    }
    return added;
  }

  recordDetailedScene(scene: CachedDetailedScene): MemoryEvent[] {
    return this.ingestObservation({
      id: scene.id,
      frameId: scene.id,
      capturedAt: scene.capturedAt,
      requestSentAt: scene.capturedAt,
      receivedAt: scene.receivedAt,
      freshness: "STALE",
      purpose: "detailed",
      sceneSummary: scene.sceneSummary,
      objects: scene.objects.map((object) => ({ ...object, source: "deep_vision" as const })),
      text: [],
      source: "deep_vision",
      model: scene.model,
    });
  }

  ingestAbsence(observation: VisionObservation, temporalEvents: readonly TemporalEvent[]): MemoryEvent[] {
    if (observation.cameraMotion !== "low") return [];
    const added: MemoryEvent[] = [];
    for (const [index, temporal] of temporalEvents.filter((event) => event.type === "DISAPPEARED" && event.confidence >= 0.55).entries()) {
      const lastSeen = [...this.events].reverse().find((event) => event.epistemic === "LAST_SEEN" && eventMatches(temporal.subject, undefined, event));
      if (!lastSeen || lastSeen.timestamp >= observation.capturedAt) continue;
      const event: MemoryEvent = {
        id: `absence-${observation.frameId}-${index}`,
        timestamp: observation.capturedAt,
        subject: lastSeen.subject,
        action: "MAY_HAVE_MOVED_OR_BEEN_OCCLUDED",
        location: lastSeen.location,
        attributes: { ...lastSeen.attributes, causeConfirmed: false },
        confidence: temporal.confidence,
        evidence: { frameIds: temporal.evidenceFrameIds, observationIds: [observation.id] },
        lastConfirmedAt: lastSeen.lastConfirmedAt,
        epistemic: "INFERRED",
      };
      this.remember(event);
      added.push(event);
    }
    return added;
  }

  recall(subject: string, current?: VisionObservation, requestedColor?: string): { state: EpistemicState; event?: MemoryEvent; object?: DetectedObject } {
    const query = [requestedColor, subject].filter(Boolean).join(" ");
    const visible = current?.objects.find((object) => queryMatchesSubject(query, object.label, object.color));
    if (visible && visible.confidence >= 0.58) return { state: "CURRENTLY_VISIBLE", object: visible };
    const event = [...this.events].reverse().find((item) => eventMatches(subject, requestedColor, item));
    return event ? { state: event.epistemic, event } : { state: "UNKNOWN" };
  }

  formatRecall(subject: string, current?: VisionObservation, requestedColor?: string): string {
    const result = this.recall(subject, current, requestedColor);
    const chinese = prefersChinese(subject);
    if (result.state === "CURRENTLY_VISIBLE" && result.object) {
      const name = subjectKey(result.object.color, result.object.label);
      return chinese ? `我现在能看到${name}，位置是${locationOf(result.object)}。` : `I can see ${name} ${locationOf(result.object)}.`;
    }
    if (result.event) {
      const location = result.event.location ? (chinese ? `在${result.event.location}` : ` ${result.event.location}`) : "";
      if (result.state === "INFERRED") {
        return chinese
          ? `我上次看到${result.event.subject}${location}。连续几个静止画面里都没有再看到它；它可能被移动或遮挡了，但原因无法确认。`
          : `I last saw ${result.event.subject}${location}. It was absent from several still views, so it may have been moved or occluded; I can’t confirm why.`;
      }
      return chinese
        ? `我上次看到${result.event.subject}${location}，但无法确认它现在还在那里。`
        : `I last saw ${result.event.subject}${location}. I can’t confirm it is still there.`;
    }
    return chinese ? `我还没有关于${subject}位置的可靠记忆。` : `I don’t have a reliable location memory for ${subject}.`;
  }

  all(): readonly MemoryEvent[] { return this.events; }
}
