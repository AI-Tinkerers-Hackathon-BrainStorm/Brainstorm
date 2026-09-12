import type { AgentGoal, AgentMode, AgentStatus, CachedDetailedScene, MemoryEvent, TimelineEntry, VisionObservation } from "../types/index.ts";
import { DetailedSceneMemory } from "../memory/DetailedSceneMemory.ts";
import { EpisodicMemory } from "../memory/EpisodicMemory.ts";
import { WorkingMemory } from "../memory/WorkingMemory.ts";
import { EntityTracker } from "../temporal/EntityTracker.ts";
import { TemporalReasoner } from "../temporal/TemporalReasoner.ts";
import { AgentStateMachine } from "./AgentStateMachine.ts";
import { parseGoal } from "./GoalParser.ts";
import { SaliencePolicy } from "./SaliencePolicy.ts";
import { ToolDispatcher } from "./ToolDispatcher.ts";

export interface AgentSnapshot {
  mode: AgentMode;
  status: AgentStatus;
  goal?: AgentGoal;
  observation?: VisionObservation;
  timeline: readonly TimelineEntry[];
  memory: readonly MemoryEvent[];
  detailedScenes: readonly CachedDetailedScene[];
  confirmationCount: number;
}

export interface AgentCapabilities {
  requestDeepVision?: (input: unknown) => unknown | Promise<unknown>;
  requestOcr?: (input: unknown) => unknown | Promise<unknown>;
  vibrate?: (input: unknown) => unknown | Promise<unknown>;
}

export class AgentOrchestrator {
  readonly state = new AgentStateMachine();
  readonly workingMemory = new WorkingMemory();
  readonly episodicMemory: EpisodicMemory;
  readonly detailedSceneMemory: DetailedSceneMemory;
  readonly tracker = new EntityTracker();
  readonly temporal = new TemporalReasoner();
  readonly salience = new SaliencePolicy();
  readonly tools = new ToolDispatcher();
  private goal?: AgentGoal;
  private confirmations = 0;
  private lastGuidance = "";
  private userTurnActive = false;

  constructor(
    private readonly onAnnounce: (text: string, haptic?: "LEFT" | "RIGHT" | "FOUND" | "WARNING") => void,
    savedMemory: MemoryEvent[] = [],
    capabilities: AgentCapabilities = {},
    savedDetailedScenes: CachedDetailedScene[] = [],
  ) {
    this.episodicMemory = new EpisodicMemory(savedMemory);
    this.detailedSceneMemory = new DetailedSceneMemory(savedDetailedScenes);
    this.tools.register("set_goal", (input) => this.setGoal(typeof input === "object" && input && "command" in input ? String((input as { command: unknown }).command) : String(input)));
    this.tools.register("clear_goal", () => this.clearGoal());
    this.tools.register("recall_memory", (input) => this.episodicMemory.formatRecall(typeof input === "object" && input && "subject" in input ? String((input as { subject: unknown }).subject) : String(input), this.workingMemory.latest()));
    this.tools.register("remember_event", (input) => {
      const value = input as Partial<MemoryEvent>;
      if (!value.subject || !value.action) throw new Error("A memory subject and action are required");
      this.episodicMemory.remember({
        id: value.id ?? `memory-${Date.now()}`,
        timestamp: value.timestamp ?? Date.now(),
        subject: value.subject,
        action: value.action,
        location: value.location,
        attributes: value.attributes,
        confidence: Math.max(0, Math.min(1, value.confidence ?? 0.5)),
        evidence: value.evidence ?? { frameIds: [], observationIds: [] },
        lastConfirmedAt: value.lastConfirmedAt,
        epistemic: value.epistemic ?? "INFERRED",
      });
    });
    this.tools.register("announce", (input) => this.onAnnounce(typeof input === "object" && input && "text" in input ? String((input as { text: unknown }).text) : String(input)));
    this.tools.register("request_deep_vision", (input) => {
      if (!capabilities.requestDeepVision) throw new Error("Deep vision is unavailable");
      return capabilities.requestDeepVision(input);
    });
    this.tools.register("request_ocr", (input) => {
      if (!capabilities.requestOcr) throw new Error("OCR is unavailable");
      return capabilities.requestOcr(input);
    });
    this.tools.register("vibrate", (input) => {
      if (!capabilities.vibrate) throw new Error("Haptics are unavailable");
      return capabilities.vibrate(input);
    });
  }

  setGoal(command: string): AgentGoal {
    this.goal = parseGoal(command);
    const modeMap: Record<AgentGoal["type"], AgentMode> = { find: "FIND", read: "READ", remember: "REMEMBER", review: "REVIEW", explore: "EXPLORE" };
    this.state.setMode(modeMap[this.goal.type]);
    this.confirmations = 0;
    this.lastGuidance = "";
    this.tools.log("goal", "Goal created", `${this.goal.type}: ${this.goal.target}`);
    if (this.goal.type === "review") {
      const reply = this.episodicMemory.formatRecall(this.goal.target, this.workingMemory.latest());
      this.onAnnounce(reply);
      this.state.transition("LISTENING");
    }
    return this.goal;
  }

