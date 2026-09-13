import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { AgentStateMachine } from "../agent/AgentStateMachine.ts";
import { AgentOrchestrator } from "../agent/AgentOrchestrator.ts";
import { composeAbsenceReply, composeSceneInventory, hasUsefulObjectInventory, scanAddsNewObjects } from "../agent/EvidenceReply.ts";
import { parseGoal, parseUserIntent } from "../agent/GoalParser.ts";
import { queryMatchesSubject } from "../agent/ObjectIdentity.ts";
import { REALTIME_AGENT_SYSTEM_PROMPT, visionPrompt } from "../agent/prompts.ts";
import { ASR_WATCHDOG_MS, shouldFallbackUnansweredTurn } from "../agent/TurnWatchdog.ts";
import { SaliencePolicy } from "../agent/SaliencePolicy.ts";
import { ToolDispatcher } from "../agent/ToolDispatcher.ts";
import { EpisodicMemory } from "../memory/EpisodicMemory.ts";
import { RecentObjectMemory } from "../memory/RecentObjectMemory.ts";
import { SupabaseMemoryStore, type SupabaseMemoryDependencies } from "../memory/SupabaseMemoryStore.ts";
import { WorkingMemory } from "../memory/WorkingMemory.ts";
import { DetailedSceneMemory } from "../memory/DetailedSceneMemory.ts";
import { LatestFrameProcessor } from "../media/LatestFrameProcessor.ts";
import { hasAudibleSpeech, newFinalTranscripts, pcmToWav, shouldUseSpeechSynthesis, TranscriptDeduper } from "../media/AudioManager.ts";
import { hasLiveVideoTrack, isVideoFrameReady, waitForCapturableFrame, waitForFreshVideoFrame, waitForVideoFrame } from "../media/CameraManager.ts";
import { AdaptiveQualityController } from "../performance/AdaptiveQualityController.ts";
import { EntityTracker } from "../temporal/EntityTracker.ts";
import { TemporalReasoner } from "../temporal/TemporalReasoner.ts";
import { parseJsonContent } from "../providers/server/QwenClient.ts";
import { normalizeObservation } from "../providers/server/normalize.ts";
import { VISION_RESPONSE_FORMAT } from "../providers/server/VisionSchema.ts";
import { selectVisionRoute } from "../providers/server/VisionRouting.ts";
import { runFastWithMaxFallback, shouldTryMaxAfterFastFailure, VisionClientError } from "../providers/DeepVisionProvider.ts";
import { canReportWebRtcConnected, QwenRealtimeProvider, shouldEmitRealtimeAgentOutput } from "../providers/QwenRealtimeProvider.ts";
import type { AgentGoal, DetectedObject, MemoryEvent, RecentObjectMemoryRecord, VisionObservation } from "../types/index.ts";

function observation(id: string, capturedAt: number, objects: DetectedObject[] = [], cameraMotion: VisionObservation["cameraMotion"] = "low"): VisionObservation {
  return {
    id: `obs-${id}`, frameId: id, capturedAt, requestSentAt: capturedAt + 1, receivedAt: capturedAt + 2,
    freshness: "FRESH", purpose: "background", sceneSummary: "test scene", objects, text: [], cameraMotion, source: "deep_vision",
  };
}

function bottle(x1: number, x2: number, confidence = 0.9): DetectedObject {
  return { label: "bottle", color: "red", bbox: { x1, y1: 0.2, x2, y2: 0.8 }, confidence, source: "deep_vision" };
}

function notebook(confidence = 0.92): DetectedObject {
  return {
    label: "notebook",
    color: "silver",
    bbox: { x1: 0.3, y1: 0.35, x2: 0.55, y2: 0.75 },
    confidence,
    source: "deep_vision",
  };
}

function supabaseSession(id: string): Session {
  return { user: { id } } as Session;
}

function fakeSupabaseClient(calls: string[]): SupabaseClient {
  return {
    from(table: string) {
      calls.push(`select:${table}`);
      const query = {
        select() { return query; },
        eq() { return query; },
        order() { return query; },
        limit: async () => ({ data: [], error: null }),
      };
      return query;
    },
    async rpc(name: string, parameters?: Record<string, unknown>) {
      calls.push(`rpc:${name}`);
      if (parameters?.expected_owner) calls.push(`owner:${String(parameters.expected_owner)}`);
      return { data: name === "read_recent_object_memories" ? [] : 1, error: null };
    },
  } as unknown as SupabaseClient;
}

function cup(confidence = 0.88): DetectedObject {
  return { label: "cup", color: "red", spatialRelation: ["on the table"], confidence, source: "deep_vision" };
}

test("AgentStateMachine permits mode-specific transitions and rejects invalid ones", () => {
  const state = new AgentStateMachine();
  state.setMode("FIND");
  state.transition("VERIFYING");
  assert.equal(state.status, "VERIFYING");
  assert.throws(() => state.transition("READING"), /Invalid FIND transition/);
});

test("WorkingMemory stays time and size bounded", () => {
  const memory = new WorkingMemory(2, 100);
  memory.add(observation("1", 0));
  memory.add(observation("2", 50));
  memory.add(observation("3", 120));
  assert.deepEqual(memory.all().map((item) => item.frameId), ["2", "3"]);
});

test("Max detailed results are cached as bounded last-seen structured scenes", () => {
  const memory = new DetailedSceneMemory([], 2);
  for (let index = 1; index <= 3; index += 1) {
    memory.add({ ...observation(String(index), index, [bottle(0.2, 0.4)]), purpose: "detailed", model: "max-model" });
  }
  assert.deepEqual(memory.all().map((item) => item.id), ["detailed-2", "detailed-3"]);
  assert.equal(memory.latest()?.epistemic, "LAST_SEEN");
  assert.deepEqual(memory.latest()?.objects.map((item) => item.label), ["bottle"]);
});

