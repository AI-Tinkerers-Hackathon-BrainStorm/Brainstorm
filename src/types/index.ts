export type AgentMode = "IDLE" | "EXPLORE" | "FIND" | "READ" | "REMEMBER" | "REVIEW";

export type AgentStatus =
  | "LISTENING"
  | "OBSERVING"
  | "THINKING"
  | "SEARCHING"
  | "GUIDING"
  | "VERIFYING"
  | "TARGET_FOUND"
  | "READING"
  | "DEGRADED"
  | "ERROR";

export type ConnectionMode = "WEBRTC_CONNECTED" | "FALLBACK" | "DEGRADED" | "OFFLINE";
export type ConnectionState = "CONNECTING" | ConnectionMode;
export type EpistemicState = "CURRENTLY_VISIBLE" | "LAST_SEEN" | "INFERRED" | "UNKNOWN";
export type QualityTier = "HIGH" | "BALANCED" | "SAFE";
export type SpatialPosition = "far-left" | "left" | "center-left" | "center" | "center-right" | "right" | "far-right";

export interface NormalizedBBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DetectedObject {
  id?: string;
  label: string;
  aliases?: string[];
  bbox?: NormalizedBBox;
  center?: { x: number; y: number };
  color?: string;
  attributes?: string[];
  spatialRelation?: string[];
  confidence: number;
  source: "realtime" | "deep_vision" | "ocr" | "temporal_inference";
}

export interface OCRText {
  text: string;
  bbox?: NormalizedBBox;
  confidence?: number;
}

export interface GoalAssessment {
  relevant: boolean;
  targetVisible: boolean;
  candidateConfidence: number;
  spatialPosition?: SpatialPosition;
  guidance?: "LEFT" | "RIGHT" | "CENTER" | "HOLD" | "NONE";
  shouldSpeak: boolean;
  speech?: string;
}

export interface TemporalEvent {
  type:
    | "APPEARED"
    | "DISAPPEARED"
    | "NOT_IN_CURRENT_VIEW"
    | "MOVED"
    | "PUT_DOWN"
    | "PICKED_UP"
    | "OPENED"
    | "CLOSED"
    | "APPROACHING"
    | "RECEDING";
  subject: string;
  confidence: number;
  evidenceFrameIds: string[];
  description?: string;
}

export interface VisionObservation {
  id: string;
  frameId: string;
  capturedAt: number;
  requestSentAt: number;
  receivedAt: number;
  freshness: "FRESH" | "STALE";
  purpose: "background" | "detailed" | "ocr";
  staleReason?: string;
  sceneSummary: string;
  objects: DetectedObject[];
  text: OCRText[];
  cameraMotion?: "low" | "medium" | "high";
  source: "realtime" | "deep_vision" | "ocr" | "temporal_inference";
  goalAssessment?: GoalAssessment;
  events?: TemporalEvent[];
  model?: string;
}

export interface CachedDetailedScene {
  id: string;
  capturedAt: number;
  receivedAt: number;
  model: string;
  sceneSummary: string;
  objects: Array<{ label: string; color?: string; confidence: number; spatialRelation?: string[] }>;
  text: string[];
  epistemic: "LAST_SEEN";
}

export interface TurnLatencyTelemetry {
  turnId: string;
  speechEndAt?: number;
  transcriptAt?: number;
  requestSentAt?: number;
  firstModelEventAt?: number;
  firstAudioAt?: number;
  responseDoneAt?: number;
}

export interface RealtimeTelemetry {
  transport: ConnectionMode;
  peerConnectionState: RTCPeerConnectionState | "unavailable";
  iceConnectionState: RTCIceConnectionState | "unavailable";
  dataChannelState: RTCDataChannelState | "unavailable";
  realtimeSessionState: "unavailable" | "created" | "ready";
  realtimeVideoTrackState: MediaStreamTrackState | "unavailable";
  lastRealtimeVideoFrameAt?: number;
  nativeAudioTrackReceived: boolean;
  nativeAudioPlaying: boolean;
  lastError?: string;
  turn?: TurnLatencyTelemetry;
}

export interface AgentGoal {
  id: string;
  type: "find" | "read" | "remember" | "review" | "explore";
  target: string;
  attributes: Record<string, string>;
  createdAt: number;
  fastMode?: boolean;
}

export interface MemoryEvent {
  id: string;
  timestamp: number;
  subject: string;
  action: string;
  location?: string;
  attributes?: Record<string, unknown>;
  confidence: number;
  evidence: { frameIds: string[]; observationIds: string[] };
  lastConfirmedAt?: number;
  epistemic: Exclude<EpistemicState, "CURRENTLY_VISIBLE">;
}

export interface TimelineEntry {
  id: string;
  timestamp: number;
  kind: "goal" | "observation" | "decision" | "action" | "memory" | "system" | "error";
  label: string;
  detail?: string;
}

export interface EncodedFrame {
  frameId: string;
  capturedAt: number;
  blob: Blob;
  width: number;
  height: number;
  manual?: boolean;
}

export interface PerformanceSnapshot {
  quality: QualityTier;
  aiFps: number;
  previewHeight: number;
  visionLatencyMs: number;
  encodeLatencyMs: number;
  requestFailures: number;
  pendingCalls: number;
  droppedFrames: number;
}