  clearGoal(): void {
    this.goal = undefined;
    this.confirmations = 0;
    this.state.reset();
    this.tools.log("goal", "Goal cleared");
  }

  beginUserTurn(): void {
    this.userTurnActive = true;
    this.tools.log("action", "User turn started");
  }

  completeUserTurn(): void {
    this.userTurnActive = false;
    this.tools.log("action", "User turn completed");
  }

  cacheDetailedObservation(observation: VisionObservation): CachedDetailedScene {
    const cached = this.detailedSceneMemory.add(observation);
    this.tools.log("memory", "Max detailed scene cached", `${cached.model} · captured ${cached.capturedAt}`);
    return cached;
  }

  observe(observation: VisionObservation): AgentSnapshot {
    if (observation.freshness === "STALE") {
      this.tools.log("observation", "Stale observation dropped", observation.staleReason ?? observation.frameId);
      return this.snapshot();
    }
    this.tracker.update(observation);
    this.workingMemory.add(observation);
    observation.events = [...(observation.events ?? []), ...this.temporal.analyze(this.workingMemory.all())];
    this.tools.log("observation", "Scene observed", observation.sceneSummary);
    for (const event of observation.events.filter((item) => item.type === "APPROACHING")) {
      this.tools.log("observation", "APPROACHING pattern (debug only)", event.description);
    }

    if (this.userTurnActive && observation.purpose === "background") return this.snapshot();

    if (this.goal?.type === "find") this.handleFind(observation);
    else if (this.goal?.type === "remember") this.handleRemember(observation);
    else if (this.goal?.type === "read") this.handleRead(observation);
    return this.snapshot();
  }

  snapshot(): AgentSnapshot {
    return {
      mode: this.state.mode,
      status: this.state.status,
      goal: this.goal,
      observation: this.workingMemory.latest(),
      timeline: this.tools.timeline(),
      memory: this.episodicMemory.all(),
      detailedScenes: this.detailedSceneMemory.all(),
      confirmationCount: this.confirmations,
    };
  }

  private handleFind(observation: VisionObservation) {
    if (this.state.status === "TARGET_FOUND") return;
    const assessment = observation.goalAssessment;
    if (assessment?.targetVisible && assessment.candidateConfidence >= 0.65) this.confirmations += 1;
    else this.confirmations = 0;
    const needed = this.goal?.fastMode ? 1 : 2;
    if (this.confirmations >= needed) {
      this.state.transition("TARGET_FOUND");
      const location = assessment?.spatialPosition?.replace("-", " ") ?? "in the current view";
      const text = assessment?.speech || `Found it. I can see ${this.goal?.target} ${location}.`;
      this.onAnnounce(text, "FOUND");
      this.tools.log("decision", "Target confirmed", `${this.confirmations} consecutive observations`);
      return;
    }
    if (this.confirmations === 1) this.state.transition("VERIFYING");
    else if (assessment?.guidance && assessment.guidance !== "NONE" && assessment.shouldSpeak) this.state.transition("GUIDING");
    else this.state.transition("SEARCHING");

    const speech = assessment?.speech?.trim();
    if (speech && speech !== this.lastGuidance && this.salience.decide(observation, this.goal, observation.events) === "ANNOUNCE") {
      const haptic = assessment?.guidance === "LEFT" ? "LEFT" : assessment?.guidance === "RIGHT" ? "RIGHT" : undefined;
      this.onAnnounce(speech, haptic);
      this.lastGuidance = speech;
      this.tools.log("decision", "Guidance issued", speech);
    }
  }

  private handleRemember(observation: VisionObservation) {
    const target = this.goal?.target ?? "object";
    const object = observation.objects.find((item) => item.label.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(item.label.toLowerCase()));
    if (!object || object.confidence < 0.65) return;
    const location = object.spatialRelation?.join(" ") || "in the current view";
    this.episodicMemory.remember({
      id: `memory-${Date.now()}`,
      timestamp: observation.capturedAt,
      subject: target,
      action: "LAST_SEEN",
      location,
      attributes: { color: object.color },
      confidence: object.confidence,
      evidence: { frameIds: [observation.frameId], observationIds: [observation.id] },
      lastConfirmedAt: observation.capturedAt,
      epistemic: "LAST_SEEN",
    });
    this.tools.log("memory", "Memory saved", `${target} ${location}`);
    this.onAnnounce(`I’ll remember that I last saw ${target} ${location}.`);
    this.state.setMode("IDLE");
    this.goal = undefined;
  }

  private handleRead(observation: VisionObservation) {
    if (!observation.text.length) {
      this.onAnnounce("I can’t read clear text from this view. Try moving closer and scan again.");
      return;
    }
    const speech = observation.text.map((item) => item.text).join(". ");
    this.onAnnounce(speech);
    this.tools.log("action", "Text read", `${observation.text.length} text region(s)`);
    this.state.setMode("IDLE");
    this.goal = undefined;
  }
}