test("EpisodicMemory never promotes last seen to currently visible", () => {
  const event: MemoryEvent = {
    id: "m1", timestamp: 100, subject: "keys", action: "LAST_SEEN", location: "on the desk beside the laptop",
    confidence: 0.87, evidence: { frameIds: ["1"], observationIds: ["obs-1"] }, epistemic: "LAST_SEEN",
  };
  const memory = new EpisodicMemory([event]);
  assert.equal(memory.recall("keys").state, "LAST_SEEN");
  assert.match(memory.formatRecall("keys"), /last saw/i);
  assert.match(memory.formatRecall("keys"), /can’t confirm/i);
  const current = observation("2", 200, [{ label: "keys", confidence: 0.91, source: "deep_vision" }]);
  assert.equal(memory.recall("keys", current, undefined, 200).state, "CURRENTLY_VISIBLE");
  assert.equal(memory.recall("keys", current, undefined, 5_201).state, "LAST_SEEN");
});

test("RecentObjectMemory records every fresh recognizable object, merges sightings, and expires at five minutes", () => {
  const memory = new RecentObjectMemory([], 500, 300_000);
  memory.observe({
    ...observation("one", 1_000, [
      { ...bottle(0.6, 0.75), appearance: "matte red metal bottle with black cap", spatialRelation: ["right of the notebook", "on the desk"] },
      { label: "blur", confidence: 0.44, source: "deep_vision" },
    ]),
  });
  memory.observe({
    ...observation("two", 2_000, [
      { ...bottle(0.62, 0.77, 0.86), label: " Bottle ", color: " RED ", appearance: "black cap, matte metal red bottle", spatialRelation: ["beside the notebook"] },
    ]),
  });
  memory.observe(observation("three", 3_000, [
    { ...bottle(0.63, 0.78, 0.84), appearance: undefined, spatialRelation: ["right of the notebook"] },
  ]));

  const [record] = memory.all(3_000);
  assert.equal(record.identityKey, "bottle|red|black bottle cap matte metal red");
  assert.equal(record.firstSeenAt, 1_000);
  assert.equal(record.lastSeenAt, 3_000);
  assert.equal(record.seenCount, 3);
  assert.deepEqual(record.spatialRelation, ["right of the notebook"]);
  assert.deepEqual(record.evidence.frameIds, ["one", "two", "three"]);
  assert.equal(memory.recall("my red bottle", 3_000)?.identityKey, record.identityKey);
  assert.equal(memory.all(303_001).length, 0);
});

test("RecentObjectMemory hydration is idempotent and merges with live sightings", () => {
  const now = Date.now();
  const memory = new RecentObjectMemory();
  memory.observe(observation("local", now, [{ ...bottle(0.6, 0.75), appearance: "red bottle" }]));
  const remote: RecentObjectMemoryRecord = {
    identityKey: "keys||brass keys",
    label: "keys",
    appearance: "brass keys",
    confidence: 0.8,
    firstSeenAt: now - 500,
    lastSeenAt: now - 100,
    seenCount: 2,
    evidence: { frameIds: ["remote"], observationIds: ["obs-remote"] },
    epistemic: "LAST_SEEN",
  };
  memory.merge([remote], now);
  memory.merge([remote], now);
  assert.deepEqual(memory.all(now).map((item) => item.label).sort(), ["bottle", "keys"]);
  assert.equal(memory.recall("keys", now)?.seenCount, 2);
});

test("SupabaseMemoryStore queues before hydration and pins all writes to one auth UID", async () => {
  const calls: string[] = [];
  const client = fakeSupabaseClient(calls);
  let activeSession = supabaseSession("owner-a");
  let ensureCalls = 0;
  let releaseSession!: (session: Session) => void;
  const initialSession = new Promise<Session>((resolve) => { releaseSession = resolve; });
  const dependencies: SupabaseMemoryDependencies = {
    isConfigured: () => true,
    getClient: () => client,
    ensureSession: async () => {
      ensureCalls += 1;
      return initialSession;
    },
    getSession: async () => activeSession,
  };
  const store = new SupabaseMemoryStore(() => undefined, dependencies);
  const event: MemoryEvent = {
    id: "queued-placement",
    timestamp: Date.now(),
    subject: "bottle",
    action: "PUT_DOWN",
    location: "right of the notebook",
    relation: "right of",
    anchor: "notebook",
    appearance: "matte red metal bottle",
    confidence: 0.9,
    evidence: { frameIds: ["frame-a"], observationIds: ["obs-a"] },
    epistemic: "LAST_SEEN",
  };

  const loading = store.load();
  store.queueSnapshot({ memory: [event], recentObjects: [] });
  await Promise.resolve();
  assert.equal(calls.filter((call) => call === "rpc:upsert_episodic_memory_events").length, 0);
  releaseSession(activeSession);
  await loading;
  await store.flush();
  assert.equal(calls.filter((call) => call === "rpc:upsert_episodic_memory_events").length, 1);
  assert.ok(calls.includes("owner:owner-a"));
  assert.equal(ensureCalls, 1);

  activeSession = supabaseSession("owner-b");
  store.queueSnapshot({ memory: [{ ...event, location: "changed after UID switch" }], recentObjects: [] });
  await store.flush();
  assert.equal(calls.filter((call) => call === "rpc:upsert_episodic_memory_events").length, 1);
  assert.equal(ensureCalls, 1);
});

test("SupabaseMemoryStore retries initial session setup when a new snapshot arrives", async () => {
  const calls: string[] = [];
  const client = fakeSupabaseClient(calls);
  const session = supabaseSession("owner-a");
  let ensureCalls = 0;
  const dependencies: SupabaseMemoryDependencies = {
    isConfigured: () => true,
    getClient: () => client,
    ensureSession: async () => {
      ensureCalls += 1;
      if (ensureCalls === 1) throw new Error("temporary auth failure");
      return session;
    },
    getSession: async () => session,
  };
  const store = new SupabaseMemoryStore(() => undefined, dependencies);
  await assert.rejects(store.load(), /temporary auth failure/i);
  store.queueSnapshot({
    memory: [{
      id: "retry-placement", timestamp: Date.now(), subject: "bottle", action: "PUT_DOWN",
      location: "to the right of notebook", relation: "right of", anchor: "notebook",
      appearance: "matte red bottle", confidence: 0.9,
      evidence: { frameIds: ["retry-frame"], observationIds: ["retry-observation"] }, epistemic: "LAST_SEEN",
    }],
    recentObjects: [],
  });
  await store.flush();
  assert.equal(ensureCalls, 2);
  assert.equal(calls.filter((call) => call === "rpc:upsert_episodic_memory_events").length, 1);
});

