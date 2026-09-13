import type { DetectedObject, RecentObjectMemoryRecord, VisionObservation } from "../types/index.ts";

export type { RecentObjectMemoryRecord } from "../types/index.ts";

export const RECENT_OBJECT_MEMORY_WINDOW_MS = 300_000;
export const RECENT_OBJECT_MEMORY_MAX_ITEMS = 500;

const MIN_OBJECT_CONFIDENCE = 0.45;
const MAX_EVIDENCE_ITEMS = 12;
export const APPEARANCE_MATCH_THRESHOLD = 0.6;
const APPEARANCE_STOP_WORDS = new Set([
  "a", "an", "and", "the", "with", "of", "has", "have", "having", "feature", "features", "featuring",
]);

function clean(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned || undefined;
}

function normalized(value: string | undefined): string {
  return clean(value)?.toLowerCase() ?? "";
}

export function appearanceTokens(value: string | undefined): string[] {
  return [...new Set(normalized(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !APPEARANCE_STOP_WORDS.has(token)))]
    .sort();
}

export function appearanceSimilarity(left: string | undefined, right: string | undefined): number {
  const leftTokens = appearanceTokens(left);
  const rightTokens = appearanceTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const containment = overlap / Math.min(leftTokens.length, rightTokens.length);
  return (overlap / union) * 0.6 + containment * 0.4;
}

function uniqueStrings(values: readonly (string | undefined)[], maxItems = 12): string[] | undefined {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = clean(value);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result.length ? result : undefined;
}

function appendEvidence(current: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...current, ...incoming].filter(Boolean))].slice(-MAX_EVIDENCE_ITEMS);
}

export function recentObjectIdentity(object: Pick<DetectedObject, "label" | "color" | "appearance">): string {
  return [normalized(object.label), normalized(object.color), appearanceTokens(object.appearance).join(" ")].join("|");
}

function subjectMatches(subject: string, record: RecentObjectMemoryRecord): boolean {
  const query = normalized(subject);
  if (!query) return false;
  const names = [record.label, ...(record.aliases ?? [])].map(normalized).filter(Boolean);
  const descriptiveNames = names.flatMap((name) => [name, [normalized(record.color), name].filter(Boolean).join(" ")]);
  return descriptiveNames.some((name) => query.includes(name) || name.includes(query));
}

function sanitizedRecord(record: RecentObjectMemoryRecord): RecentObjectMemoryRecord | undefined {
  const label = clean(record.label);
  const firstSeenAt = Number(record.firstSeenAt);
  const lastSeenAt = Number(record.lastSeenAt);
  const confidence = Number(record.confidence);
  if (!label || !Number.isFinite(firstSeenAt) || !Number.isFinite(lastSeenAt) || !Number.isFinite(confidence)) return undefined;
  const color = clean(record.color);
  const appearance = clean(record.appearance);
  const suppliedIdentity = clean(record.identityKey)?.toLowerCase();
  return {
    identityKey: suppliedIdentity && suppliedIdentity.length <= 512
      ? suppliedIdentity
      : recentObjectIdentity({ label, color, appearance }),
    label,
    aliases: uniqueStrings(record.aliases ?? []),
    color,
    appearance,
    attributes: uniqueStrings(record.attributes ?? []),
    spatialRelation: uniqueStrings(record.spatialRelation ?? [], 8),
    confidence: Math.max(0, Math.min(1, confidence)),
    firstSeenAt: Math.min(firstSeenAt, lastSeenAt),
    lastSeenAt: Math.max(firstSeenAt, lastSeenAt),
    seenCount: Math.max(1, Math.floor(Number(record.seenCount) || 1)),
    evidence: {
      frameIds: appendEvidence([], record.evidence?.frameIds ?? []),
      observationIds: appendEvidence([], record.evidence?.observationIds ?? []),
    },
    epistemic: "LAST_SEEN",
  };
}

export class RecentObjectMemory {
  private records = new Map<string, RecentObjectMemoryRecord>();

  constructor(
    records: RecentObjectMemoryRecord[] = [],
    private readonly maxItems = RECENT_OBJECT_MEMORY_MAX_ITEMS,
    private readonly windowMs = RECENT_OBJECT_MEMORY_WINDOW_MS,
  ) {
    this.merge(records);
  }

