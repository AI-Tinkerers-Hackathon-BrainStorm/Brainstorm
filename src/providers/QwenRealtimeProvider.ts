import type {
  ConnectionMode,
  ConnectionState,
  EncodedFrame,
  RealtimeTelemetry,
  TurnLatencyTelemetry,
  VisionObservation,
} from "../types/index.ts";
import { REALTIME_AGENT_SYSTEM_PROMPT } from "../agent/prompts.ts";
import { REALTIME_VOICE } from "../config/models.ts";
import type { RealtimeProvider, SendTextOptions, TranscriptHandler, Unsubscribe } from "./RealtimeProvider.ts";

type HandlerMap = {
  transcript: TranscriptHandler;
  audio: (audio: Blob) => void;
  tool: (name: string, input: unknown, callId?: string) => void;
  observation: (observation: VisionObservation) => void;
  connection: (state: ConnectionState) => void;
  telemetry: (telemetry: RealtimeTelemetry) => void;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const INITIAL_TELEMETRY: RealtimeTelemetry = {
  transport: "OFFLINE",
  peerConnectionState: "unavailable",
  iceConnectionState: "unavailable",
  dataChannelState: "unavailable",
  realtimeSessionState: "unavailable",
  realtimeVideoTrackState: "unavailable",
  nativeAudioTrackReceived: false,
  nativeAudioPlaying: false,
};

export function canReportWebRtcConnected(
  peerConnectionState: RTCPeerConnectionState | "unavailable",
  iceConnectionState: RTCIceConnectionState | "unavailable",
  dataChannelState: RTCDataChannelState | "unavailable",
  realtimeVideoTrackState: MediaStreamTrackState | "unavailable" = "live",
  realtimeSessionState: RealtimeTelemetry["realtimeSessionState"] = "ready",
): boolean {
  const peerReady = peerConnectionState === "connected" || iceConnectionState === "connected" || iceConnectionState === "completed";
  return peerReady && dataChannelState === "open" && realtimeVideoTrackState === "live" && realtimeSessionState === "ready";
}

export function shouldEmitRealtimeAgentOutput(responseSuppressed: boolean): boolean {
  return !responseSuppressed;
}

function errorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 180);
}

export class QwenRealtimeProvider implements RealtimeProvider {
  private state: ConnectionState = "OFFLINE";
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private media?: MediaStream;
  private previewVideo?: HTMLVideoElement;
  private remoteAudio?: HTMLAudioElement;
  private sampledVideo?: MediaStream;
  private sampleTimer?: ReturnType<typeof setInterval>;
  private visionAbort?: AbortController;
  private disconnecting = false;
  private responseActive = false;
  private responseSuppressed = false;
  private sessionUpdateSent = false;
  private enableRealtimeMedia?: () => Promise<void>;
  private mediaEnablePromise?: Promise<void>;
  private readonly intentionalClose = new WeakSet<object>();
  private turnSequence = 0;
  private telemetry: RealtimeTelemetry = { ...INITIAL_TELEMETRY };
  private handlers: { [K in keyof HandlerMap]: Set<HandlerMap[K]> } = {
    transcript: new Set(),
    audio: new Set(),
    tool: new Set(),
    observation: new Set(),
    connection: new Set(),
    telemetry: new Set(),
  };

  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  get nativeAudioConnected(): boolean {
    return this.telemetry.nativeAudioTrackReceived && this.telemetry.nativeAudioPlaying;
  }

  get currentTelemetry(): RealtimeTelemetry {
    return this.copyTelemetry();
  }

  attachRemoteAudioElement(audio: HTMLAudioElement | undefined): void {
    if (audio) this.remoteAudio = audio;
  }

  async connect(): Promise<void> {
    this.disconnecting = false;
    this.responseSuppressed = false;
    this.sessionUpdateSent = false;
    this.setState("CONNECTING");
    this.updateTelemetry({ lastError: undefined });
    let providerAvailable = false;
    try {
      const response = await this.fetcher("/api/health", { cache: "no-store" });
      if (!response.ok) throw new Error(`provider_health_${response.status}`);
      providerAvailable = true;
      await this.connectWebRtc();
      if (!canReportWebRtcConnected(this.telemetry.peerConnectionState, this.telemetry.iceConnectionState, this.telemetry.dataChannelState, this.telemetry.realtimeVideoTrackState, this.telemetry.realtimeSessionState)) {
        throw new Error("webrtc_not_ready");
      }
      this.setState("WEBRTC_CONNECTED");
    } catch (error) {
      this.updateTelemetry({ lastError: errorCategory(error) });
      this.disconnecting = true;
      this.closePeer();
      this.disconnecting = false;
      this.setState(providerAvailable ? "FALLBACK" : "OFFLINE");
    }
  }

