import type {
  AgentGoal,
  AgentMode,
  AgentStatus,
  CachedDetailedScene,
  DetectedObject,
  MemoryEvent,
  RecentObjectMemoryRecord,
  TimelineEntry,
  VisionObservation,
} from "../types/index.ts";
import { DetailedSceneMemory } from "../memory/DetailedSceneMemory.ts";
import { EpisodicMemory } from "../memory/EpisodicMemory.ts";
import { APPEARANCE_MATCH_THRESHOLD, appearanceSimilarity, RecentObjectMemory } from "../memory/RecentObjectMemory.ts";
import { WorkingMemory } from "../memory/WorkingMemory.ts";
import { EntityTracker } from "../temporal/EntityTracker.ts";
import { TemporalReasoner } from "../temporal/TemporalReasoner.ts";
import { composeSceneInventory } from "./EvidenceReply.ts";
import { AgentStateMachine } from "./AgentStateMachine.ts";
import { parseGoal, parseUserIntent } from "./GoalParser.ts";
import { extractColor, prefersChinese, queryMatchesSubject } from "./ObjectIdentity.ts";
import { SaliencePolicy } from "./SaliencePolicy.ts";
import { ToolDispatcher } from "./ToolDispatcher.ts";
import { USER_TURN_TIMEOUT_MS } from "./TurnWatchdog.ts";

const CURRENT_EVIDENCE_MAX_AGE_MS = 5_000;
const MIN_RELATIVE_PLACEMENT_MOVEMENT = 0.035;

function matchesObject(subject: string, object: DetectedObject): boolean {
  const query = subject.trim().toLowerCase();
  if (!query) return false;
  return [object.label, ...(object.aliases ?? [])]
    .map((name) => name.trim().toLowerCase())
    .some((name) => name && (name === query || name.includes(query) || query.includes(name)));
}

function textField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function objectCenter(object: DetectedObject): { x: number; y: number } | undefined {
  if (object.center) return object.center;
  if (!object.bbox) return undefined;
  return { x: (object.bbox.x1 + object.bbox.x2) / 2, y: (object.bbox.y1 + object.bbox.y2) / 2 };
}

function relationMatchesGeometry(relation: string, subject: DetectedObject, anchor: DetectedObject): boolean {
  const subjectCenter = objectCenter(subject);
  const anchorCenter = objectCenter(anchor);
  if (!subjectCenter || !anchorCenter || subject === anchor) return false;
  const normalizedRelation = relation.trim().toLowerCase();
  const dx = subjectCenter.x - anchorCenter.x;
  const dy = subjectCenter.y - anchorCenter.y;
  if (/\bright\b/.test(normalizedRelation)) return dx >= 0.02;
  if (/\bleft\b/.test(normalizedRelation)) return dx <= -0.02;
  if (/\b(above|over)\b/.test(normalizedRelation)) return dy <= -0.02;
  if (/\b(below|under)\b/.test(normalizedRelation)) return dy >= 0.02;
  if (/\b(beside|next to|near)\b/.test(normalizedRelation)) return Math.abs(dx) >= 0.02 && Math.abs(dy) <= 0.35;
  return false;
}

function canonicalPlacementLocation(relation: string, anchor: string): string {
  const normalizedRelation = relation.trim().toLowerCase();
  if (/\bright\b/.test(normalizedRelation)) return `to the right of ${anchor}`;
  if (/\bleft\b/.test(normalizedRelation)) return `to the left of ${anchor}`;
  if (/\b(above|over)\b/.test(normalizedRelation)) return `above ${anchor}`;
  if (/\b(below|under)\b/.test(normalizedRelation)) return `below ${anchor}`;
  return `beside ${anchor}`;
}

export interface AgentSnapshot {
  mode: AgentMode;
  status: AgentStatus;
  goal?: AgentGoal;
  observation?: VisionObservation;
  timeline: readonly TimelineEntry[];
  memory: readonly MemoryEvent[];
  recentObjects: readonly RecentObjectMemoryRecord[];
  detailedScenes: readonly CachedDetailedScene[];
  confirmationCount: number;
}

