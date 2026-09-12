import test from "node:test";
import assert from "node:assert/strict";
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
import { WorkingMemory } from "../memory/WorkingMemory.ts";
import { DetailedSceneMemory } from "../memory/DetailedSceneMemory.ts";
import { LatestFrameProcessor } from "../media/LatestFrameProcessor.ts";
import { newFinalTranscripts, shouldUseSpeechSynthesis, TranscriptDeduper } from "../media/AudioManager.ts";
import { hasLiveVideoTrack, isVideoFrameReady, waitForCapturableFrame, waitForFreshVideoFrame, waitForVideoFrame } from "../media/CameraManager.ts";
import { AdaptiveQualityController } from "../performance/AdaptiveQualityController.ts";
import { EntityTracker } from "../temporal/EntityTracker.ts";
import { TemporalReasoner } from "../temporal/TemporalReasoner.ts";
import { parseJsonContent } from "../providers/server/QwenClient.ts";
import { VISION_RESPONSE_FORMAT } from "../providers/server/VisionSchema.ts";
import { selectVisionRoute } from "../providers/server/VisionRouting.ts";
import { runFastWithMaxFallback, shouldTryMaxAfterFastFailure, VisionClientError } from "../providers/DeepVisionProvider.ts";
import { canReportWebRtcConnected, QwenRealtimeProvider, shouldEmitRealtimeAgentOutput } from "../providers/QwenRealtimeProvider.ts";
import type { AgentGoal, DetectedObject, MemoryEvent, VisionObservation } from "../types/index.ts";

function observation(id: string, capturedAt: number, objects: DetectedObject[] = [], cameraMotion: VisionObservation["cameraMotion"] = "low"): VisionObservation {
  return {
    id: `obs-${id}`, frameId: id, capturedAt, requestSentAt: capturedAt + 1, receivedAt: capturedAt + 2,
    freshness: "FRESH", purpose: "background", sceneSummary: "test scene", objects, text: [], cameraMotion, source: "deep_vision",
  };
}

function bottle(x1: number, x2: number, confidence = 0.9): DetectedObject {
  return { label: "bottle", color: "red", bbox: { x1, y1: 0.2, x2, y2: 0.8 }, confidence, source: "deep_vision" };
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
  assert.equal(memory.recall("keys", observation("2", 200, [{ label: "keys", confidence: 0.91, source: "deep_vision" }])).state, "CURRENTLY_VISIBLE");
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

test("continuous SpeechRecognition processes only results at resultIndex and dedupes rapid repeats", () => {
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
  assert.equal(agent.episodicMemory.recall("红色杯子", agent.workingMemory.latest()).state, "CURRENTLY_VISIBLE");
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