  observe(observation: VisionObservation): RecentObjectMemoryRecord[] {
    if (observation.freshness !== "FRESH") return [];
    this.prune(observation.capturedAt);
    const strongestByIdentity = new Map<string, DetectedObject>();
    for (const object of observation.objects) {
      if (object.confidence < MIN_OBJECT_CONFIDENCE || !clean(object.label)) continue;
      const identityKey = this.resolveIdentity(object);
      const current = strongestByIdentity.get(identityKey);
      if (!current || object.confidence > current.confidence) strongestByIdentity.set(identityKey, object);
    }

    const changed: RecentObjectMemoryRecord[] = [];
    for (const [identityKey, object] of strongestByIdentity) {
      const previous = this.records.get(identityKey);
      const label = clean(object.label)!;
      const next: RecentObjectMemoryRecord = {
        identityKey,
        label,
        aliases: uniqueStrings([...(previous?.aliases ?? []), ...(object.aliases ?? [])]),
        color: clean(object.color) ?? previous?.color,
        appearance: clean(object.appearance) ?? previous?.appearance,
        attributes: uniqueStrings([...(previous?.attributes ?? []), ...(object.attributes ?? [])]),
        spatialRelation: uniqueStrings(object.spatialRelation ?? [], 8) ?? previous?.spatialRelation,
        confidence: Math.max(0, Math.min(1, object.confidence)),
        firstSeenAt: previous ? Math.min(previous.firstSeenAt, observation.capturedAt) : observation.capturedAt,
        lastSeenAt: previous ? Math.max(previous.lastSeenAt, observation.capturedAt) : observation.capturedAt,
        seenCount: (previous?.seenCount ?? 0) + 1,
        evidence: {
          frameIds: appendEvidence(previous?.evidence.frameIds ?? [], [observation.frameId]),
          observationIds: appendEvidence(previous?.evidence.observationIds ?? [], [observation.id]),
        },
        epistemic: "LAST_SEEN",
      };
      this.records.set(identityKey, next);
      changed.push(next);
    }
    this.enforceLimit();
    return changed;
  }

  merge(records: readonly RecentObjectMemoryRecord[], now = Date.now()): void {
    this.prune(now);
    for (const rawRecord of records) {
      const incoming = sanitizedRecord(rawRecord);
      if (!incoming || incoming.lastSeenAt < now - this.windowMs) continue;
      const resolvedIdentity = this.resolveIdentity(incoming);
      incoming.identityKey = resolvedIdentity;
      const current = this.records.get(resolvedIdentity);
      if (!current) {
        this.records.set(resolvedIdentity, incoming);
        continue;
      }
      const newer = incoming.lastSeenAt >= current.lastSeenAt ? incoming : current;
      const older = newer === incoming ? current : incoming;
      this.records.set(resolvedIdentity, {
        ...older,
        ...newer,
        identityKey: resolvedIdentity,
        aliases: uniqueStrings([...(current.aliases ?? []), ...(incoming.aliases ?? [])]),
        attributes: uniqueStrings([...(current.attributes ?? []), ...(incoming.attributes ?? [])]),
        firstSeenAt: Math.min(current.firstSeenAt, incoming.firstSeenAt),
        lastSeenAt: Math.max(current.lastSeenAt, incoming.lastSeenAt),
        seenCount: Math.max(current.seenCount, incoming.seenCount),
        evidence: {
          frameIds: appendEvidence(current.evidence.frameIds, incoming.evidence.frameIds),
          observationIds: appendEvidence(current.evidence.observationIds, incoming.evidence.observationIds),
        },
        epistemic: "LAST_SEEN",
      });
    }
    this.enforceLimit();
  }

  recall(subject: string, now = Date.now()): RecentObjectMemoryRecord | undefined {
    this.prune(now);
    return [...this.records.values()]
      .filter((record) => subjectMatches(subject, record))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
  }

  all(now = Date.now()): readonly RecentObjectMemoryRecord[] {
    this.prune(now);
    return [...this.records.values()].sort((left, right) => left.lastSeenAt - right.lastSeenAt);
  }

  clear(): void {
    this.records.clear();
  }

  private resolveIdentity(object: Pick<DetectedObject, "label" | "aliases" | "color" | "appearance">): string {
    const exactIdentity = recentObjectIdentity(object);
    if (this.records.has(exactIdentity)) return exactIdentity;
    const objectNames = [object.label, ...(object.aliases ?? [])].map(normalized).filter(Boolean);
    const objectColor = normalized(object.color);
    const candidates = [...this.records.values()].filter((record) => {
      const recordNames = [record.label, ...(record.aliases ?? [])].map(normalized).filter(Boolean);
      const sameName = objectNames.some((name) => recordNames.includes(name));
      const recordColor = normalized(record.color);
      return sameName && (!objectColor || !recordColor || objectColor === recordColor);
    });
    if (!candidates.length) return exactIdentity;
    if (!appearanceTokens(object.appearance).length) {
      return candidates.length === 1 ? candidates[0].identityKey : exactIdentity;
    }
    const ranked = candidates
      .map((record) => ({ record, score: appearanceSimilarity(object.appearance, record.appearance) }))
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.score >= APPEARANCE_MATCH_THRESHOLD ? ranked[0].record.identityKey : exactIdentity;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, record] of this.records) {
      if (record.lastSeenAt < cutoff) this.records.delete(key);
    }
  }

  private enforceLimit(): void {
    const overflow = this.records.size - this.maxItems;
    if (overflow <= 0) return;
    const oldest = [...this.records.values()].sort((left, right) => left.lastSeenAt - right.lastSeenAt).slice(0, overflow);
    for (const record of oldest) this.records.delete(record.identityKey);
  }
}