export interface AgentCapabilities {
  requestDeepVision?: (input: unknown) => unknown | Promise<unknown>;
  requestOcr?: (input: unknown) => unknown | Promise<unknown>;
  vibrate?: (input: unknown) => unknown | Promise<unknown>;
}

export interface AgentOrchestratorOptions {
  now?: () => number;
  userTurnTimeoutMs?: number;
}

export class AgentOrchestrator {
  readonly state = new AgentStateMachine();
  readonly workingMemory = new WorkingMemory();
  readonly episodicMemory: EpisodicMemory;
  readonly detailedSceneMemory: DetailedSceneMemory;
  readonly recentObjectMemory: RecentObjectMemory;
  readonly tracker = new EntityTracker();
  readonly temporal = new TemporalReasoner();
  readonly salience = new SaliencePolicy();
  readonly tools = new ToolDispatcher();
  private goal?: AgentGoal;
  private confirmations = 0;
  private lastGuidance = "";
  private userTurnActive = false;
  private memorySearchMisses = 0;
  private memorySearchStartedAt?: number;
  private memoryMoveNoticeAnnounced = false;
  private lastConfirmationFrameId?: string;
  private currentVisionActive = false;
  private userTurnStartedAt = 0;
  private readonly now: () => number;
  private readonly userTurnTimeoutMs: number;

