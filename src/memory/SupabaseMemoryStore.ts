"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { AgentSnapshot } from "../agent/AgentOrchestrator.ts";
import type { RecentObjectMemoryRecord } from "./RecentObjectMemory.ts";
import type { MemoryEvent } from "../types/index.ts";
import {
  ensureSupabaseMemorySession,
  getSupabaseBrowserClient,
  getSupabaseMemorySession,
  isSupabaseMemoryConfigured,
} from "../lib/supabase/browser.ts";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_EVENT_BATCH = 50;
const MAX_RECENT_BATCH = 50;

export type MemorySyncStatus = "connecting" | "synced" | "local-only" | "error";

export interface HydratedMemory {
  events: MemoryEvent[];
  recentObjects: RecentObjectMemoryRecord[];
  status: MemorySyncStatus;
}

export interface SupabaseMemoryDependencies {
  isConfigured: () => boolean;
  getClient: () => SupabaseClient | undefined;
  ensureSession: () => Promise<Session | undefined>;
  getSession: () => Promise<Session | undefined>;
}

const DEFAULT_DEPENDENCIES: SupabaseMemoryDependencies = {
  isConfigured: isSupabaseMemoryConfigured,
  getClient: getSupabaseBrowserClient,
  ensureSession: ensureSupabaseMemorySession,
  getSession: getSupabaseMemorySession,
};

type EventRow = {
  client_event_id: string;
  event_type: string;
  subject_label: string;
  location_text: string | null;
  relation: string | null;
  anchor_label: string | null;
  appearance: string | null;
  attributes: Record<string, unknown>;
  confidence: number;
  evidence_frame_ids: string[];
  evidence_observation_ids: string[];
  captured_at: string;
  last_confirmed_at: string | null;
  epistemic_state: MemoryEvent["epistemic"];
};

type RecentRow = {
  identity_key: string;
  label: string;
  aliases: string[];
  color: string | null;
  appearance: string | null;
  attributes: string[];
  spatial_relations: string[];
  confidence: number;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  evidence_frame_ids: string[];
  evidence_observation_ids: string[];
};

type Pending<T> = { value: T; signature: string };

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function signature(value: unknown): string {
  return JSON.stringify(value);
}

function eventFromRow(row: Record<string, unknown>): MemoryEvent {
  return {
    id: String(row.client_event_id),
    timestamp: timestamp(row.captured_at as string),
    subject: String(row.subject_label),
    action: String(row.event_type),
    location: typeof row.location_text === "string" ? row.location_text : undefined,
    relation: typeof row.relation === "string" ? row.relation : undefined,
    anchor: typeof row.anchor_label === "string" ? row.anchor_label : undefined,
    appearance: typeof row.appearance === "string" ? row.appearance : undefined,
    attributes: row.attributes && typeof row.attributes === "object" ? row.attributes as Record<string, unknown> : undefined,
    confidence: Number(row.confidence),
    evidence: {
      frameIds: Array.isArray(row.evidence_frame_ids) ? row.evidence_frame_ids.map(String) : [],
      observationIds: Array.isArray(row.evidence_observation_ids) ? row.evidence_observation_ids.map(String) : [],
    },
    lastConfirmedAt: typeof row.last_confirmed_at === "string" ? timestamp(row.last_confirmed_at) : undefined,
    epistemic: row.epistemic_state === "LAST_SEEN" ? "LAST_SEEN" : row.epistemic_state === "UNKNOWN" ? "UNKNOWN" : "INFERRED",
  };
}

function recentFromRow(row: Record<string, unknown>): RecentObjectMemoryRecord {
  return {
    identityKey: String(row.identity_key),
    label: String(row.label),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : undefined,
    color: typeof row.color === "string" ? row.color : undefined,
    appearance: typeof row.appearance === "string" ? row.appearance : undefined,
    attributes: Array.isArray(row.attributes) ? row.attributes.map(String) : undefined,
    spatialRelation: Array.isArray(row.spatial_relations) ? row.spatial_relations.map(String) : undefined,
    confidence: Number(row.confidence),
    firstSeenAt: timestamp(row.first_seen_at as string),
    lastSeenAt: timestamp(row.last_seen_at as string),
    seenCount: Number(row.seen_count),
    evidence: {
      frameIds: Array.isArray(row.evidence_frame_ids) ? row.evidence_frame_ids.map(String) : [],
      observationIds: Array.isArray(row.evidence_observation_ids) ? row.evidence_observation_ids.map(String) : [],
    },
    epistemic: "LAST_SEEN",
  };
}