test("SupabaseMemoryStore never writes after stop when initial auth resolves late", async () => {
  const calls: string[] = [];
  const client = fakeSupabaseClient(calls);
  let releaseSession!: (session: Session) => void;
  const delayedSession = new Promise<Session>((resolve) => { releaseSession = resolve; });
  const dependencies: SupabaseMemoryDependencies = {
    isConfigured: () => true,
    getClient: () => client,
    ensureSession: async () => delayedSession,
    getSession: async () => supabaseSession("late-owner"),
  };
  const store = new SupabaseMemoryStore(() => undefined, dependencies);
  store.queueSnapshot({
    memory: [{
      id: "late-placement", timestamp: Date.now(), subject: "bottle", action: "PUT_DOWN",
      location: "to the right of notebook", relation: "right of", anchor: "notebook",
      appearance: "matte red bottle", confidence: 0.9,
      evidence: { frameIds: ["late-frame"], observationIds: ["late-observation"] }, epistemic: "LAST_SEEN",
    }],
    recentObjects: [],
  });
  await Promise.resolve();
  store.stop();
  releaseSession(supabaseSession("late-owner"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.filter((call) => call === "rpc:upsert_episodic_memory_events").length, 0);
});

test("Supabase migration exposes reads only and serializes bounded RPC writes", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/202609120002_visual_memory_hardening.sql", import.meta.url),
    "utf8",
  );
  const cron = readFileSync(
    new URL("../../supabase/migrations/202609120003_visual_memory_retention_cron.sql", import.meta.url),
    "utf8",
  );
  const ownerBinding = readFileSync(
    new URL("../../supabase/migrations/202609120004_visual_memory_owner_binding.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /revoke all on table public\.recent_object_memories from anon, authenticated/i);
  assert.match(migration, /grant select on table public\.episodic_memory_events to authenticated/i);
  assert.equal(migration.match(/pg_advisory_xact_lock/g)?.length, 2);
  assert.match(migration, /offset 500/i);
  assert.match(migration, /offset 100/i);
  assert.match(migration, /expires_at > statement_timestamp\(\)/i);
  assert.match(cron, /cron\.schedule/i);
  assert.equal(ownerBinding.match(/auth\.uid\(\) is distinct from expected_owner/gi)?.length, 3);
  assert.match(ownerBinding, /revoke all on function public\.merge_recent_object_sightings\(jsonb\)/i);
});

test("structured vision normalization keeps precise appearance and direct PUT_DOWN events", () => {
  const capturedAt = Date.now();
  const placed = normalizeObservation({
    sceneSummary: "A bottle was placed to the right of a notebook.",
    cameraMotion: "low",
    objects: [
      { label: "bottle", color: "red", appearance: "matte red metal bottle with a black cap", confidence: 0.94 },
      { label: "notebook", confidence: 0.9 },
    ],
    placementEvents: [{
      type: "PUT_DOWN",
      subject: "bottle",
      relation: "right of",
      anchor: "notebook",
      location: "to the right of the notebook on the desk",
      appearance: "matte red metal bottle with a black cap",
      color: "red",
      confidence: 0.91,
    }],
    text: [],
    goalAssessment: { relevant: false, targetVisible: false, candidateConfidence: 0, shouldSpeak: false },
  }, { frameId: "placed", capturedAt, requestSentAt: capturedAt + 1, purpose: "background" }, "deep_vision", "vision-model");

  assert.equal(placed.objects[0]?.appearance, "matte red metal bottle with a black cap");
  assert.equal(placed.placementEvents?.[0]?.anchor, "notebook");
  assert.equal(placed.placementEvents?.[0]?.color, "red");
});

test("Agent stores only evidenced high-confidence placements", () => {
  const agent = new AgentOrchestrator(() => undefined);
  const capturedAt = Date.now();
  agent.observe(observation("before-place", capturedAt, [
    { ...bottle(0.42, 0.57), appearance: "matte red metal bottle with a black cap" },
    notebook(),
  ]));
  agent.observe({
    ...observation("placed-1", capturedAt + 1_000, [
      { ...bottle(0.6, 0.75), appearance: "matte red metal bottle with a black cap" },
      notebook(),
    ]),
    placementEvents: [{
      type: "PUT_DOWN",
      subject: "bottle",
      relation: "right of",
      anchor: "notebook",
      location: "to the right of the notebook on the desk",
      appearance: "matte red metal bottle with a black cap",
      confidence: 0.91,
    }],
  });
  const saved = agent.snapshot().memory.find((item) => item.action === "PUT_DOWN");
  assert.equal(saved?.action, "PUT_DOWN");
  assert.equal(saved?.anchor, "notebook");
  assert.equal(saved?.relation, "right of");
  assert.equal(saved?.location, "to the right of notebook");
  assert.equal(saved?.appearance, "matte red metal bottle with a black cap");
  assert.deepEqual(saved?.evidence.frameIds, ["before-place", "placed-1"]);

  agent.observe({
    ...observation("unanchored", capturedAt + 1_001, [bottle(0.6, 0.75)]),
    placementEvents: [{ type: "PUT_DOWN", subject: "bottle", relation: "right of", anchor: "notebook", location: "right of notebook", confidence: 0.99 }],
  });
  agent.observe({
    ...observation("uncertain", capturedAt + 1_002, [bottle(0.6, 0.75), notebook()]),
    placementEvents: [{ type: "PUT_DOWN", subject: "bottle", relation: "right of", anchor: "notebook", location: "right of notebook", confidence: 0.74 }],
  });
  assert.equal(agent.snapshot().memory.filter((item) => item.action === "PUT_DOWN").length, 1);

  const staticAgent = new AgentOrchestrator(() => undefined);
  staticAgent.observe(observation("static-before", capturedAt, [bottle(0.6, 0.75), notebook()]));
  staticAgent.observe({
    ...observation("static-after", capturedAt + 1_000, [bottle(0.6, 0.75), notebook()]),
    placementEvents: [{
      type: "PUT_DOWN", subject: "bottle", relation: "right of", anchor: "notebook",
      location: "right of notebook", confidence: 0.99,
    }],
  });
  assert.equal(staticAgent.snapshot().memory.some((item) => item.action === "PUT_DOWN"), false);
});

test("Realtime remember_event is anchored to the latest fresh observation", async () => {
  const agent = new AgentOrchestrator(() => undefined);
  agent.setVisionActive(true);
  agent.observe(observation("latest-frame", Date.now(), [{ ...bottle(0.6, 0.75), appearance: "matte red bottle" }, notebook()]));
  await agent.tools.dispatch("remember_event", {
    subject: "bottle",
    action: "PUT_DOWN",
    relation: "right of",
    anchor: "notebook",
    location: "to the right of the notebook on the desk",
    appearance: "matte red bottle",
    color: "red",
    confidence: 0.88,
  });
  const saved = agent.snapshot().memory[0];
  assert.deepEqual(saved?.evidence.frameIds, ["latest-frame"]);
  assert.equal(saved?.epistemic, "LAST_SEEN");

  const invalid = new AgentOrchestrator(() => undefined);
  invalid.setVisionActive(true);
  invalid.observe(observation("bottle-only", Date.now(), [bottle(0.6, 0.75)]));
  await assert.rejects(invalid.tools.dispatch("remember_event", {
    subject: "bottle", action: "PUT_DOWN", relation: "right of", anchor: "notebook",
    location: "right of notebook", appearance: "red bottle", confidence: 0.9,
  }), /matching current subject and anchor evidence/i);

  const wrongSide = new AgentOrchestrator(() => undefined);
  wrongSide.setVisionActive(true);
  wrongSide.observe(observation("wrong-side", Date.now(), [{ ...bottle(0.6, 0.75), appearance: "matte red bottle" }, notebook()]));
  await assert.rejects(wrongSide.tools.dispatch("remember_event", {
    subject: "bottle", action: "PUT_DOWN", relation: "left of", anchor: "notebook",
    location: "left of notebook", appearance: "matte red bottle", confidence: 0.9,
  }), /does not match current object geometry/i);
});

test("recall_memory stops describing an object as current when the camera stops", async () => {
  const now = Date.now();
  const saved: MemoryEvent = {
    id: "last-seen-keys",
    timestamp: now - 1_000,
    subject: "keys",
    action: "LAST_SEEN",
    location: "on the desk",
    confidence: 0.85,
    evidence: { frameIds: ["old"], observationIds: ["obs-old"] },
    epistemic: "LAST_SEEN",
  };
  const agent = new AgentOrchestrator(() => undefined, [saved]);
  agent.setVisionActive(true);
  agent.observe(observation("current-keys", now, [{ label: "keys", appearance: "brass keyring", confidence: 0.9, source: "deep_vision" }]));
  assert.match(String(await agent.tools.dispatch("recall_memory", { subject: "keys" })), /I can see/i);
  agent.setVisionActive(false);
  const afterStop = String(await agent.tools.dispatch("recall_memory", { subject: "keys" }));
  assert.doesNotMatch(afterStop, /I can see/i);
  assert.match(afterStop, /last saw/i);
});

test("where-did-I-put prefers placement memory, falls back to recent memory, and starts a conservative find", () => {
  const now = Date.now();
  const placed: MemoryEvent = {
    id: "placed", timestamp: now - 1_000, subject: "bottle", action: "PUT_DOWN", location: "to the right of the notebook on the desk",
    relation: "right of", anchor: "notebook", appearance: "matte red bottle", attributes: { color: "red" }, confidence: 0.9,
    evidence: { frameIds: ["old"], observationIds: ["obs-old"] }, epistemic: "LAST_SEEN",
  };
  const recent: RecentObjectMemoryRecord = {
    identityKey: "bottle|red|matte red bottle", label: "bottle", color: "red", appearance: "matte red bottle",
    spatialRelation: ["left of the keyboard"], confidence: 0.86, firstSeenAt: now - 500, lastSeenAt: now - 200, seenCount: 1,
    evidence: { frameIds: ["recent"], observationIds: ["obs-recent"] }, epistemic: "LAST_SEEN",
  };
  const spoken: string[] = [];
  const placementAgent = new AgentOrchestrator((text) => spoken.push(text), [placed], {}, [], [recent]);
  assert.equal(placementAgent.setGoal("Where did I put my bottle?").type, "review");
  assert.equal(placementAgent.snapshot().mode, "FIND");
  assert.match(spoken.at(-1) ?? "", /right of the notebook/i);
  assert.doesNotMatch(spoken.at(-1) ?? "", /left of the keyboard/i);

  const fallbackSpoken: string[] = [];
  const fallbackAgent = new AgentOrchestrator((text) => fallbackSpoken.push(text), [], {}, [], [recent]);
  fallbackAgent.setGoal("Where did I put my bottle?");
  assert.equal(fallbackAgent.snapshot().mode, "FIND");
  assert.match(fallbackSpoken.at(-1) ?? "", /left of the keyboard/i);
});

test("memory-assisted find reports uncertainty after sustained misses and uses two matches", () => {
  const now = Date.now();
  const placed: MemoryEvent = {
    id: "placed", timestamp: now - 1_000, subject: "bottle", action: "PUT_DOWN", location: "right of the notebook",
    appearance: "matte red bottle", confidence: 0.9, evidence: { frameIds: ["old"], observationIds: ["obs-old"] }, epistemic: "LAST_SEEN",
  };
  const spoken: string[] = [];
  const agent = new AgentOrchestrator((text) => spoken.push(text), [placed]);
  agent.setGoal("Where did I put my bottle?");
  for (let index = 0; index < 4; index += 1) {
    agent.observe({
      ...observation(`miss-${index}`, now + index * 2_000),
      goalAssessment: { relevant: true, targetVisible: false, candidateConfidence: 0, guidance: "NONE", shouldSpeak: false },
    });
  }
  assert.match(spoken.at(-1) ?? "", /may have been moved|outside the camera view/i);

  const possibleMatch = {
    relevant: true, targetVisible: true, candidateConfidence: 0.88, candidateObjectIndex: 0, spatialPosition: "right" as const,
    guidance: "HOLD" as const, shouldSpeak: true, speech: "Possible red bottle on the right.",
  };
  agent.observe({
    ...observation("wrong-appearance", now + 6_500, [{
      ...bottle(0.7, 0.82),
      appearance: "glossy clear plastic red bottle",
    }]),
    goalAssessment: possibleMatch,
  });
  assert.equal(agent.snapshot().confirmationCount, 0);
  const matchingBottle = { ...bottle(0.7, 0.82), appearance: "red matte bottle" };
  agent.observe({ ...observation("match-1", now + 7_000, [matchingBottle]), goalAssessment: possibleMatch });
  assert.equal(agent.snapshot().status, "VERIFYING");
  agent.observe({ ...observation("match-1", now + 7_050, [matchingBottle]), goalAssessment: possibleMatch });
  assert.equal(agent.snapshot().status, "VERIFYING");
  assert.equal(agent.snapshot().confirmationCount, 1);
  agent.observe({ ...observation("match-2", now + 7_100, [{ ...bottle(0.71, 0.83), appearance: "matte red bottle" }]), goalAssessment: possibleMatch });
  assert.equal(agent.snapshot().status, "TARGET_FOUND");
  assert.match(spoken.at(-1) ?? "", /may be your bottle/i);
});

test("hydration merges persisted and live memory instead of replacing either", () => {
  const now = Date.now();
  const agent = new AgentOrchestrator(() => undefined);
  agent.observe(observation("live", now, [{ ...bottle(0.6, 0.75), appearance: "red bottle" }]));
  const event: MemoryEvent = {
    id: "persisted-event", timestamp: now - 1_000, subject: "keys", action: "PUT_DOWN", location: "on the shelf", confidence: 0.8,
    evidence: { frameIds: ["persisted"], observationIds: ["obs-persisted"] }, epistemic: "LAST_SEEN",
  };
  const recent: RecentObjectMemoryRecord = {
    identityKey: "keys||brass keys", label: "keys", appearance: "brass keys", confidence: 0.8, firstSeenAt: now - 900,
    lastSeenAt: now - 800, seenCount: 1, evidence: { frameIds: ["persisted"], observationIds: ["obs-persisted"] }, epistemic: "LAST_SEEN",
  };
  agent.hydrateMemory([event], [recent]);
  assert.deepEqual(agent.snapshot().memory.map((item) => item.subject), ["keys", "red bottle"]);
  assert.deepEqual(agent.snapshot().recentObjects.map((item) => item.label).sort(), ["bottle", "keys"]);
});

test("EntityTracker keeps a nearby matching object identity and expires stale tracks", () => {
  const tracker = new EntityTracker();
  tracker.update(observation("1", 1, [bottle(0.1, 0.2)]));
  const id = tracker.active()[0].id;
  tracker.update(observation("2", 2, [bottle(0.15, 0.25)]));
  assert.equal(tracker.active()[0].id, id);
  tracker.update(observation("3", 3));
  tracker.update(observation("4", 4));
  tracker.update(observation("5", 5));
  assert.equal(tracker.active().length, 0);
});

test("TemporalReasoner treats a camera pan as not in view, never as removal", () => {
  const reasoner = new TemporalReasoner();
  const events = reasoner.analyze([observation("1", 1, [bottle(0.2, 0.35)]), observation("2", 2, [], "high")]);
  assert.equal(events[0]?.type, "NOT_IN_CURRENT_VIEW");
  assert.ok(!events.some((event) => event.type === "PICKED_UP" || event.type === "DISAPPEARED"));
});

test("TemporalReasoner requires three observations for approaching", () => {
  const reasoner = new TemporalReasoner();
  const two = [observation("1", 1, [bottle(0.4, 0.5)]), observation("2", 2, [bottle(0.38, 0.51)])];
  assert.ok(!reasoner.analyze(two).some((event) => event.type === "APPROACHING"));
  const three = [...two, observation("3", 3, [bottle(0.34, 0.54)])];
  assert.ok(reasoner.analyze(three).some((event) => event.type === "APPROACHING"));
});

test("SaliencePolicy announces only goal-relevant useful observations", () => {
  const policy = new SaliencePolicy();
  const goal: AgentGoal = { id: "g", type: "find", target: "bottle", attributes: { color: "red" }, createdAt: 0 };
  const relevant = { ...observation("1", 1), goalAssessment: { relevant: true, targetVisible: true, candidateConfidence: 0.8, shouldSpeak: true, speech: "Left" } };
  assert.equal(policy.decide(relevant, goal), "ANNOUNCE");
  assert.equal(policy.decide(observation("2", 2), goal), "IGNORE");
});

test("AdaptiveQualityController degrades repeated bad samples and recovers", () => {
  const quality = new AdaptiveQualityController();
  quality.record(4_000);
  assert.equal(quality.record(4_100), "BALANCED");
  for (let index = 0; index < 6; index += 1) quality.record(500);
  assert.equal(quality.quality, "HIGH");
});

test("ToolDispatcher executes registered tools and bounds its timeline", async () => {
  const dispatcher = new ToolDispatcher(2);
  dispatcher.register("double", (input) => Number(input) * 2);
  assert.equal(await dispatcher.dispatch("double", 4), 8);
  await dispatcher.dispatch("double", 5);
  await dispatcher.dispatch("double", 6);
  assert.equal(dispatcher.timeline().length, 2);
  await assert.rejects(dispatcher.dispatch("missing", null), /Unknown tool/);
});

test("Find mode requires two supporting observations before target found", () => {
  const spoken: string[] = [];
  const agent = new AgentOrchestrator((text) => spoken.push(text));
  agent.setGoal("Find my red bottle");
  const goalAssessment = { relevant: true, targetVisible: true, candidateConfidence: 0.9, spatialPosition: "center" as const, guidance: "HOLD" as const, shouldSpeak: true, speech: "I can see a red bottle near the center." };
  agent.observe({ ...observation("1", 1, [bottle(0.45, 0.55)]), goalAssessment });
  assert.equal(agent.snapshot().status, "VERIFYING");
  agent.observe({ ...observation("2", 2, [bottle(0.46, 0.56)]), goalAssessment: { ...goalAssessment, speech: "Found it. The red bottle is centered." } });
  assert.equal(agent.snapshot().status, "TARGET_FOUND");
  assert.match(spoken.at(-1) ?? "", /Found it/i);
});

test("LatestFrameProcessor drops intermediate stale work", async () => {
  const processed: number[] = [];
  const disposed: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const queue = new LatestFrameProcessor<number>(async (value) => {
    processed.push(value);
    if (value === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
  }, (value) => disposed.push(value));
  queue.push(1);
  queue.push(2);
  queue.push(3);
  assert.deepEqual(disposed, [2]);
  releaseFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, [1, 3]);
});

test("OCR fallback extracts text without exposing malformed coordinate syntax", () => {
  const parsed = parseJsonContent('{"sceneSummary":"sign","text":[{"text":"EXIT","bbox":{"x1":736, 328, 111, 151, 90>}}]}');
  assert.deepEqual(parsed.text, [{ text: "EXIT", confidence: 0.75 }]);
});

test("WebRTC failure enters FALLBACK and never reports WEBRTC_CONNECTED", async () => {
  class FailedRealtimeProvider extends QwenRealtimeProvider {
    protected override async connectWebRtc(): Promise<void> { throw new Error("ice_failed"); }
  }
  const provider = new FailedRealtimeProvider(async () => new Response("{}", { status: 200 }));
  const states: string[] = [];
  provider.onConnectionState((state) => states.push(state));
  await provider.connect();
  assert.equal(states.at(-1), "FALLBACK");
  assert.ok(!states.includes("WEBRTC_CONNECTED"));
  assert.match(provider.currentTelemetry.lastError ?? "", /ice_failed/);
  assert.equal(canReportWebRtcConnected("connected", "connected", "closed"), false);
  assert.equal(canReportWebRtcConnected("connected", "connected", "open", "unavailable"), false);
  assert.equal(canReportWebRtcConnected("connected", "connected", "open", "ended"), false);
  assert.equal(canReportWebRtcConnected("connected", "connected", "open", "live", "created"), false);
  assert.equal(canReportWebRtcConnected("connected", "connected", "open", "live", "ready"), true);
});

test("camera readiness follows the live video track and decoded frame, not stale UI state", async () => {
  const stream = {
    active: true,
    getVideoTracks: () => [{ enabled: true, readyState: "live" as const } as MediaStreamTrack],
  };
  const frame = { readyState: 1, videoWidth: 0, videoHeight: 0 };
  assert.equal(hasLiveVideoTrack(stream), true);
  assert.equal(isVideoFrameReady(frame), false);
  setTimeout(() => Object.assign(frame, { readyState: 2, videoWidth: 1280, videoHeight: 720 }), 10);
  await waitForVideoFrame(frame, 200);
  assert.equal(isVideoFrameReady(frame), true);
  const freshFrame = {
    ...frame,
    currentTime: 1,
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => {
      setTimeout(() => callback(0, {} as VideoFrameCallbackMetadata), 10);
      return 1;
    },
    cancelVideoFrameCallback: () => undefined,
  } as unknown as HTMLVideoElement;
  await waitForFreshVideoFrame(freshFrame, 200);
  const decodedButCallbackDelayed = {
    ...frame,
    currentTime: 1,
    requestVideoFrameCallback: () => 2,
    cancelVideoFrameCallback: () => undefined,
  } as unknown as HTMLVideoElement;
  await waitForCapturableFrame(decodedButCallbackDelayed, 5);
});

test("explicit specialist scan suppresses a competing realtime answer", () => {
  assert.equal(shouldEmitRealtimeAgentOutput(true), false);
  assert.equal(shouldEmitRealtimeAgentOutput(false), true);
});

test("sendText on a closed DataChannel uses fallback or returns an explicit error", async () => {
  const provider = new QwenRealtimeProvider(async () => new Response("failure", { status: 503 }));
  await assert.rejects(provider.sendText("hello"), /text_fallback_503/);
  assert.equal(provider.currentTelemetry.transport, "DEGRADED");
  assert.match(provider.currentTelemetry.lastError ?? "", /text_fallback_503/);
});

test("Whisper audio helpers retain only final transcript compatibility and produce 16 kHz PCM WAV", async () => {
  const event = {
    resultIndex: 1,
    results: {
      0: { 0: { transcript: "你好" } },
      1: { 0: { transcript: "我前面有什么" } },
      length: 2,
    },
  };
  assert.deepEqual(newFinalTranscripts(event), ["我前面有什么"]);
  const dedupe = new TranscriptDeduper(2_500);
  assert.equal(dedupe.accept("我前面有什么", 1_000), true);
  assert.equal(dedupe.accept(" 我前面有什么？ ", 2_000), false);
  assert.equal(hasAudibleSpeech(new Float32Array([0, 0.001, -0.001])), false);
  assert.equal(hasAudibleSpeech(new Float32Array([0.08, -0.06, 0.05])), true);
  const wav = pcmToWav(new Float32Array([0, 0.5, -0.5, 0]), 48_000);
  const bytes = new Uint8Array(await wav.arrayBuffer());
  assert.equal(wav.type, "audio/wav");
  assert.deepEqual([...bytes.slice(0, 4)], [0x52, 0x49, 0x46, 0x46]);
  assert.deepEqual([...bytes.slice(8, 12)], [0x57, 0x41, 0x56, 0x45]);
  assert.equal(new DataView(bytes.buffer).getUint32(24, true), 16_000);
});

test("realtime session leaves ASR to the same-origin Whisper route", () => {
  const source = readFileSync(new URL("../providers/QwenRealtimeProvider.ts", import.meta.url), "utf8");
  const audio = readFileSync(new URL("../media/AudioManager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /qwen3-asr|input_audio_transcription/);
  assert.match(audio, /fetch\("\/api\/transcribe"/);
  assert.doesNotMatch(audio, /WHISPER_BASE_URL|SpeechRecognition\?\?/);
});

test("proactive approaching remains debug-only and cannot抢占 a user turn", () => {
  const spoken: string[] = [];
  const agent = new AgentOrchestrator((text) => spoken.push(text));
  agent.beginUserTurn();
  agent.observe(observation("1", 1, [bottle(0.45, 0.55)]));
  agent.observe(observation("2", 2, [bottle(0.43, 0.57)]));
  agent.observe(observation("3", 3, [bottle(0.4, 0.6)]));
  assert.deepEqual(spoken, []);
  assert.ok(agent.snapshot().timeline.some((entry) => /APPROACHING pattern/.test(entry.label)));
});

test("stale observations never enter current memory or trigger a warning", () => {
  const spoken: string[] = [];
  const agent = new AgentOrchestrator((text) => spoken.push(text));
  agent.observe({
    ...observation("stale", 1, [bottle(0.2, 0.8)]),
    freshness: "STALE",
    staleReason: "captured_9000ms_before_response",
    events: [{ type: "APPROACHING", subject: "bottle", confidence: 0.99, evidenceFrameIds: ["a", "b", "stale"] }],
  });
  assert.equal(agent.snapshot().observation, undefined);
  assert.deepEqual(spoken, []);
  assert.match(agent.snapshot().timeline.at(-1)?.label ?? "", /Stale observation dropped/);
});

test("late background results update last-seen memory without becoming current evidence", () => {
  const agent = new AgentOrchestrator(() => undefined, [], {}, [], { now: () => 10_000 });
  const late = {
    ...observation("late", 2_000, [cup()]),
    freshness: "STALE" as const,
    staleReason: "captured_8000ms_before_response",
  };
  agent.recordHistoricalObservation(late);
  assert.equal(agent.snapshot().observation, undefined);
  assert.equal(agent.episodicMemory.recall("红色杯子").state, "LAST_SEEN");
  assert.match(agent.episodicMemory.formatRecall("红色杯子"), /上次看到/);

  const tooOld = { ...late, frameId: "too-old", id: "too-old", capturedAt: -6_000 };
  agent.recordHistoricalObservation(tooOld);
  assert.ok(!agent.episodicMemory.all().some((event) => event.evidence.frameIds.includes("too-old")));
});

test("greetings are conversation while bilingual visual commands receive the intended intent", () => {
  assert.deepEqual(parseUserIntent("你好"), { kind: "GENERAL_CONVERSATION" });
  assert.deepEqual(parseUserIntent("帮我找红色杯子"), { kind: "PERSISTENT_GOAL", goalType: "find" });
  assert.deepEqual(parseUserIntent("读一下这个标签"), { kind: "PERSISTENT_GOAL", goalType: "read" });
  assert.deepEqual(parseUserIntent("记住我的钥匙放哪"), { kind: "PERSISTENT_GOAL", goalType: "remember" });
  assert.deepEqual(parseUserIntent("我前面有什么"), { kind: "EPHEMERAL_VISUAL_QA", detailed: true });
  assert.deepEqual(parseUserIntent("你能看到什么"), { kind: "EPHEMERAL_VISUAL_QA", detailed: true });
  assert.deepEqual(parseUserIntent("帮我看一下前方"), { kind: "EPHEMERAL_VISUAL_QA", detailed: true });
  assert.deepEqual(parseUserIntent("我面前都有哪些东西"), { kind: "EPHEMERAL_VISUAL_QA", detailed: true });
  assert.deepEqual(parseUserIntent("what I can you see"), { kind: "EPHEMERAL_VISUAL_QA", detailed: true });
  assert.deepEqual(parseUserIntent("杯子在哪"), { kind: "PERSISTENT_GOAL", goalType: "review" });
  assert.deepEqual(parseUserIntent("where is my red cup"), { kind: "PERSISTENT_GOAL", goalType: "review" });
  assert.deepEqual(parseUserIntent("杯子不见了"), { kind: "PERSISTENT_GOAL", goalType: "review" });
  assert.equal(parseGoal("红色的杯子在哪").target, "杯子");
  assert.equal(parseGoal("红色的杯子在哪").attributes.color, "red");
});

test("realtime and structured vision prompts have separate response contracts", () => {
  assert.doesNotMatch(REALTIME_AGENT_SYSTEM_PROMPT, /Return only valid JSON/i);
  assert.match(REALTIME_AGENT_SYSTEM_PROMPT, /Never tell the user to start the camera/i);
  const detailed = visionPrompt("inspect the table", "", true);
  assert.match(detailed, /Return only valid JSON/i);
  assert.match(detailed, /medicine bottles, USB drives, greeting cards/i);
  const background = visionPrompt("explore", "", false);
  assert.match(background, /cups, mugs, bottles/i);
  assert.match(background, /Always record color/i);
  assert.equal(VISION_RESPONSE_FORMAT.type, "json_schema");
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.strict, true);
});

test("detailed vision uses Flash first, keeps Max for refinement, and skips futile auth retries", () => {
  const fast = selectVisionRoute("detailed", "fast");
  const max = selectVisionRoute("detailed", "max");
  const background = selectVisionRoute("background");
  assert.equal(fast.model, background.model);
  assert.notEqual(max.model, fast.model);
  assert.ok(max.timeoutMs > fast.timeoutMs);
  assert.equal(shouldTryMaxAfterFastFailure(new VisionClientError("timeout", "provider_timeout")), true);
  assert.equal(shouldTryMaxAfterFastFailure(new VisionClientError("auth", "provider_auth")), false);
  assert.equal(shouldTryMaxAfterFastFailure(new VisionClientError("rate", "provider_rate_limit")), false);
});

test("manual scan fallback is sequential and does not call Max after a successful Flash result", async () => {
  const successfulOrder: string[] = [];
  const fast = await runFastWithMaxFallback(
    async () => { successfulOrder.push("fast"); return "fast-result"; },
    async () => { successfulOrder.push("max"); return "max-result"; },
  );
  assert.deepEqual(successfulOrder, ["fast"]);
  assert.deepEqual(fast, { value: "fast-result", usedMaxFallback: false });

  const fallbackOrder: string[] = [];
  const fallback = await runFastWithMaxFallback(
    async () => { fallbackOrder.push("fast"); throw new VisionClientError("timeout", "provider_timeout"); },
    async () => { fallbackOrder.push("max"); return "max-result"; },
  );
  assert.deepEqual(fallbackOrder, ["fast", "max"]);
  assert.deepEqual(fallback, { value: "max-result", usedMaxFallback: true });
});

test("Safari audio policy selects browser speech whenever native RTP audio is unavailable", () => {
  assert.equal(shouldUseSpeechSynthesis(false, false), true);
  assert.equal(shouldUseSpeechSynthesis(true, false), true);
  assert.equal(shouldUseSpeechSynthesis(true, true), false);
});

test("object identity matches bilingual color and small-object names", () => {
  assert.equal(queryMatchesSubject("红色杯子", "red cup", "red"), true);
  assert.equal(queryMatchesSubject("蓝色杯子", "red cup", "red"), false);
  assert.equal(queryMatchesSubject("被子", "quilt"), true);
});

test("working observations become last-seen memory and stay distinct from current visibility", () => {
  let now = 1;
  const agent = new AgentOrchestrator(() => undefined, [], {}, [], { now: () => now });
  agent.observe(observation("1", 1, [cup(), { label: "person", confidence: 0.9, source: "deep_vision" }, { label: "hand", confidence: 0.8, source: "deep_vision" }]));
  assert.equal(agent.episodicMemory.recall("红色杯子").state, "LAST_SEEN");
  assert.equal(agent.episodicMemory.recall("红色杯子", agent.workingMemory.latest(), undefined, now).state, "CURRENTLY_VISIBLE");
  assert.match(agent.answerFromEvidence("杯子在哪") ?? "", /我(?:现在)?能看到|I can see/i);
  now = 2;
  agent.observe(observation("2", 2));
  assert.match(agent.answerFromEvidence("杯子在哪") ?? "", /上次看到|last saw/i);
  assert.match(agent.episodicMemory.formatRecall("keys"), /reliable location memory|可靠记忆/i);
  assert.doesNotMatch(agent.answerFromEvidence("杯子在哪") ?? "", /stolen|thief|偷走|被人拿走/i);
  assert.ok(!agent.episodicMemory.all().some((item) => /person|hand/i.test(item.subject)));
});

test("three still absences can infer relocation without claiming theft or a single-frame removal", () => {
  const reasoner = new TemporalReasoner();
  const history = [
    observation("1", 1, [cup()]),
    observation("2", 2),
    observation("3", 3),
    observation("4", 4),
  ];
  const events = reasoner.analyze(history);
  assert.ok(events.some((event) => event.type === "DISAPPEARED"));
  assert.ok(events.every((event) => event.type !== "PICKED_UP"));
  assert.match(events.find((event) => event.type === "DISAPPEARED")?.description ?? "", /may have been moved/i);
  const pan = reasoner.analyze([
    observation("a", 1, [cup()]),
    observation("b", 2, [], "high"),
    observation("c", 3, [], "high"),
    observation("d", 4, [], "high"),
  ]);
  assert.ok(!pan.some((event) => event.type === "DISAPPEARED" || event.type === "PICKED_UP"));
});

test("user turn timeout restores background find decisions", () => {
  const spoken: string[] = [];
  let now = 1_000;
  const agent = new AgentOrchestrator((text) => spoken.push(text), [], {}, [], { now: () => now, userTurnTimeoutMs: 100 });
  agent.setGoal("Find my red bottle");
  agent.beginUserTurn();
  const goalAssessment = { relevant: true, targetVisible: true, candidateConfidence: 0.9, guidance: "LEFT" as const, shouldSpeak: true, speech: "A little left." };
  agent.observe({ ...observation("1", 1, [bottle(0.2, 0.3)]), goalAssessment });
  assert.deepEqual(spoken, []);
  now = 1_200;
  agent.observe({ ...observation("2", 2, [bottle(0.2, 0.3)]), goalAssessment });
  assert.equal(spoken.at(-1), "A little left.");
});

test("evidence replies list colors and refuse theft language", () => {
  const scene = observation("1", 1, [cup(), { label: "person", confidence: 0.9, source: "deep_vision" }]);
  assert.match(composeSceneInventory(scene, "我前面有什么"), /红色|red cup/i);
  const absent = composeAbsenceReply("red cup", { id: "m", timestamp: 1, subject: "red cup", action: "NOT_IN_VIEW", location: "on the table", confidence: 0.6, evidence: { frameIds: [], observationIds: [] }, epistemic: "INFERRED" }, "杯子在哪");
  assert.match(absent, /可能被挪走|may have been moved/i);
  assert.doesNotMatch(absent, /stolen|thief|偷/i);
  assert.equal(scanAddsNewObjects(scene, { ...scene, objects: [...scene.objects, { label: "keys", confidence: 0.8, source: "deep_vision" }] }), true);
  assert.equal(hasUsefulObjectInventory(observation("hands", 1, [{ label: "person", confidence: 0.9, source: "deep_vision" }, { label: "hand", confidence: 0.9, source: "deep_vision" }])), false);
  assert.equal(hasUsefulObjectInventory(scene, "cup", "red"), true);
  assert.equal(hasUsefulObjectInventory(scene, "cup", "blue"), false);
});

test("unanswered realtime turns fall back after the ASR watchdog budget", () => {
  assert.equal(shouldFallbackUnansweredTurn(undefined, ASR_WATCHDOG_MS), true);
  assert.equal(shouldFallbackUnansweredTurn({ firstModelEventAt: 10 }, 2_000), false);
  assert.equal(shouldFallbackUnansweredTurn({ responseDoneAt: 10 }, 2_000), false);
  assert.equal(shouldFallbackUnansweredTurn({}, 400), false);
});

test("forced text fallback uses the HTTP path and returns an audible fallback transcript", async () => {
  let requested = "";
  const replies: string[] = [];
  const provider = new QwenRealtimeProvider(async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ text: "Fallback answer" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  provider.onTranscript((event) => replies.push(event.text));
  await provider.sendText("hello", { forceFallback: true });
  assert.equal(requested, "/api/realtime/text");
  assert.deepEqual(replies, ["Fallback answer"]);
});