  constructor(
    private readonly onAnnounce: (text: string, haptic?: "LEFT" | "RIGHT" | "FOUND" | "WARNING") => void,
    savedMemory: MemoryEvent[] = [],
    capabilities: AgentCapabilities = {},
    savedDetailedScenes: CachedDetailedScene[] = [],
    savedRecentObjectsOrOptions: RecentObjectMemoryRecord[] | AgentOrchestratorOptions = [],
    options: AgentOrchestratorOptions = {},
  ) {
    const savedRecentObjects = Array.isArray(savedRecentObjectsOrOptions) ? savedRecentObjectsOrOptions : [];
    const resolvedOptions = Array.isArray(savedRecentObjectsOrOptions) ? options : savedRecentObjectsOrOptions;
    this.now = resolvedOptions.now ?? Date.now;
    this.userTurnTimeoutMs = resolvedOptions.userTurnTimeoutMs ?? USER_TURN_TIMEOUT_MS;
    this.episodicMemory = new EpisodicMemory(savedMemory);
    this.detailedSceneMemory = new DetailedSceneMemory(savedDetailedScenes);
    this.recentObjectMemory = new RecentObjectMemory(savedRecentObjects);
    this.tools.register("set_goal", (input) => this.setGoal(typeof input === "object" && input && "command" in input ? String((input as { command: unknown }).command) : String(input)));
    this.tools.register("clear_goal", () => this.clearGoal());
    this.tools.register("recall_memory", (input) => this.formatMemoryRecall(typeof input === "object" && input && "subject" in input ? String((input as { subject: unknown }).subject) : String(input)));
    this.tools.register("remember_event", (input) => this.rememberRealtimePlacement(input));
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

  hydrateMemory(events: readonly MemoryEvent[], recentObjects: readonly RecentObjectMemoryRecord[]): void {
    this.episodicMemory.merge(events);
    this.recentObjectMemory.merge(recentObjects);
    if (events.length || recentObjects.length) {
      this.tools.log("memory", "Persisted memory hydrated", `${events.length} event(s), ${recentObjects.length} recent object(s)`);
    }
  }

  setGoal(command: string): AgentGoal {
    const requestedGoal = parseGoal(command, this.now());
    this.goal = requestedGoal;
    const modeMap: Record<AgentGoal["type"], AgentMode> = { find: "FIND", read: "READ", remember: "REMEMBER", review: "REVIEW", explore: "EXPLORE" };
    this.state.setMode(modeMap[this.goal.type]);
    this.confirmations = 0;
    this.lastGuidance = "";
    this.memorySearchMisses = 0;
    this.memorySearchStartedAt = undefined;
    this.memoryMoveNoticeAnnounced = false;
    this.lastConfirmationFrameId = undefined;
    this.tools.log("goal", "Goal created", `${this.goal.type}: ${this.goal.target}`);
    if (this.goal.type === "review") this.startMemoryAssistedFind(requestedGoal);
    return requestedGoal;
  }

  clearGoal(): void {
    this.goal = undefined;
    this.confirmations = 0;
    this.memorySearchMisses = 0;
    this.memorySearchStartedAt = undefined;
    this.memoryMoveNoticeAnnounced = false;
    this.lastConfirmationFrameId = undefined;
    this.state.reset();
    this.tools.log("goal", "Goal cleared");
  }

  setVisionActive(active: boolean): void {
    this.currentVisionActive = active;
    if (!active) this.workingMemory.clear();
  }

  beginUserTurn(): void {
    this.userTurnActive = true;
    this.userTurnStartedAt = this.now();
    this.tools.log("action", "User turn started");
  }

  completeUserTurn(): void {
    this.userTurnActive = false;
    this.tools.log("action", "User turn completed");
  }

  private isUserTurnBlocking(): boolean {
    if (!this.userTurnActive) return false;
    if (this.now() - this.userTurnStartedAt > this.userTurnTimeoutMs) {
      this.completeUserTurn();
      return false;
    }
    return true;
  }

  cacheDetailedObservation(observation: VisionObservation): CachedDetailedScene {
    const cached = this.detailedSceneMemory.add(observation);
    this.episodicMemory.recordDetailedScene(cached);
    this.tools.log("memory", "Max detailed scene cached", `${cached.model} · captured ${cached.capturedAt}`);
    return cached;
  }

  recordHistoricalObservation(observation: VisionObservation): AgentSnapshot {
    const ageMs = this.now() - observation.capturedAt;
    if (observation.purpose !== "background" || observation.freshness !== "STALE" || ageMs > 15_000) {
      this.tools.log("observation", "Historical observation ignored", observation.staleReason ?? observation.frameId);
      return this.snapshot();
    }
    const ingested = this.episodicMemory.ingestObservation(observation);
    this.tools.log(
      "memory",
      "Late observation stored as last-seen only",
      ingested.length ? ingested.map((item) => item.subject).slice(0, 6).join(", ") : observation.frameId,
    );
    return this.snapshot();
  }

  answerFromEvidence(query: string): string | undefined {
    const current = this.currentObservation();
    const intent = parseUserIntent(query);
    if (intent.kind === "EPHEMERAL_VISUAL_QA" && current?.freshness === "FRESH") {
      return composeSceneInventory(current, query);
    }
    if (intent.kind === "PERSISTENT_GOAL" && (intent.goalType === "review" || intent.goalType === "find")) {
      const goal = parseGoal(query, this.now());
      const recalled = this.episodicMemory.recall(goal.target, current, goal.attributes.color, this.now());
      if (recalled.state === "UNKNOWN") return undefined;
      const memoryLine = this.episodicMemory.formatRecall(goal.target, current, goal.attributes.color, this.now());
      if (intent.goalType === "find" && recalled.state !== "CURRENTLY_VISIBLE") {
        return prefersChinese(query) ? `我继续找${goal.target}。${memoryLine}` : `I’ll look for ${goal.target}. ${memoryLine}`;
      }
      return memoryLine;
    }
    const subject = parseGoal(query, this.now()).target;
    if (!subject || subject === "the current scene") return undefined;
    const color = extractColor(query);
    const recalled = this.episodicMemory.recall(subject, current, color, this.now());
    if (recalled.state === "UNKNOWN") return undefined;
    return this.episodicMemory.formatRecall(subject, current, color, this.now());
  }

  private currentObservation(): VisionObservation | undefined {
    const observation = this.workingMemory.latest();
    return observation && this.now() - observation.capturedAt <= 8_000 ? observation : undefined;
  }

  observe(observation: VisionObservation): AgentSnapshot {
    if (observation.freshness === "STALE") {
      this.tools.log("observation", "Stale observation dropped", observation.staleReason ?? observation.frameId);
      return this.snapshot();
    }
    this.tracker.update(observation);
    this.workingMemory.add(observation);
    this.recentObjectMemory.observe(observation);
    observation.events = [...(observation.events ?? []), ...this.temporal.analyze(this.workingMemory.all())];
    const rememberedPlacements = this.rememberObservedPlacements(observation);
    const ingested = this.episodicMemory.ingestObservation(observation);
    const absences = this.episodicMemory.ingestAbsence(observation, observation.events);
    this.tools.log("observation", "Scene observed", observation.sceneSummary);
    if (ingested.length) this.tools.log("memory", "Last-seen objects updated", ingested.map((item) => item.subject).slice(0, 6).join(", "));
    if (absences.length) this.tools.log("memory", "Absence inferred", absences.map((item) => item.subject).join(", "));
    for (const event of observation.events.filter((item) => item.type === "APPROACHING")) {
      this.tools.log("observation", "APPROACHING pattern (debug only)", event.description);
    }

    if (this.isUserTurnBlocking() && observation.purpose === "background") return this.snapshot();

    if (this.goal?.type === "find") this.handleFind(observation);
    else if (this.goal?.type === "remember") this.handleRemember(observation, rememberedPlacements);
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
      recentObjects: this.recentObjectMemory.all(),
      detailedScenes: this.detailedSceneMemory.all(),
      confirmationCount: this.confirmations,
    };
  }