function eventToRpc(event: MemoryEvent): EventRow {
  return {
    client_event_id: event.id,
    event_type: event.action,
    subject_label: event.subject,
    location_text: event.location ?? null,
    relation: event.relation ?? null,
    anchor_label: event.anchor ?? null,
    appearance: event.appearance ?? null,
    attributes: event.attributes ?? {},
    confidence: event.confidence,
    evidence_frame_ids: event.evidence.frameIds.slice(-8),
    evidence_observation_ids: event.evidence.observationIds.slice(-8),
    captured_at: new Date(event.timestamp).toISOString(),
    last_confirmed_at: event.lastConfirmedAt ? new Date(event.lastConfirmedAt).toISOString() : null,
    epistemic_state: event.epistemic,
  };
}

function recentToRpc(record: RecentObjectMemoryRecord): RecentRow {
  return {
    identity_key: record.identityKey,
    label: record.label,
    aliases: record.aliases ?? [],
    color: record.color ?? null,
    appearance: record.appearance ?? null,
    attributes: record.attributes ?? [],
    spatial_relations: record.spatialRelation ?? [],
    confidence: record.confidence,
    first_seen_at: new Date(record.firstSeenAt).toISOString(),
    last_seen_at: new Date(record.lastSeenAt).toISOString(),
    seen_count: record.seenCount,
    evidence_frame_ids: record.evidence.frameIds.slice(-8),
    evidence_observation_ids: record.evidence.observationIds.slice(-8),
  };
}

export class SupabaseMemoryStore {
  private ownerId?: string;
  private ownerPromise?: Promise<Session | undefined>;
  private timer?: ReturnType<typeof setTimeout>;
  private flushPromise?: Promise<void>;
  private stopped = false;
  private retryDelayMs = FLUSH_INTERVAL_MS;
  private retryNotBefore = 0;
  private readonly pendingEvents = new Map<string, Pending<MemoryEvent>>();
  private readonly pendingRecent = new Map<string, Pending<RecentObjectMemoryRecord>>();
  private readonly syncedEventSignatures = new Map<string, string>();
  private readonly syncedRecentSignatures = new Map<string, string>();