  attachMedia(stream: MediaStream, previewVideo: HTMLVideoElement): void {
    this.media = stream;
    this.previewVideo = previewVideo;
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.responseSuppressed = false;
    this.sessionUpdateSent = false;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
    this.sampledVideo?.getTracks().forEach((track) => track.stop());
    this.sampledVideo = undefined;
    this.visionAbort?.abort();
    this.closePeer();
    this.remoteAudio = undefined;
    this.telemetry = { ...INITIAL_TELEMETRY };
    this.setState("OFFLINE");
    this.emitTelemetry();
  }

  async sendAudio(): Promise<void> { /* RTP or browser speech recognition owns audio input. */ }

  async sendText(text: string, options: SendTextOptions = {}): Promise<void> {
    const now = Date.now();
    this.startTurn({
      turnId: `turn-${now}-${++this.turnSequence}`,
      speechEndAt: options.timing?.speechEndAt ?? now,
      transcriptAt: options.timing?.transcriptAt ?? now,
      requestSentAt: now,
    });

    if (!options.forceFallback && this.state === "WEBRTC_CONNECTED" && this.channel?.readyState === "open"
      && canReportWebRtcConnected(this.telemetry.peerConnectionState, this.telemetry.iceConnectionState, this.telemetry.dataChannelState, this.telemetry.realtimeVideoTrackState, this.telemetry.realtimeSessionState)) {
      this.channel.send(JSON.stringify({
        event_id: `event-${now}`,
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }));
      this.channel.send(JSON.stringify({ type: "response.create" }));
      return;
    }

    if (!options.forceFallback) this.setState("FALLBACK");
    try {
      const response = await this.fetcher("/api/realtime/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, context: options.context?.slice(0, 1_000) }),
      });
      const firstModelEventAt = Date.now();
      this.markTurn({ firstModelEventAt });
      if (!response.ok) throw new Error(`text_fallback_${response.status}`);
      const payload = await response.json() as { text?: string };
      if (!payload.text?.trim()) throw new Error("text_fallback_empty");
      const responseDoneAt = Date.now();
      this.markTurn({ responseDoneAt });
      this.emit("transcript", { role: "agent", text: payload.text.trim(), timing: this.telemetry.turn, fallback: true });
    } catch (error) {
      this.updateTelemetry({ lastError: errorCategory(error) });
      this.setState("DEGRADED");
      throw error;
    }
  }

  async sendVideoFrame(frame: EncodedFrame, context: { goal?: string; recentContext?: string }): Promise<void> {
    const form = new FormData();
    form.set("frame", frame.blob, `${frame.frameId}.jpg`);
    form.set("metadata", JSON.stringify({
      frameId: frame.frameId,
      capturedAt: frame.capturedAt,
      requestSentAt: Date.now(),
      purpose: "background",
      width: frame.width,
      height: frame.height,
      ...context,
    }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("background_vision_timeout"), 13_500);
    this.visionAbort = controller;
    try {
      const response = await this.fetcher("/api/vision", { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) throw new Error(`vision_background_${response.status}`);
      const observation = await response.json() as VisionObservation;
      this.emit("observation", observation);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DOMException(typeof controller.signal.reason === "string" ? controller.signal.reason : "Background vision aborted", "AbortError");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.visionAbort === controller) this.visionAbort = undefined;
    }
  }

  cancelPendingVision(): void { this.visionAbort?.abort("superseded_by_manual_scan"); }

  cancelResponse(): void {
    if (this.channel?.readyState === "open" && this.responseActive) {
      this.channel.send(JSON.stringify({ type: "response.cancel" }));
      this.responseActive = false;
    }
  }

  setResponseSuppressed(suppressed: boolean): void {
    this.responseSuppressed = suppressed;
    if (this.remoteAudio) this.remoteAudio.muted = suppressed;
    if (suppressed) this.cancelResponse();
  }

  markBrowserAudioStarted(at = Date.now()): void { this.markTurn({ firstAudioAt: this.telemetry.turn?.firstAudioAt ?? at }); }
  markBrowserAudioDone(at = Date.now()): void { this.markTurn({ responseDoneAt: this.telemetry.turn?.responseDoneAt ?? at }); }

  onTranscript(handler: TranscriptHandler): Unsubscribe { return this.subscribe("transcript", handler); }
  onAudio(handler: (audio: Blob) => void): Unsubscribe { return this.subscribe("audio", handler); }
  onToolCall(handler: (name: string, input: unknown, callId?: string) => void): Unsubscribe { return this.subscribe("tool", handler); }
  onObservation(handler: (observation: VisionObservation) => void): Unsubscribe { return this.subscribe("observation", handler); }
  onConnectionState(handler: (state: ConnectionState) => void): Unsubscribe { return this.subscribe("connection", handler); }
  onTelemetry(handler: (telemetry: RealtimeTelemetry) => void): Unsubscribe { return this.subscribe("telemetry", handler); }

  private subscribe<K extends keyof HandlerMap>(type: K, handler: HandlerMap[K]): Unsubscribe {
    (this.handlers[type] as Set<HandlerMap[K]>).add(handler);
    return () => (this.handlers[type] as Set<HandlerMap[K]>).delete(handler);
  }

  private emit<K extends keyof HandlerMap>(type: K, ...args: Parameters<HandlerMap[K]>) {
    for (const handler of this.handlers[type]) (handler as (...values: Parameters<HandlerMap[K]>) => void)(...args);
  }

  private setState(state: ConnectionState) {
    if (state !== "CONNECTING") this.telemetry.transport = state as ConnectionMode;
    if (state !== this.state) {
      this.state = state;
      this.emit("connection", state);
    }
    this.emitTelemetry();
  }

  private updateTelemetry(update: Partial<RealtimeTelemetry>): void {
    this.telemetry = { ...this.telemetry, ...update };
    this.emitTelemetry();
  }

  private startTurn(turn: TurnLatencyTelemetry): void {
    this.telemetry = { ...this.telemetry, turn: { ...turn } };
    this.emitTelemetry();
  }

  private markTurn(update: Partial<TurnLatencyTelemetry>): void {
    if (!this.telemetry.turn) this.startTurn({ turnId: `turn-${Date.now()}-${++this.turnSequence}` });
    this.telemetry = { ...this.telemetry, turn: { ...this.telemetry.turn!, ...update } };
    this.emitTelemetry();
  }

  private copyTelemetry(): RealtimeTelemetry {
    return { ...this.telemetry, turn: this.telemetry.turn ? { ...this.telemetry.turn } : undefined };
  }

  private emitTelemetry(): void { this.emit("telemetry", this.copyTelemetry()); }

  private updateTransportTelemetry(): void {
    this.updateTelemetry({
      peerConnectionState: this.peer?.connectionState ?? "unavailable",
      iceConnectionState: this.peer?.iceConnectionState ?? "unavailable",
      dataChannelState: this.channel?.readyState ?? "unavailable",
      realtimeVideoTrackState: this.sampledVideo?.getVideoTracks()[0]?.readyState ?? "unavailable",
    });
  }

  private closePeer(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
    for (const track of this.sampledVideo?.getTracks() ?? []) {
      this.intentionalClose.add(track);
      track.stop();
    }
    this.sampledVideo = undefined;
    this.enableRealtimeMedia = undefined;
    this.mediaEnablePromise = undefined;
    if (this.channel) this.intentionalClose.add(this.channel);
    if (this.peer) this.intentionalClose.add(this.peer);
    this.channel?.close();
    this.peer?.close();
    this.channel = undefined;
    this.peer = undefined;
    this.updateTelemetry({
      peerConnectionState: "unavailable",
      iceConnectionState: "unavailable",
      dataChannelState: "unavailable",
      realtimeSessionState: "unavailable",
      realtimeVideoTrackState: "unavailable",
      nativeAudioTrackReceived: false,
      nativeAudioPlaying: false,
    });
  }

  private bindDataChannel(channel: RTCDataChannel): void {
    const activate = () => {
      if (!this.channel || channel.label === "txt") this.channel = channel;
      this.updateTransportTelemetry();
    };
    channel.addEventListener("message", (event) => this.handleRealtimeEvent(event.data, channel));
    channel.addEventListener("open", activate);
    channel.addEventListener("close", () => {
      if (this.channel !== channel) return;
      this.updateTransportTelemetry();
      if (!this.disconnecting && !this.intentionalClose.has(channel)) {
        this.updateTelemetry({ lastError: "webrtc_data_channel_closed" });
        this.setState("FALLBACK");
        this.closePeer();
      }
    });
    channel.addEventListener("error", () => {
      if (this.channel !== channel) return;
      this.updateTelemetry({ lastError: "webrtc_data_channel_error" });
      if (!this.disconnecting) {
        this.setState("FALLBACK");
        this.closePeer();
      }
    });
    if (channel.readyState === "open") activate();
  }

  private sendSessionUpdate(channel: RTCDataChannel): void {
    if (this.sessionUpdateSent || channel.readyState !== "open") return;
    this.sessionUpdateSent = true;
    channel.send(JSON.stringify({
      event_id: `event-${Date.now()}`,
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: REALTIME_VOICE,
        instructions: REALTIME_AGENT_SYSTEM_PROMPT,
        audio: {
          input: { format: { type: "pcm", sample_rate: 16_000 } },
          output: { format: { type: "pcm", sample_rate: 24_000 } },
        },
        input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
        turn_detection: { type: "semantic_vad", prefix_padding_ms: 350, silence_duration_ms: 500 },
        temperature: 0.35,
        max_tokens: 300,
        tools: [
          { type: "function", function: { name: "set_goal", description: "Set a continuing find, remember, monitor, or reading task.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
          { type: "function", function: { name: "clear_goal", description: "Stop the current visual task.", parameters: { type: "object", properties: {} } } },
          { type: "function", function: { name: "remember_event", description: "Save a useful structured last-seen visual event.", parameters: { type: "object", properties: { subject: { type: "string" }, action: { type: "string" }, location: { type: "string" }, confidence: { type: "number" } }, required: ["subject", "action", "confidence"] } } },
          { type: "function", function: { name: "recall_memory", description: "Recall the latest structured event for a subject.", parameters: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] } } },
          { type: "function", function: { name: "request_deep_vision", description: "Run one high-resolution detailed current-scene inventory.", parameters: { type: "object", properties: { reason: { type: "string" } } } } },
          { type: "function", function: { name: "request_ocr", description: "Capture and read text from the current view.", parameters: { type: "object", properties: { reason: { type: "string" } } } } },
          { type: "function", function: { name: "vibrate", description: "Trigger accessible haptic guidance.", parameters: { type: "object", properties: { pattern: { type: "string", enum: ["LEFT", "RIGHT", "FOUND", "WARNING"] } }, required: ["pattern"] } } },
          { type: "function", function: { name: "announce", description: "Speak a brief, safety-calibrated message.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
        ],
      },
    }));
  }

  protected async connectWebRtc(): Promise<void> {
    if (!this.media) throw new Error("webrtc_media_unavailable");
    if (!this.previewVideo) throw new Error("webrtc_preview_unavailable");
    if (typeof RTCPeerConnection === "undefined") throw new Error("webrtc_unsupported");

    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    const audioTracks = this.media.getAudioTracks().filter((track) => track.enabled && track.readyState === "live");
    if (!audioTracks.length) throw new Error("webrtc_source_audio_unavailable");
    const audioSenders = audioTracks.map((track) => peer.addTrack(track, this.media!));
    peer.addEventListener("datachannel", (event) => this.bindDataChannel(event.channel));

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("webrtc_canvas_unavailable");
    const sourceVideoTrack = this.media.getVideoTracks().find((track) => track.enabled && track.readyState === "live");
    if (!sourceVideoTrack) throw new Error("webrtc_source_video_unavailable");
    if (this.previewVideo.readyState < 2 || this.previewVideo.videoWidth <= 0 || this.previewVideo.videoHeight <= 0) {
      throw new Error("webrtc_source_frame_unavailable");
    }
    context.drawImage(this.previewVideo, 0, 0, canvas.width, canvas.height);
    if (typeof canvas.captureStream !== "function") throw new Error("webrtc_canvas_capture_unsupported");
    const capture = canvas.captureStream(1);
    const sampledVideoTrack = capture.getVideoTracks()[0];
    if (!sampledVideoTrack || sampledVideoTrack.readyState !== "live") throw new Error("webrtc_video_track_unavailable");
    this.sampledVideo = capture;
    this.updateTelemetry({ realtimeVideoTrackState: "live", lastRealtimeVideoFrameAt: Date.now() });
    const draw = () => {
      if (!this.previewVideo || sampledVideoTrack.readyState !== "live") return;
      if (this.previewVideo.readyState < 2 || this.previewVideo.videoWidth <= 0 || this.previewVideo.videoHeight <= 0) return;
      try {
        context.drawImage(this.previewVideo, 0, 0, canvas.width, canvas.height);
        (sampledVideoTrack as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.();
        this.updateTelemetry({ realtimeVideoTrackState: sampledVideoTrack.readyState, lastRealtimeVideoFrameAt: Date.now() });
      } catch (error) {
        this.updateTelemetry({ lastError: `realtime_video_draw:${errorCategory(error)}` });
      }
    };
    this.sampleTimer = setInterval(draw, 1_000);
    sampledVideoTrack.addEventListener("ended", () => {
      if (this.disconnecting || this.intentionalClose.has(sampledVideoTrack)) return;
      this.updateTelemetry({ realtimeVideoTrackState: "ended", lastError: "webrtc_video_track_ended" });
      this.setState("FALLBACK");
      this.closePeer();
    });
    const videoSender = peer.addTrack(sampledVideoTrack, capture);
    try {
      const parameters = videoSender.getParameters();
      parameters.encodings ??= [{}];
      parameters.encodings[0].maxFramerate = 1;
      parameters.encodings[0].maxBitrate = 300_000;
      parameters.degradationPreference = "maintain-resolution";
      await videoSender.setParameters(parameters);
    } catch { /* Safari may not allow sender tuning before negotiation; the canvas remains capped at 1 FPS. */ }

    await Promise.all([...audioSenders.map((sender) => sender.replaceTrack(null)), videoSender.replaceTrack(null)]);
    this.enableRealtimeMedia = async () => {
      await Promise.all([
        ...audioSenders.map((sender, index) => sender.replaceTrack(audioTracks[index])),
        videoSender.replaceTrack(sampledVideoTrack),
      ]);
    };

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    this.bindDataChannel(channel);

    peer.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") return;
      const audio = this.remoteAudio ?? document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.hidden = true;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      audio.muted = this.responseSuppressed;
      if (!audio.isConnected) document.body.appendChild(audio);
      this.remoteAudio = audio;
      this.updateTelemetry({ nativeAudioTrackReceived: true });
      audio.addEventListener("playing", () => {
        this.updateTelemetry({ nativeAudioPlaying: true });
        if (this.telemetry.turn) this.markTurn({ firstAudioAt: this.telemetry.turn.firstAudioAt ?? Date.now() });
      });
      audio.addEventListener("pause", () => this.updateTelemetry({ nativeAudioPlaying: false }));
      void audio.play().catch((error) => {
        this.updateTelemetry({ nativeAudioPlaying: false, lastError: `remote_audio_playback:${errorCategory(error)}` });
      });
    });
    peer.addEventListener("connectionstatechange", () => {
      this.updateTransportTelemetry();
      if (!this.disconnecting && !this.intentionalClose.has(peer) && ["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        this.updateTelemetry({ lastError: `webrtc_peer_${peer.connectionState}` });
        this.setState("FALLBACK");
        this.closePeer();
      }
    });
    peer.addEventListener("iceconnectionstatechange", () => {
      this.updateTransportTelemetry();
      if (!this.disconnecting && peer.iceConnectionState === "failed") {
        this.updateTelemetry({ lastError: "webrtc_ice_failed" });
        this.setState("FALLBACK");
        this.closePeer();
      }
    });

    const offer = await peer.createOffer({ offerToReceiveAudio: true });
    await peer.setLocalDescription(offer);
    await new Promise<void>((resolve) => {
      if (peer.iceGatheringState === "complete") { resolve(); return; }
      const done = () => {
        if (peer.iceGatheringState === "complete") {
          peer.removeEventListener("icegatheringstatechange", done);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", done);
      setTimeout(() => { peer.removeEventListener("icegatheringstatechange", done); resolve(); }, 2_500);
    });
    const response = await this.fetcher("/api/realtime/offer", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: peer.localDescription?.sdp ?? offer.sdp,
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/[^\w\s().:-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      throw new Error(`realtime_signaling_${response.status}${detail ? `:${detail}` : ""}`);
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });

    const deadline = Date.now() + 8_000;
    while (!canReportWebRtcConnected(peer.connectionState, peer.iceConnectionState, this.channel?.readyState ?? "unavailable", sampledVideoTrack.readyState, this.telemetry.realtimeSessionState)) {
      this.updateTransportTelemetry();
      if (this.state === "FALLBACK" || this.state === "DEGRADED" || this.state === "OFFLINE") {
        throw new Error(this.telemetry.lastError ?? "webrtc_session_failed");
      }
      if (Date.now() >= deadline) {
        throw new Error(`webrtc_ready_timeout:pc=${peer.connectionState},ice=${peer.iceConnectionState},dc=${this.channel?.readyState ?? "unavailable"},session=${this.telemetry.realtimeSessionState}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private handleRealtimeEvent(data: unknown, sourceChannel: RTCDataChannel): void {
    if (typeof data !== "string") return;
    try {
      const event = JSON.parse(data) as {
        type?: string;
        transcript?: string;
        text?: string;
        name?: string;
        arguments?: string;
        call_id?: string;
        error?: { message?: string };
      };
      const now = Date.now();
      if (event.type === "session.created") {
        this.channel = sourceChannel;
        this.updateTelemetry({ realtimeSessionState: "created" });
        this.sendSessionUpdate(sourceChannel);
      } else if (event.type === "session.updated") {
        this.channel = sourceChannel;
        this.mediaEnablePromise ??= (this.enableRealtimeMedia?.() ?? Promise.reject(new Error("webrtc_media_gate_unavailable")))
          .then(() => this.updateTelemetry({ realtimeSessionState: "ready" }))
          .catch((error) => {
            this.updateTelemetry({ lastError: `webrtc_media_enable:${errorCategory(error)}` });
            this.setState("FALLBACK");
            this.closePeer();
          });
      } else if (event.type === "input_audio_buffer.speech_started") {
        this.startTurn({ turnId: `turn-${now}-${++this.turnSequence}` });
      } else if (event.type === "input_audio_buffer.speech_stopped") {
        this.markTurn({ speechEndAt: now });
      } else if (event.type === "input_audio_buffer.committed") {
        this.markTurn({ requestSentAt: now });
      } else if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
        this.markTurn({ transcriptAt: now });
        this.emit("transcript", { role: "user", text: event.transcript, timing: this.telemetry.turn });
      } else if (event.type === "response.audio_transcript.done" && event.transcript) {
        this.markTurn({ firstModelEventAt: this.telemetry.turn?.firstModelEventAt ?? now });
        if (shouldEmitRealtimeAgentOutput(this.responseSuppressed)) this.emit("transcript", { role: "agent", text: event.transcript, timing: this.telemetry.turn });
      } else if (event.type === "response.text.done" && event.text) {
        this.markTurn({ firstModelEventAt: this.telemetry.turn?.firstModelEventAt ?? now });
        if (shouldEmitRealtimeAgentOutput(this.responseSuppressed)) this.emit("transcript", { role: "agent", text: event.text, timing: this.telemetry.turn });
      } else if (event.type === "response.function_call_arguments.done" && event.name) {
        this.markTurn({ firstModelEventAt: this.telemetry.turn?.firstModelEventAt ?? now });
        if (shouldEmitRealtimeAgentOutput(this.responseSuppressed)) this.emit("tool", event.name, event.arguments ? JSON.parse(event.arguments) : {}, event.call_id);
      } else if (event.type === "response.created") {
        this.responseActive = true;
        if (this.responseSuppressed) {
          this.cancelResponse();
          return;
        }
        this.markTurn({ firstModelEventAt: this.telemetry.turn?.firstModelEventAt ?? now });
      } else if (event.type === "response.done") {
        this.responseActive = false;
        this.markTurn({ responseDoneAt: now });
      } else if (event.type?.startsWith("response.") || event.type === "conversation.item.created") {
        this.markTurn({ firstModelEventAt: this.telemetry.turn?.firstModelEventAt ?? now });
        if (event.type === "response.audio_transcript.delta" && this.telemetry.nativeAudioPlaying) {
          this.markTurn({ firstAudioAt: this.telemetry.turn?.firstAudioAt ?? now });
        }
      } else if (event.type === "error") {
        this.updateTelemetry({ lastError: `provider_event:${event.error?.message?.slice(0, 120) || "unknown"}` });
        this.setState("DEGRADED");
      }
    } catch {
      this.updateTelemetry({ lastError: "malformed_realtime_control_event" });
    }
  }

  sendToolResult(callId: string | undefined, result: unknown): void {
    if (!callId) throw new Error("tool_call_id_missing");
    if (this.channel?.readyState !== "open") throw new Error("realtime_data_channel_closed");
    this.channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result ?? null) },
    }));
    if (!this.responseSuppressed) this.channel.send(JSON.stringify({ type: "response.create" }));
  }
}