  private startMemoryAssistedFind(requestedGoal: AgentGoal): void {
    const placement = this.episodicMemory.recallPlacement(requestedGoal.target);
    if (placement) {
      this.goal = this.memoryFindGoal(requestedGoal, {
        color: typeof placement.attributes?.color === "string" ? placement.attributes.color : undefined,
        appearance: placement.appearance,
        lastSeenLocation: placement.location,
        lastSeenRelation: placement.relation,
        lastSeenAnchor: placement.anchor,
        lastSeenAt: String(placement.timestamp),
        memorySource: "placement",
      });
      this.state.setMode("FIND");
      this.onAnnounce(`${this.episodicMemory.formatEventRecall(requestedGoal.target, placement)} I’ll look for it.`);
      return;
    }

    const recent = this.recentObjectMemory.recall(requestedGoal.target);
    if (recent) {
      const location = recent.spatialRelation?.join(" and ") || "in a recent view";
      this.goal = this.memoryFindGoal(requestedGoal, {
        color: recent.color,
        appearance: recent.appearance,
        lastSeenLocation: location,
        lastSeenAt: String(recent.lastSeenAt),
        memorySource: "recent-object",
      });
      this.state.setMode("FIND");
      this.onAnnounce(`I last saw what appeared to be ${requestedGoal.target} ${location} within the past five minutes. I can’t confirm it’s still there. I’ll look for it.`);
      return;
    }

    const recalled = this.episodicMemory.recall(requestedGoal.target);
    if (recalled.event) {
      this.goal = this.memoryFindGoal(requestedGoal, {
        color: typeof recalled.event.attributes?.color === "string" ? recalled.event.attributes.color : undefined,
        appearance: recalled.event.appearance,
        lastSeenLocation: recalled.event.location,
        lastSeenAt: String(recalled.event.timestamp),
        memorySource: "event",
      });
      this.state.setMode("FIND");
      this.onAnnounce(`${this.episodicMemory.formatEventRecall(requestedGoal.target, recalled.event)} I’ll look for it.`);
      return;
    }

    this.onAnnounce(`I can’t confirm where ${requestedGoal.target} is now.`);
    this.state.transition("LISTENING");
  }

