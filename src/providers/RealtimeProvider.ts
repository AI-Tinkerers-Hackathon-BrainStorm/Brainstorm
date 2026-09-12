import type { ConnectionState, EncodedFrame, RealtimeTelemetry, TurnLatencyTelemetry, VisionObservation } from "../types/index.ts";

export type Unsubscribe = () => void;
export type TranscriptHandler = (event: { role: "user" | "agent"; text: string; timing?: TurnLatencyTelemetry; fallback?: boolean }) => void;

export interface SendTextOptions {
  context?: string;
  timing?: Pick<TurnLatencyTelemetry, "speechEndAt" | "transcriptAt">;
}

export interface RealtimeProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(audio: Blob, capturedAt: number): Promise<void>;
  sendVideoFrame(frame: EncodedFrame, context: { goal?: string; recentContext?: string }): Promise<void>;
  sendText(text: string, options?: SendTextOptions): Promise<void>;
  onTranscript(handler: TranscriptHandler): Unsubscribe;
  onAudio(handler: (audio: Blob) => void): Unsubscribe;
  onToolCall(handler: (name: string, input: unknown, callId?: string) => void): Unsubscribe;
  onObservation(handler: (observation: VisionObservation) => void): Unsubscribe;
  onConnectionState(handler: (state: ConnectionState) => void): Unsubscribe;
  onTelemetry(handler: (telemetry: RealtimeTelemetry) => void): Unsubscribe;
}