  constructor(
    private readonly onStatus: (status: MemorySyncStatus) => void = () => undefined,
    private readonly dependencies: SupabaseMemoryDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async load(): Promise<HydratedMemory> {
    if (!this.dependencies.isConfigured()) {
      this.onStatus("local-only");
      return { events: [], recentObjects: [], status: "local-only" };
    }
    this.onStatus("connecting");
    const client = this.dependencies.getClient();
    const session = await this.pinInitialOwner();
    if (!client || !session) {
      this.onStatus("local-only");
      return { events: [], recentObjects: [], status: "local-only" };
    }
    const [eventsResult, recentResult] = await Promise.all([
      client.from("episodic_memory_events")
        .select("client_event_id,event_type,subject_label,location_text,relation,anchor_label,appearance,attributes,confidence,evidence_frame_ids,evidence_observation_ids,captured_at,last_confirmed_at,epistemic_state")
        .eq("owner_id", this.ownerId)
        .order("captured_at", { ascending: false })
        .limit(100),
      client.rpc("read_recent_object_memories"),
    ]);
    if (eventsResult.error) throw eventsResult.error;
    if (recentResult.error) throw recentResult.error;

    const events = (eventsResult.data ?? []).map((row) => eventFromRow(row)).reverse();
    const recentObjects = (recentResult.data ?? []).map((row: Record<string, unknown>) => recentFromRow(row));
    for (const event of events) this.syncedEventSignatures.set(event.id, signature(event));
    for (const record of recentObjects) this.syncedRecentSignatures.set(record.identityKey, signature(record));
    this.retryDelayMs = FLUSH_INTERVAL_MS;
    this.retryNotBefore = 0;
    this.onStatus("synced");
    if (this.pendingEvents.size || this.pendingRecent.size) this.scheduleFlush(0);
    return { events, recentObjects, status: "synced" };
  }

  queueSnapshot(snapshot: Pick<AgentSnapshot, "memory" | "recentObjects">): void {
    if (this.stopped || !this.dependencies.isConfigured()) return;
    let eventChanged = false;
    for (const event of snapshot.memory) {
      const nextSignature = signature(event);
      if (this.syncedEventSignatures.get(event.id) === nextSignature
        || this.pendingEvents.get(event.id)?.signature === nextSignature) continue;
      this.pendingEvents.set(event.id, { value: event, signature: nextSignature });
      eventChanged = true;
    }
    for (const record of snapshot.recentObjects) {
      const nextSignature = signature(record);
      if (this.syncedRecentSignatures.get(record.identityKey) === nextSignature
        || this.pendingRecent.get(record.identityKey)?.signature === nextSignature) continue;
      this.pendingRecent.set(record.identityKey, { value: record, signature: nextSignature });
    }
    if (!this.pendingEvents.size && !this.pendingRecent.size) return;
    const retryWaitMs = this.retryNotBefore - Date.now();
    if (retryWaitMs > 0) {
      this.scheduleFlush(retryWaitMs);
      return;
    }
    if (eventChanged || this.pendingRecent.size >= 20) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPending()
      .then(() => {
        this.retryDelayMs = FLUSH_INTERVAL_MS;
        this.retryNotBefore = 0;
      })
      .catch(() => {
        this.onStatus("error");
        this.retryNotBefore = Date.now() + this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      })
      .finally(() => { this.flushPromise = undefined; });
    await this.flushPromise;
    if (this.pendingEvents.size || this.pendingRecent.size) {
      const retryWaitMs = this.retryNotBefore - Date.now();
      this.scheduleFlush(retryWaitMs > 0 ? retryWaitMs : FLUSH_INTERVAL_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleFlush(delayMs = FLUSH_INTERVAL_MS): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingEvents.size && !this.pendingRecent.size) return;
    const client = this.dependencies.getClient();
    const session = this.ownerId
      ? await this.dependencies.getSession()
      : await this.pinInitialOwner();
    if (!this.ownerId) {
      throw new Error("Supabase memory has not pinned an authenticated owner yet.");
    }
    if (!client || !session || session.user.id !== this.ownerId) {
      this.stop();
      throw new Error("The Supabase memory owner changed; pending writes were stopped.");
    }
    const events = [...this.pendingEvents.values()];
    const recent = [...this.pendingRecent.values()];
    this.pendingEvents.clear();
    this.pendingRecent.clear();
    try {
      for (let offset = 0; offset < events.length; offset += MAX_EVENT_BATCH) {
        const batch = events.slice(offset, offset + MAX_EVENT_BATCH).map((item) => eventToRpc(item.value));
        const result = await client.rpc("upsert_episodic_memory_events", { events: batch });
        if (result.error) throw result.error;
      }
      for (let offset = 0; offset < recent.length; offset += MAX_RECENT_BATCH) {
        const batch = recent.slice(offset, offset + MAX_RECENT_BATCH).map((item) => recentToRpc(item.value));
        const result = await client.rpc("merge_recent_object_sightings", { sightings: batch });
        if (result.error) throw result.error;
      }
      for (const item of events) this.syncedEventSignatures.set(item.value.id, item.signature);
      for (const item of recent) this.syncedRecentSignatures.set(item.value.identityKey, item.signature);
      this.onStatus("synced");
    } catch (error) {
      for (const item of events) if (!this.pendingEvents.has(item.value.id)) this.pendingEvents.set(item.value.id, item);
      for (const item of recent) if (!this.pendingRecent.has(item.value.identityKey)) this.pendingRecent.set(item.value.identityKey, item);
      this.onStatus("error");
      throw error;
    }
  }

  private async pinInitialOwner(): Promise<Session | undefined> {
    if (this.ownerId) return this.dependencies.getSession();
    if (!this.ownerPromise) {
      const pending = this.dependencies.ensureSession()
        .then((session) => {
          if (session) this.ownerId = session.user.id;
          return session;
        })
        .finally(() => {
          if (this.ownerPromise === pending) this.ownerPromise = undefined;
        });
      this.ownerPromise = pending;
    }
    return this.ownerPromise;
  }
}