  private memoryFindGoal(requestedGoal: AgentGoal, attributes: Record<string, string | undefined>): AgentGoal {
    const definedAttributes = Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, string] => Boolean(entry[1])));
    return { ...requestedGoal, type: "find", attributes: { ...requestedGoal.attributes, ...definedAttributes, memorySearch: "true" } };
  }

  private formatMemoryRecall(subject: string): string {
    const latest = this.currentVisionActive ? this.workingMemory.latest() : undefined;
    const current = this.episodicMemory.recall(subject, latest, undefined, this.now());
    if (current.state === "CURRENTLY_VISIBLE") return this.episodicMemory.formatRecall(subject, latest, undefined, this.now());
    const placement = this.episodicMemory.recallPlacement(subject);
    if (placement) return this.episodicMemory.formatEventRecall(subject, placement);
    const recent = this.recentObjectMemory.recall(subject);
    if (recent) {
      const location = recent.spatialRelation?.join(" and ") || "in a recent view";
      return `I last saw what appeared to be ${subject} ${location} within the past five minutes. I can’t confirm it’s still there.`;
    }
    return this.episodicMemory.formatRecall(subject);
  }

  private rememberRealtimePlacement(input: unknown): void {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const subject = textField(value, "subject");
    const action = textField(value, "action");
    const relation = textField(value, "relation");
    const anchor = textField(value, "anchor");
    const requestedLocation = textField(value, "location");
    const appearance = textField(value, "appearance");
    const confidence = Math.max(0, Math.min(1, Number(value.confidence) || 0));
    if (!subject || action !== "PUT_DOWN") throw new Error("remember_event accepts only a PUT_DOWN subject");
    if (!requestedLocation || !relation || !anchor || !appearance) throw new Error("A placement requires location, relation, anchor, and appearance");
    if (confidence < 0.75) throw new Error("A placement requires confidence of at least 0.75");

    const latest = this.workingMemory.latest();
    const latestIsCurrent = this.currentVisionActive
      && latest?.freshness === "FRESH"
      && Date.now() - latest.capturedAt <= CURRENT_EVIDENCE_MAX_AGE_MS;
    const observedObject = latestIsCurrent ? latest.objects.find((object) => matchesObject(subject, object)) : undefined;
    const observedAnchor = latestIsCurrent ? latest.objects.find((object) => matchesObject(anchor, object)) : undefined;
    if (!latest || !observedObject || observedObject.confidence < 0.65 || !observedAnchor || observedAnchor.confidence < 0.65) {
      throw new Error("A placement requires matching current subject and anchor evidence");
    }
    if (!relationMatchesGeometry(relation, observedObject, observedAnchor)) {
      throw new Error("The placement relation does not match current object geometry");
    }
    if (observedObject.appearance && appearanceSimilarity(appearance, observedObject.appearance) < APPEARANCE_MATCH_THRESHOLD) {
      throw new Error("The remembered appearance does not match the current subject");
    }

    const color = textField(value, "color") ?? observedObject.color;
    const location = canonicalPlacementLocation(relation, anchor);
    this.episodicMemory.remember({
      id: textField(value, "id") ?? `memory-${latest.frameId}-${subject.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
      timestamp: latest.capturedAt,
      subject,
      action,
      location,
      relation,
      anchor,
      appearance: observedObject.appearance ?? appearance,
      attributes: color ? { color } : undefined,
      confidence: Math.min(confidence, observedObject.confidence),
      evidence: { frameIds: [latest.frameId], observationIds: [latest.id] },
      lastConfirmedAt: latest.capturedAt,
      epistemic: "LAST_SEEN",
    });
    this.tools.log("memory", "Placement remembered", `${subject} ${location}`);
  }

  private handleFind(observation: VisionObservation): void {
    if (this.state.status === "TARGET_FOUND") return;
    const assessment = observation.goalAssessment;
    const memorySearch = this.goal?.attributes.memorySearch === "true";
    const memoryCandidate = memorySearch ? this.findMemoryCandidate(observation) : undefined;
    const confirmedCandidate = Boolean(
      assessment?.targetVisible
      && assessment.candidateConfidence >= 0.65
      && (!memorySearch || memoryCandidate),
    );
    if (confirmedCandidate) {
      if (this.lastConfirmationFrameId !== observation.frameId) {
        this.confirmations += 1;
        this.lastConfirmationFrameId = observation.frameId;
      }
      this.memorySearchMisses = 0;
      this.memorySearchStartedAt = undefined;
    } else {
      this.confirmations = 0;
      this.lastConfirmationFrameId = undefined;
      if (memorySearch) {
        if (this.memorySearchMisses === 0) this.memorySearchStartedAt = observation.capturedAt;
        this.memorySearchMisses += 1;
        const searchedForMs = observation.capturedAt - (this.memorySearchStartedAt ?? observation.capturedAt);
        if (this.memorySearchMisses >= 4 && searchedForMs >= 5_000 && !this.memoryMoveNoticeAnnounced) {
          this.onAnnounce("I haven’t found it in the views I’ve checked. It may have been moved, or it may still be outside the camera view.");
          this.tools.log("decision", "Remembered item not found", `${this.memorySearchMisses} checked observations over ${searchedForMs} ms; movement remains uncertain`);
          this.memoryMoveNoticeAnnounced = true;
        }
      }
    }
    const needed = memorySearch ? 2 : this.goal?.fastMode ? 1 : 2;
    if (this.confirmations >= needed) {
      this.state.transition("TARGET_FOUND");
      const location = assessment?.spatialPosition?.replace("-", " ") ?? "in the current view";
      const appearance = this.goal?.attributes.appearance || [this.goal?.attributes.color, this.goal?.target].filter(Boolean).join(" ");
      const text = memorySearch
        ? `This may be your ${this.goal?.target}. I can see a matching ${appearance || this.goal?.target} ${location}.`
        : assessment?.speech || `Found it. I can see ${this.goal?.target} ${location}.`;
      this.onAnnounce(text, "FOUND");
      this.tools.log("decision", "Target confirmed", `${this.confirmations} consecutive observations`);
      return;
    }
    if (this.confirmations === 1) this.state.transition("VERIFYING");
    else if (assessment?.guidance && assessment.guidance !== "NONE" && assessment.shouldSpeak) this.state.transition("GUIDING");
    else this.state.transition("SEARCHING");

    const speech = assessment?.speech?.trim();
    if (speech && (!memorySearch || this.confirmations === 0) && speech !== this.lastGuidance && this.salience.decide(observation, this.goal, observation.events) === "ANNOUNCE") {
      const haptic = assessment?.guidance === "LEFT" ? "LEFT" : assessment?.guidance === "RIGHT" ? "RIGHT" : undefined;
      this.onAnnounce(speech, haptic);
      this.lastGuidance = speech;
      this.tools.log("decision", "Guidance issued", speech);
    }
  }

  private findMemoryCandidate(observation: VisionObservation): DetectedObject | undefined {
    const target = this.goal?.target ?? "";
    const expectedColor = this.goal?.attributes.color?.trim().toLowerCase();
    const expectedAppearance = this.goal?.attributes.appearance;
    const candidateIndex = observation.goalAssessment?.candidateObjectIndex;
    if (candidateIndex === undefined) return undefined;
    const candidate = observation.objects[candidateIndex];
    if (!candidate) return undefined;
    return [candidate]
      .filter((object) => object.confidence >= 0.65 && matchesObject(target, object))
      .filter((object) => {
        if (expectedColor) {
          const actualColor = object.color?.trim().toLowerCase();
          if (!actualColor || !(actualColor.includes(expectedColor) || expectedColor.includes(actualColor))) return false;
        }
        if (expectedAppearance) {
          if (!object.appearance || appearanceSimilarity(expectedAppearance, object.appearance) < APPEARANCE_MATCH_THRESHOLD) return false;
        }
        return true;
      })
      .sort((left, right) => right.confidence - left.confidence)[0];
  }

  private structuredPlacementEvidence(observation: VisionObservation, subject: string, relation: string, anchor: string): {
    object: DetectedObject;
    anchorObject: DetectedObject;
    previous: VisionObservation;
  } | undefined {
    if (observation.cameraMotion === "high") return undefined;
    const object = observation.objects.find((item) => matchesObject(subject, item));
    const anchorObject = observation.objects.find((item) => matchesObject(anchor, item));
    if (!object || object.confidence < 0.65 || !anchorObject || anchorObject.confidence < 0.65
      || !relationMatchesGeometry(relation, object, anchorObject)) return undefined;
    const previous = [...this.workingMemory.all()].reverse().find((item) => (
      item.frameId !== observation.frameId
      && item.freshness === "FRESH"
      && item.cameraMotion !== "high"
      && item.capturedAt < observation.capturedAt
      && observation.capturedAt - item.capturedAt <= CURRENT_EVIDENCE_MAX_AGE_MS
    ));
    if (!previous) return undefined;
    const previousObject = previous.objects.find((item) => matchesObject(subject, item));
    const previousAnchor = previous.objects.find((item) => matchesObject(anchor, item));
    if (!previousObject || previousObject.confidence < 0.65 || !previousAnchor || previousAnchor.confidence < 0.65) return undefined;
    const currentObjectCenter = objectCenter(object);
    const currentAnchorCenter = objectCenter(anchorObject);
    const previousObjectCenter = objectCenter(previousObject);
    const previousAnchorCenter = objectCenter(previousAnchor);
    if (!currentObjectCenter || !currentAnchorCenter || !previousObjectCenter || !previousAnchorCenter) return undefined;
    const relativeMovement = Math.hypot(
      (currentObjectCenter.x - currentAnchorCenter.x) - (previousObjectCenter.x - previousAnchorCenter.x),
      (currentObjectCenter.y - currentAnchorCenter.y) - (previousObjectCenter.y - previousAnchorCenter.y),
    );
    return relativeMovement >= MIN_RELATIVE_PLACEMENT_MOVEMENT ? { object, anchorObject, previous } : undefined;
  }

  private rememberObservedPlacements(observation: VisionObservation): Set<string> {
    const remembered = new Set<string>();
    for (const placement of observation.placementEvents ?? []) {
      if (placement.type !== "PUT_DOWN" || placement.confidence < 0.75) continue;
      const evidence = this.structuredPlacementEvidence(observation, placement.subject, placement.relation, placement.anchor);
      if (!evidence) continue;
      const { object, previous } = evidence;
      const location = canonicalPlacementLocation(placement.relation, placement.anchor);
      this.episodicMemory.remember({
        id: `memory-${observation.frameId}-${placement.subject.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
        timestamp: observation.capturedAt,
        subject: placement.subject,
        action: "PUT_DOWN",
        location,
        relation: placement.relation,
        anchor: placement.anchor,
        appearance: placement.appearance ?? object.appearance,
        attributes: placement.color || object.color ? { color: placement.color ?? object.color } : undefined,
        confidence: Math.min(placement.confidence, object.confidence),
        evidence: {
          frameIds: [previous.frameId, observation.frameId],
          observationIds: [previous.id, observation.id],
        },
        lastConfirmedAt: observation.capturedAt,
        epistemic: "LAST_SEEN",
      });
      const normalizedSubject = placement.subject.toLowerCase();
      remembered.add(normalizedSubject);
      this.tools.log("memory", "Placement remembered", `${placement.subject} ${location}`);
    }
    return remembered;
  }

  private handleRemember(observation: VisionObservation, rememberedPlacements: Set<string>): void {
    const target = this.goal?.target ?? "object";
    if ([...rememberedPlacements].some((subject) => subject.includes(target.toLowerCase()) || target.toLowerCase().includes(subject))) {
      const placement = this.episodicMemory.recallPlacement(target);
      this.onAnnounce(`I’ll remember that you put ${target}${placement?.location ? ` ${placement.location}` : ""}.`);
      this.state.setMode("IDLE");
      this.goal = undefined;
      return;
    }
    const object = observation.objects.find((item) => queryMatchesSubject(target, item.label, item.color));
    if (!object || object.confidence < 0.65) return;
    const location = object.spatialRelation?.join(" ") || "in the current view";
    this.episodicMemory.remember({
      id: `memory-${this.now()}`,
      timestamp: observation.capturedAt,
      subject: target,
      action: "LAST_SEEN",
      location,
      appearance: object.appearance,
      attributes: { label: object.label, aliases: object.aliases, color: object.color },
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

  private handleRead(observation: VisionObservation): void {
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
