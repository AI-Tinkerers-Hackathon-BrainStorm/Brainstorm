"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Camera,
  ChevronRight,
  CircleStop,
  Eye,
  Gauge,
  ListTree,
  LogOut,
  Mic,
  MicOff,
  RotateCcw,
  ScanLine,
  Send,
  ShieldAlert,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { AgentOrchestrator, type AgentSnapshot } from "@/src/agent/AgentOrchestrator.ts";
import { detailedObservationSpeech, scanAddsNewObjects } from "@/src/agent/EvidenceReply.ts";
import { parseUserIntent } from "@/src/agent/GoalParser.ts";
import { ASR_WATCHDOG_MS, shouldFallbackUnansweredTurn } from "@/src/agent/TurnWatchdog.ts";
import { AudioManager, shouldUseSpeechSynthesis, type TranscriptTiming } from "@/src/media/AudioManager.ts";
import { CameraManager } from "@/src/media/CameraManager.ts";
import { captureHighResolution, FrameSampler } from "@/src/media/FrameSampler.ts";
import { AdaptiveQualityController } from "@/src/performance/AdaptiveQualityController.ts";
import { PerformanceMonitor } from "@/src/performance/PerformanceMonitor.ts";
import { QwenDeepVisionProvider, runFastWithMaxFallback, VisionClientError } from "@/src/providers/DeepVisionProvider.ts";
import { QwenOCRProvider } from "@/src/providers/OCRProvider.ts";
import { QwenRealtimeProvider } from "@/src/providers/QwenRealtimeProvider.ts";
import { useAuth } from "@/src/auth/AuthContext";
import { announce } from "@/src/tools/announce.ts";
import { vibrate, type HapticPattern } from "@/src/tools/vibration.ts";
import type { CachedDetailedScene, ConnectionState, MemoryEvent, PerformanceSnapshot, RealtimeTelemetry, VisionObservation } from "@/src/types/index.ts";

type ChatItem = { id: string; role: "agent" | "user" | "system"; text: string; timestamp: number };
type CameraState = "ready" | "starting" | "live" | "error";

const initialPerformance: PerformanceSnapshot = {
  quality: "HIGH", aiFps: 1, previewHeight: 720, visionLatencyMs: 0,
  encodeLatencyMs: 0, requestFailures: 0, pendingCalls: 0, droppedFrames: 0,
};

const initialRealtimeTelemetry: RealtimeTelemetry = {
  transport: "OFFLINE",
  peerConnectionState: "unavailable",
  iceConnectionState: "unavailable",
  dataChannelState: "unavailable",
  realtimeSessionState: "unavailable",
  realtimeVideoTrackState: "unavailable",
  nativeAudioTrackReceived: false,
  nativeAudioPlaying: false,
};

const initialSnapshot: AgentSnapshot = {
  mode: "IDLE", status: "LISTENING", timeline: [], memory: [], detailedScenes: [], confirmationCount: 0,
};

function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function goalLabel(snapshot: AgentSnapshot) {
  if (!snapshot.goal) return "Waiting for a goal";
  const color = snapshot.goal.attributes.color;
  const verb = snapshot.goal.type === "find" ? "Find" : snapshot.goal.type === "read" ? "Read" : snapshot.goal.type === "remember" ? "Remember" : snapshot.goal.type === "review" ? "Review" : "Watch";
  return `${verb} ${color ? `${color} ` : ""}${snapshot.goal.target}`;
}

function latency(start?: number, end?: number) {
  return start !== undefined && end !== undefined && end >= start ? `${end - start} ms` : "—";
}

function cachedDetailedSpeech(scene: CachedDetailedScene) {
  const labels = [...new Set(scene.objects.filter((item) => item.confidence >= 0.45).map((item) => item.color ? `${item.color} ${item.label}` : item.label))].slice(0, 12);
  const inventory = labels.length ? ` It included: ${labels.join(", ")}.` : "";
  return `I couldn’t refresh the camera analysis. In the last detailed scan at ${timeLabel(scene.capturedAt)}, I saw: ${scene.sceneSummary}${inventory} I can’t confirm those items are still visible.`;
}

function visionFailureMessage(error: unknown) {
  if (!(error instanceof VisionClientError)) return "Scan failed. The camera preview is still available; try once more.";
  if (error.code === "provider_auth") return "Visual analysis is not authorized for this model. Check the DashScope key, workspace, and model access.";
  if (error.code === "provider_rate_limit") return "Visual analysis is temporarily rate-limited. Wait a moment and try again.";
  if (error.code === "provider_timeout") return "Visual analysis took too long. The camera is still active; try another scan.";
  if (error.code === "invalid_json") return "The visual model answered, but its structured result could not be validated. Try the scan again.";
  return "Visual analysis could not reach the model. The camera preview remains active.";
}

export function SightLoopApp() {
  // Each signed-in user keeps a separate episodic-memory namespace.
  const { user, signOut, memoryKey } = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef(new CameraManager());
  const audioRef = useRef(new AudioManager());
  const providerRef = useRef(new QwenRealtimeProvider());
  const deepVisionRef = useRef(new QwenDeepVisionProvider());
  const ocrRef = useRef(new QwenOCRProvider());
  const [qualityController] = useState(() => new AdaptiveQualityController());
  const [performanceMonitor] = useState(() => new PerformanceMonitor(qualityController));
  const samplerRef = useRef<FrameSampler | null>(null);
  const orchestratorRef = useRef<AgentOrchestrator | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);
  const scanPromiseRef = useRef<Promise<VisionObservation | undefined> | null>(null);
  const refinementAbortRef = useRef<AbortController | null>(null);
  const refinementPromiseRef = useRef<Promise<void> | null>(null);
  const backgroundFailuresRef = useRef(0);
  const scanActionRef = useRef<(forceOcr?: boolean) => Promise<VisionObservation | undefined>>(async () => undefined);
  const completedTurnRef = useRef<string | undefined>(undefined);
  const userTurnSequenceRef = useRef(0);
  const cameraSessionRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const lowBandwidthRef = useRef(false);
  const [cameraState, setCameraState] = useState<CameraState>("ready");
  const [connection, setConnection] = useState<ConnectionState>("OFFLINE");
  const [realtimeTelemetry, setRealtimeTelemetry] = useState<RealtimeTelemetry>(initialRealtimeTelemetry);
  const [snapshot, setSnapshot] = useState<AgentSnapshot>(initialSnapshot);
  const [performance, setPerformance] = useState(initialPerformance);
  const [lowBandwidth, setLowBandwidth] = useState(false);
  const [listening, setListening] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatItem[]>(() => [
    { id: "welcome", role: "agent", text: "I’m ready. Start the camera, then tell me what you need.", timestamp: Date.now() },
  ]);

  const addMessage = useCallback((role: ChatItem["role"], text: string) => {
    setMessages((items) => [...items, { id: `${Date.now()}-${items.length}`, role, text, timestamp: Date.now() }].slice(-30));
  }, []);

  const persistAgentSnapshot = useCallback((value: AgentSnapshot) => {
    try {
      localStorage.setItem(memoryKey, JSON.stringify(value.memory));
      localStorage.setItem(`${memoryKey}:detailed-scenes`, JSON.stringify(value.detailedScenes));
    } catch { /* Structured memory remains available for this session. */ }
  }, [memoryKey]);

  // Keep the newest message in view; older ones stay reachable by scrolling up.
  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const speak = useCallback((text: string, haptic?: HapticPattern) => {
    addMessage("agent", text);
    const started = announce(text, {
      onStart: (at) => providerRef.current.markBrowserAudioStarted(at),
      onEnd: (at) => providerRef.current.markBrowserAudioDone(at),
      onError: (message) => {
        if (!/interrupted|canceled/i.test(message)) setError("Audio playback failed. Tap Test Sound, check Silent Mode, and confirm the iPhone audio route.");
      },
    });
    if (!started) setError("Speech audio is unavailable. The response remains visible as text.");
    if (haptic) vibrate(haptic);
  }, [addMessage]);

  const handleObservation = useCallback((observation: VisionObservation) => {
    const staleAfterMs = observation.purpose === "background" ? 7_000 : observation.purpose === "ocr" ? 15_000 : 20_000;
    const ageMs = Date.now() - observation.capturedAt;
    const evaluated = ageMs > staleAfterMs
      ? { ...observation, freshness: "STALE" as const, staleReason: observation.staleReason ?? `captured_${ageMs}ms_before_client_use` }
      : observation;
    const next = evaluated.freshness === "STALE" && evaluated.purpose === "background"
      ? orchestratorRef.current?.recordHistoricalObservation(evaluated)
      : orchestratorRef.current?.observe(evaluated);
    if (!next) return;
    setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory] });
    persistAgentSnapshot(next);
  }, [persistAgentSnapshot]);

  const createSampler = useCallback(() => {
    if (!videoRef.current || !cameraRef.current.active || lowBandwidthRef.current || samplerRef.current || scanPromiseRef.current || refinementPromiseRef.current) return;
    const sampler = new FrameSampler(videoRef.current, async (frame, encodeMs) => {
      const monitor = performanceMonitor;
      monitor.encoded(encodeMs);
      monitor.requestStarted();
      const startedAt = Date.now();
      try {
        const state = orchestratorRef.current?.snapshot();
        const recent = state?.observation?.sceneSummary ?? "";
        await providerRef.current.sendVideoFrame(frame, { goal: state ? goalLabel(state) : undefined, recentContext: recent });
        backgroundFailuresRef.current = 0;
        monitor.requestFinished(Date.now() - startedAt);
      } catch (cause) {
        const cancelled = (cause as Error).name === "AbortError";
        monitor.requestFinished(Date.now() - startedAt, !cancelled);
        if (!cancelled) {
          backgroundFailuresRef.current += 1;
          orchestratorRef.current?.tools.log("error", "Background vision unavailable", cause instanceof Error ? cause.message.slice(0, 120) : "unknown_error");
          if (backgroundFailuresRef.current >= 3) orchestratorRef.current?.state.degrade();
          const next = orchestratorRef.current?.snapshot();
          if (next) setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory] });
          if (backgroundFailuresRef.current === 3) setError("Live analysis is recovering in the background. Camera preview and fast Scan now remain available.");
        }
      }
      const nextPerformance = monitor.snapshot();
      sampler.setFps(orchestratorRef.current?.snapshot().mode === "FIND" ? Math.min(2, nextPerformance.aiFps * 1.25) : nextPerformance.aiFps);
      setPerformance(nextPerformance);
    }, () => {
      performanceMonitor.frameDropped();
      setPerformance(performanceMonitor.snapshot());
    });
    sampler.setFps(snapshot.mode === "FIND" ? Math.min(2, performance.aiFps * 1.25) : performance.aiFps);
    sampler.start();
    samplerRef.current = sampler;
  }, [performance.aiFps, performanceMonitor, snapshot.mode]);

  useEffect(() => {
    const provider = providerRef.current;
    const audio = audioRef.current;
    const camera = cameraRef.current;
    let savedMemory: MemoryEvent[] = [];
    let savedDetailedScenes: CachedDetailedScene[] = [];
    try { savedMemory = JSON.parse(localStorage.getItem(memoryKey) ?? "[]") as MemoryEvent[]; } catch { savedMemory = []; }
    try { savedDetailedScenes = JSON.parse(localStorage.getItem(`${memoryKey}:detailed-scenes`) ?? "[]") as CachedDetailedScene[]; } catch { savedDetailedScenes = []; }
    provider.attachRemoteAudioElement(audio.getRemoteAudioElement());
    orchestratorRef.current = new AgentOrchestrator(speak, savedMemory, {
      requestDeepVision: () => scanActionRef.current(false),
      requestOcr: () => scanActionRef.current(true),
      vibrate: (input) => vibrate((typeof input === "object" && input && "pattern" in input ? String((input as { pattern: unknown }).pattern) : String(input)) as HapticPattern),
    }, savedDetailedScenes);
    setSnapshot(orchestratorRef.current.snapshot());
    const unsubscribeObservation = provider.onObservation(handleObservation);
    const unsubscribeConnection = provider.onConnectionState(setConnection);
    const unsubscribeTelemetry = provider.onTelemetry((telemetry) => {
      setRealtimeTelemetry(telemetry);
      if (telemetry.lastError?.startsWith("remote_audio_playback:")) {
        setError("Realtime audio could not autoplay. Browser speech fallback is active; tap Test Sound if you cannot hear it.");
      }
      if (telemetry.turn?.responseDoneAt && completedTurnRef.current !== telemetry.turn.turnId) {
        completedTurnRef.current = telemetry.turn.turnId;
        orchestratorRef.current?.completeUserTurn();
        samplerRef.current?.resume();
        const next = orchestratorRef.current?.snapshot();
        if (next) setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory] });
      }
    });
    const unsubscribeTool = provider.onToolCall((name, input, callId) => {
      void orchestratorRef.current?.tools.dispatch(name, input)
        .then((result) => provider.sendToolResult(callId, { ok: true, result }))
        .catch(() => {
          try { provider.sendToolResult(callId, { ok: false, error: `${name} could not be completed` }); } catch { /* The connection failure is already surfaced below. */ }
          setError(`The ${name} action could not be completed.`);
        });
    });
    return () => {
      cameraSessionRef.current += 1;
      unsubscribeObservation();
      unsubscribeConnection();
      unsubscribeTelemetry();
      unsubscribeTool();
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      samplerRef.current?.stop();
      scanAbortRef.current?.abort();
      refinementAbortRef.current?.abort();
      void audio.close();
      camera.stop();
      void provider.disconnect();
    };
  }, [handleObservation, speak, memoryKey]);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  const finishUserTurn = useCallback((turnSequence: number) => {
    if (turnSequence !== userTurnSequenceRef.current) return;
    orchestratorRef.current?.completeUserTurn();
    samplerRef.current?.resume();
  }, []);

  const processCommand = useCallback(async (command: string, fromRealtime = false, timing?: TranscriptTiming) => {
    const text = command.trim();
    if (!text || !orchestratorRef.current) return;
    addMessage("user", text);
    setError("");
    const agent = orchestratorRef.current;
    const intent = parseUserIntent(text);
    const turnSequence = ++userTurnSequenceRef.current;
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const usesSpecialist = intent.kind === "EPHEMERAL_VISUAL_QA"
      || (intent.kind === "PERSISTENT_GOAL" && ["find", "read", "remember"].includes(intent.goalType));
    const answersFromMemory = intent.kind === "PERSISTENT_GOAL" && intent.goalType === "review";
    if (!usesSpecialist) {
      scanAbortRef.current?.abort("superseded_by_user_turn");
      refinementAbortRef.current?.abort("superseded_by_user_turn");
      providerRef.current.setResponseSuppressed(answersFromMemory && fromRealtime);
    } else if (fromRealtime) {
      providerRef.current.setResponseSuppressed(true);
    }
    agent.beginUserTurn();
    samplerRef.current?.pause();

    if (intent.kind === "EPHEMERAL_VISUAL_QA") {
      const prior = agent.snapshot().observation;
      const local = agent.answerFromEvidence(text);
      if (local) speak(local);
      try {
        if (!cameraRef.current.active) {
          if (!local) speak("Start SightLoop first so I can inspect the current view.");
        } else {
          const observation = await scanNow(false, text, true);
          if (turnSequence === userTurnSequenceRef.current) {
            if (observation && (!local || scanAddsNewObjects(prior, observation))) speak(detailedObservationSpeech(observation));
            else if (!observation && !local) {
              const cached = agent.snapshot().detailedScenes.at(-1);
              speak(cached ? cachedDetailedSpeech(cached) : "I couldn’t complete a fresh scan of the current view. Keep the camera open, hold it steady, and try again.");
            }
          }
        }
      } finally {
        if (fromRealtime && turnSequence === userTurnSequenceRef.current) providerRef.current.setResponseSuppressed(false);
      }
      finishUserTurn(turnSequence);
    } else if (intent.kind === "PERSISTENT_GOAL") {
      const goal = agent.setGoal(text);
      if (goal.type === "review") {
        if (fromRealtime && turnSequence === userTurnSequenceRef.current) providerRef.current.setResponseSuppressed(false);
        finishUserTurn(turnSequence);
      } else if (goal.type === "read") {
        try {
          if (cameraRef.current.active) {
            const observation = await scanNow(true, text, true);
            if (turnSequence === userTurnSequenceRef.current) {
              if (!observation) speak("I couldn’t capture a fresh view of the text. Hold the camera steady and try again.");
              else if (observation.freshness === "STALE") speak("The reading arrived too late to describe the current view. Hold the camera steady and scan again.");
            }
          } else {
            speak("Start SightLoop first so I can read the current view.");
          }
        } finally {
          if (fromRealtime && turnSequence === userTurnSequenceRef.current) providerRef.current.setResponseSuppressed(false);
        }
        finishUserTurn(turnSequence);
      } else if (goal.type === "find" || goal.type === "remember") {
        try {
          if (!cameraRef.current.active) {
            speak("Start SightLoop first so I can inspect that object.");
          } else {
            const observation = await scanNow(false, text, true);
            if (turnSequence === userTurnSequenceRef.current) {
              if (!observation) speak("I couldn’t complete a fresh object scan. Keep the camera steady and try again.");
              else if (goal.type === "find" && !observation.goalAssessment?.shouldSpeak) speak(`I haven’t confidently identified ${goal.target} yet. Move the camera slowly while I keep looking.`);
              else if (goal.type === "remember" && agent.snapshot().goal?.type === "remember") speak(`I couldn’t confidently identify ${goal.target}, so I haven’t saved an unreliable location.`);
            }
          }
        } finally {
          if (fromRealtime && turnSequence === userTurnSequenceRef.current) providerRef.current.setResponseSuppressed(false);
        }
        finishUserTurn(turnSequence);
      } else if (!fromRealtime) {
        try {
          await providerRef.current.sendText(text, { timing, context: agent.snapshot().observation?.sceneSummary });
        } catch {
          setError("Your request was not delivered to the realtime service. The visual goal remains active, and you can retry.");
          speak("I couldn’t send that request to the realtime service. The visual goal is still active.");
          finishUserTurn(turnSequence);
        }
      } else {
        watchdogRef.current = setTimeout(async () => {
          if (turnSequence !== userTurnSequenceRef.current) return;
          const turn = providerRef.current.currentTelemetry.turn;
          const elapsed = Date.now() - (timing?.transcriptAt ?? Date.now());
          if (!shouldFallbackUnansweredTurn(turn, elapsed)) return;
          const local = agent.answerFromEvidence(text);
          if (local) speak(local);
          else {
            providerRef.current.setResponseSuppressed(true);
            providerRef.current.cancelResponse();
            try {
              await providerRef.current.sendText(text, { timing, context: agent.snapshot().observation?.sceneSummary, forceFallback: true });
            } catch {
              setError("Your request was not delivered to the realtime service. The visual goal remains active, and you can retry.");
              speak("I couldn’t send that request to the realtime service. The visual goal is still active.");
            } finally {
              providerRef.current.setResponseSuppressed(false);
            }
          }
          finishUserTurn(turnSequence);
        }, ASR_WATCHDOG_MS);
      }
    } else if (!fromRealtime) {
      try {
        await providerRef.current.sendText(text, { timing, context: agent.snapshot().observation?.sceneSummary });
      } catch {
        setError("Your question was not delivered. Check the connection and try again.");
        speak("I couldn’t send that question. Please check the connection and try again.");
        finishUserTurn(turnSequence);
      }
    } else {
      watchdogRef.current = setTimeout(async () => {
        if (turnSequence !== userTurnSequenceRef.current) return;
        const turn = providerRef.current.currentTelemetry.turn;
        const elapsed = Date.now() - (timing?.transcriptAt ?? Date.now());
        if (!shouldFallbackUnansweredTurn(turn, elapsed)) return;
        const local = agent.answerFromEvidence(text);
        if (local) speak(local);
        else {
          providerRef.current.setResponseSuppressed(true);
          providerRef.current.cancelResponse();
          try {
            await providerRef.current.sendText(text, { timing, context: agent.snapshot().observation?.sceneSummary, forceFallback: true });
          } catch {
            setError("Your question was not delivered. Check the connection and try again.");
            speak("I couldn’t send that question. Please check the connection and try again.");
          } finally {
            providerRef.current.setResponseSuppressed(false);
          }
        }
        finishUserTurn(turnSequence);
      }, ASR_WATCHDOG_MS);
    }

    const next = agent.snapshot();
    setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory] });
  // scanNow is intentionally resolved at interaction time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMessage, finishUserTurn, speak]);

  useEffect(() => providerRef.current.onTranscript((event) => {
    if (event.role === "agent") {
      addMessage("agent", event.text);
      const telemetry = providerRef.current.currentTelemetry;
      if (event.fallback || shouldUseSpeechSynthesis(telemetry.nativeAudioTrackReceived, telemetry.nativeAudioPlaying)) {
        const started = announce(event.text, {
          onStart: (at) => providerRef.current.markBrowserAudioStarted(at),
          onEnd: (at) => providerRef.current.markBrowserAudioDone(at),
          onError: (message) => {
            if (!/interrupted|canceled/i.test(message)) setError("The response is visible, but audio playback failed. Tap Test Sound and check the iPhone audio route.");
          },
        });
        if (!started) setError("The response is visible as text, but speech audio is unavailable.");
      }
    } else {
      void processCommand(event.text, true, event.timing ? { speechEndAt: event.timing.speechEndAt ?? Date.now(), transcriptAt: event.timing.transcriptAt ?? Date.now() } : undefined);
    }
  }), [addMessage, processCommand]);

  const startListening = useCallback(() => {
    if (!audioRef.current.supported) {
      setError("Continuous speech recognition is not available in this browser. You can still type a request.");
      return;
    }
    audioRef.current.start((text, timing) => { void processCommand(text, false, timing); }, (message) => {
      if (message !== "no-speech") setError(`Microphone recognition paused: ${message}.`);
    });
    setListening(true);
  }, [processCommand]);

  useEffect(() => {
    if (cameraState !== "live") return;
    if (connection === "WEBRTC_CONNECTED") {
      audioRef.current.stop();
    } else if (connection === "FALLBACK" || connection === "DEGRADED") {
      startListening();
    }
  }, [cameraState, connection, startListening]);

  async function startCamera() {
    if (!videoRef.current) return;
    const cameraSession = ++cameraSessionRef.current;
    setCameraState("starting");
    setError("");
    try {
      providerRef.current.attachRemoteAudioElement(audioRef.current.getRemoteAudioElement());
      const soundPromise = audioRef.current.unlock();
      const mediaPromise = cameraRef.current.start(videoRef.current, performance.previewHeight);
      const [sound, media] = await Promise.all([soundPromise, mediaPromise]);
      setSoundEnabled(sound.speechSynthesisReady || sound.mediaElementReady);
      if (sound.errors.length && !sound.speechSynthesisReady) {
        setError("Camera started, but sound could not be confirmed. Tap Test Sound, check Silent Mode, and confirm the iPhone audio route.");
      }
      setCameraState("live");
      providerRef.current.attachMedia(media, videoRef.current);
      const videoTrack = media.getVideoTracks()[0];
      videoTrack?.addEventListener("ended", () => {
        if (cameraSession !== cameraSessionRef.current) return;
        samplerRef.current?.stop();
        samplerRef.current = null;
        setCameraState("error");
        setError("The camera stream ended. Tap Try SightLoop again to reconnect it.");
        void providerRef.current.disconnect();
      }, { once: true });
      await providerRef.current.connect();
      createSampler();
      addMessage("system", "Camera and microphone are ready. Raw video is not stored.");
      if (providerRef.current.currentTelemetry.transport === "WEBRTC_CONNECTED") setListening(true);
      else startListening();
    } catch (cause) {
      setCameraState("error");
      const name = cause instanceof DOMException ? cause.name : "CameraError";
      setError(name === "NotAllowedError" ? "Camera or microphone access was blocked. Allow both permissions in your browser settings, then try again." : "SightLoop couldn’t start the camera. Check that no other app is using it, then try again.");
    }
  }

  async function scanNow(forceOcr = false, requestedGoal?: string, supersede = false): Promise<VisionObservation | undefined> {
    if (scanPromiseRef.current) {
      if (!supersede) return scanPromiseRef.current;
      const previous = scanPromiseRef.current;
      scanAbortRef.current?.abort("superseded_by_new_scan");
      await previous;
    }
    if (refinementPromiseRef.current) {
      refinementAbortRef.current?.abort("superseded_by_new_scan");
      refinementPromiseRef.current = null;
    }
    if (!videoRef.current || !cameraRef.current.active) return undefined;
    const resumeAutomatic = Boolean(samplerRef.current && !lowBandwidthRef.current);
    const task = (async () => {
      samplerRef.current?.stop();
      samplerRef.current = null;
      providerRef.current.cancelPendingVision();
      scanAbortRef.current?.abort();
      const controller = new AbortController();
      scanAbortRef.current = controller;
      setScanning(true);
      setError("");
      const startedAt = Date.now();
      performanceMonitor.requestStarted();
      try {
        const frame = await captureHighResolution(videoRef.current!);
        const current = orchestratorRef.current?.snapshot();
        const useOcr = forceOcr || current?.goal?.type === "read";
        const goal = requestedGoal ?? (current ? goalLabel(current) : undefined);
        let observation: VisionObservation;
        let usedMaxFallback = false;
        if (useOcr) {
          observation = await ocrRef.current.read(frame, controller.signal);
        } else {
          const result = await runFastWithMaxFallback(
            () => deepVisionRef.current.analyzeFast(frame, goal, controller.signal),
            () => deepVisionRef.current.analyzeMax(frame, goal, controller.signal),
          );
          observation = result.value;
          usedMaxFallback = result.usedMaxFallback;
          if (usedMaxFallback) {
            orchestratorRef.current?.tools.log("system", "Fast scan fallback used", "Max completed the scan");
          }
        }
        if (controller.signal.aborted) throw new DOMException("Scan superseded", "AbortError");
        if (!useOcr) cacheDetailedObservation(observation);
        performanceMonitor.requestFinished(Date.now() - startedAt);
        orchestratorRef.current?.tools.log("system", "Scan completed", `${frame.frameId} · ${observation.model ?? (useOcr ? "ocr" : "vision")} · ${Date.now() - startedAt} ms · captured ${Date.now() - frame.capturedAt} ms ago`);
        handleObservation(observation);
        if (!useOcr && !usedMaxFallback) startMaxRefinement(frame, goal, resumeAutomatic);
        return observation;
      } catch (cause) {
        const aborted = controller.signal.aborted || (cause as Error).name === "AbortError";
        performanceMonitor.requestFinished(Date.now() - startedAt, !aborted);
        if (!aborted) {
          orchestratorRef.current?.tools.log("error", "Scan unavailable", `${cause instanceof VisionClientError ? cause.code : "capture_or_scan_failed"} · ${Date.now() - startedAt} ms`);
          setError(visionFailureMessage(cause));
        }
        return undefined;
      } finally {
        setScanning(false);
        setPerformance(performanceMonitor.snapshot());
        const next = orchestratorRef.current?.snapshot();
        if (next) setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory], detailedScenes: [...next.detailedScenes] });
      }
    })();
    scanPromiseRef.current = task;
    return task.finally(() => {
      if (scanPromiseRef.current !== task) return;
      scanPromiseRef.current = null;
      if (resumeAutomatic && !lowBandwidthRef.current) createSampler();
    });
  }

  function cacheDetailedObservation(observation: VisionObservation) {
    const agent = orchestratorRef.current;
    if (!agent) return;
    agent.cacheDetailedObservation(observation);
    const next = agent.snapshot();
    setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory], detailedScenes: [...next.detailedScenes] });
    persistAgentSnapshot(next);
  }

  function startMaxRefinement(frame: Awaited<ReturnType<typeof captureHighResolution>>, goal: string | undefined, resumeAutomatic: boolean) {
    refinementAbortRef.current?.abort("superseded_by_new_refinement");
    const controller = new AbortController();
    refinementAbortRef.current = controller;
    const startedAt = Date.now();
    const task = (async () => {
      try {
        const observation = await deepVisionRef.current.analyzeMax(frame, goal, controller.signal);
        if (controller.signal.aborted) return;
        cacheDetailedObservation(observation);
        orchestratorRef.current?.tools.log("system", "Max refinement complete", `${observation.model ?? "max vision"} · ${Date.now() - startedAt} ms`);
      } catch (cause) {
        const aborted = controller.signal.aborted || (cause as Error).name === "AbortError";
        if (!aborted) orchestratorRef.current?.tools.log("error", "Max refinement unavailable", cause instanceof Error ? cause.message.slice(0, 120) : "unknown_error");
      }
    })();
    refinementPromiseRef.current = task;
    void task.finally(() => {
      if (refinementPromiseRef.current !== task) return;
      refinementPromiseRef.current = null;
      refinementAbortRef.current = null;
      const next = orchestratorRef.current?.snapshot();
      if (next) setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory], detailedScenes: [...next.detailedScenes] });
      if (resumeAutomatic && !lowBandwidthRef.current && cameraRef.current.active) createSampler();
    });
  }

  useEffect(() => {
    scanActionRef.current = scanNow;
  });

  async function testSound() {
    providerRef.current.attachRemoteAudioElement(audioRef.current.getRemoteAudioElement());
    const result = await audioRef.current.unlock();
    const enabled = result.speechSynthesisReady || result.mediaElementReady;
    setSoundEnabled(enabled);
    setError(enabled ? "" : "Sound could not be enabled. Turn off Silent Mode, raise media volume, and check the iPhone audio route.");
  }

  function toggleBandwidth(checked: boolean) {
    setLowBandwidth(checked);
    lowBandwidthRef.current = checked;
    if (checked) {
      samplerRef.current?.stop();
      samplerRef.current = null;
      qualityController.force("SAFE");
      setPerformance(performanceMonitor.snapshot());
      addMessage("system", "Low bandwidth mode is on. Automatic frame analysis is paused.");
    } else if (cameraState === "live") {
      qualityController.force("BALANCED");
      setPerformance(performanceMonitor.snapshot());
      createSampler();
      addMessage("system", "Automatic frame analysis resumed.");
    }
  }

  function clearGoal() {
    orchestratorRef.current?.clearGoal();
    const next = orchestratorRef.current?.snapshot();
    if (next) setSnapshot({ ...next, timeline: [...next.timeline], memory: [...next.memory] });
    addMessage("system", "Goal cleared.");
  }

  function submitGoal(event: FormEvent) {
    event.preventDefault();
    const text = draft;
    setDraft("");
    void processCommand(text);
  }

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool({
        name: "set_visual_goal",
        title: "Set SightLoop goal",
        description: "Set the visible SightLoop agent goal, such as finding an object, reading text, or remembering an item.",
        inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 300 } }, required: ["command"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          const command = (input as { command?: unknown }).command;
          if (typeof command !== "string" || !command.trim() || command.length > 300) throw new Error("A command from 1 to 300 characters is required.");
          await processCommand(command);
          return { status: "set", command };
        },
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: "scan_current_view",
        title: "Scan current view",
        description: "Capture one current camera frame and run the same visible Scan now action.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async () => {
          if (!cameraRef.current.active) throw new Error("Start the camera before scanning the current view.");
          await scanNow();
          return { status: "scan_finished" };
        },
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: "clear_visual_goal",
        title: "Clear SightLoop goal",
        description: "Stop the current continuous visual goal and return SightLoop to listening mode.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: () => { clearGoal(); return { status: "cleared" }; },
      }, { signal: lifecycle.signal });
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processCommand]);

  const guidance = snapshot.observation?.goalAssessment?.guidance;
  const speechStatus = listening ? "Listening" : "Tap to speak";
  const latestObjects = snapshot.observation?.objects.filter((object) => object.bbox) ?? [];
  const turn = realtimeTelemetry.turn;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[1180px] px-3 py-3 sm:px-6 sm:py-5">
      <header className="mb-3 flex items-center justify-between px-1" aria-label="SightLoop status">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-primary text-primary-foreground" aria-hidden="true"><Eye className="size-6" strokeWidth={2.4} /></span>
          <div><p className="text-xl font-bold tracking-[-0.035em]">SightLoop</p><p className="text-sm text-muted-foreground">Visual assistance</p></div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="h-10 gap-2 rounded-full border-border bg-card px-3 text-sm font-semibold">
            <span className={`size-2.5 rounded-full ${connection === "WEBRTC_CONNECTED" ? "bg-emerald-500" : connection === "FALLBACK" || connection === "DEGRADED" ? "bg-amber-500" : "bg-zinc-400"}`} aria-hidden="true" />
            {connection === "WEBRTC_CONNECTED" ? "REALTIME" : connection === "FALLBACK" ? "FALLBACK" : connection === "DEGRADED" ? "DEGRADED" : cameraState === "live" ? "CONNECTING" : "READY"}
          </Badge>
          {user && (
            <>
              <span className="hidden text-sm font-semibold text-muted-foreground sm:inline">{user.displayName}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { void signOut(); }}
                aria-label={`Sign out ${user.displayName}`}
                className="size-10 rounded-2xl"
              >
                <LogOut className="size-5" />
              </Button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-3 flex items-start gap-3 rounded-2xl border border-amber-400/45 bg-amber-100 px-4 py-3 text-[#3d3210] dark:bg-amber-950 dark:text-amber-100" role="alert">
          <WifiOff className="mt-0.5 size-5 shrink-0" /><p className="flex-1 text-sm leading-5">{error}</p>
          <button onClick={() => setError("")} className="rounded-lg p-1" aria-label="Dismiss message"><X className="size-5" /></button>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(340px,.78fr)]">
        <section
          className={`relative overflow-hidden rounded-[1.75rem] bg-[#080b09] text-white shadow-[0_24px_70px_rgba(5,15,10,.22)] ${
            cameraState === "live" ? "max-h-[calc(100dvh-7rem)] min-h-[48vh] lg:min-h-[560px]" : ""
          }`}
          aria-label="Live camera"
        >
          <video ref={videoRef} autoPlay muted playsInline className={`absolute inset-0 h-full w-full object-cover transition-opacity ${cameraState === "live" ? "opacity-100" : "opacity-0"}`} />

          {cameraState !== "live" && (
            <div className="relative grid min-h-[52vh] place-items-center px-6 pb-9 pt-20 text-center">
              <div className="max-w-sm">
                <span className="mx-auto mb-6 grid size-24 place-items-center rounded-full border border-white/20 bg-white/5"><Camera className="size-10 text-[#f4d448]" /></span>
                <h1 className="text-balance text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Let SightLoop see with you</h1>
                <p className="mx-auto mt-3 max-w-xs text-base leading-6 text-white/66">Your preview stays smooth on this device. Only selected frames are sent for assistance.</p>
                <Button onClick={startCamera} disabled={cameraState === "starting"} className="mt-7 min-h-14 rounded-2xl bg-[#f4d448] px-7 text-base font-bold text-[#111412] hover:bg-[#ffe260]">
                  <Camera className="size-5" /> {cameraState === "starting" ? "Starting…" : cameraState === "error" ? "Try SightLoop again" : "Start SightLoop"}
                </Button>
              </div>
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4">
            <span className="rounded-full bg-black/72 px-3 py-2 text-sm font-semibold">{cameraState === "live" ? "LIVE CAMERA" : "CAMERA OFF"}</span>
            <span className="rounded-full bg-black/72 px-3 py-2 text-sm text-white/85">AI {lowBandwidth ? "manual" : `${performance.aiFps.toFixed(1)} fps`}</span>
          </div>

          {latestObjects.map((object) => object.bbox && (
            <div key={object.id ?? `${object.label}-${object.bbox.x1}`} className="pointer-events-none absolute border-2 border-[#f4d448]" style={{ left: `${object.bbox.x1 * 100}%`, top: `${object.bbox.y1 * 100}%`, width: `${(object.bbox.x2 - object.bbox.x1) * 100}%`, height: `${(object.bbox.y2 - object.bbox.y1) * 100}%` }}>
              <span className="absolute -top-8 left-0 whitespace-nowrap rounded-lg bg-[#f4d448] px-2 py-1 text-xs font-bold text-black">{object.label} · {Math.round(object.confidence * 100)}%</span>
            </div>
          ))}

          {snapshot.goal && cameraState === "live" && (
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/15 bg-black/78 p-4 shadow-xl">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold uppercase tracking-[0.14em] text-[#f4d448]">{snapshot.status.replace("_", " ")}</p>
                  <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{goalLabel(snapshot)}</p>
                </div>
                {guidance && guidance !== "NONE" && <span className="shrink-0 rounded-xl border border-white/15 px-3 py-2 text-lg font-black">{guidance === "LEFT" ? "← LEFT" : guidance === "RIGHT" ? "RIGHT →" : guidance}</span>}
              </div>
              <p className="mt-2 text-base text-white/70">{snapshot.observation?.sceneSummary ?? "Hold steady while I check the view."}</p>
            </div>
          )}
        </section>

        <section className="flex min-h-[440px] flex-col rounded-[1.75rem] border border-border bg-card p-4 shadow-[0_20px_55px_rgba(15,25,20,.08)] sm:p-5" aria-label="Agent controls and transcript">
          <div className="flex items-start justify-between gap-3 border-b border-border pb-4">
            <div><p className="text-sm font-bold uppercase tracking-[0.12em] text-muted-foreground">{snapshot.mode}</p><h2 className="mt-1 text-xl font-semibold">{goalLabel(snapshot)}</h2></div>
            <Badge className="rounded-full px-3 py-1.5 text-sm">{snapshot.status.replace("_", " ")}</Badge>
          </div>

          <div ref={transcriptRef} className="max-h-[19rem] min-h-48 flex-1 space-y-4 overflow-y-auto py-5" aria-live="polite" aria-label="Conversation transcript">
            {messages.map((item) => (
              <div key={item.id} className={item.role === "user" ? "ml-10" : item.role === "system" ? "mx-4" : "mr-7"}>
                {item.role !== "system" && <p className="mb-1 text-sm font-semibold text-muted-foreground">{item.role === "agent" ? "SightLoop" : "You"}</p>}
                <p className={`rounded-2xl p-4 text-base leading-6 ${item.role === "agent" ? "bg-secondary" : item.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-background text-sm text-muted-foreground"}`}>{item.text}</p>
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Button onClick={() => { void scanNow().then((observation) => { if (observation) speak(detailedObservationSpeech(observation)); }); }} disabled={cameraState !== "live" || scanning} variant="outline" className="min-h-13 justify-start rounded-2xl px-4 text-base font-bold">
                {scanning ? <RotateCcw className="size-5 animate-spin" /> : <ScanLine className="size-5" />} {scanning ? "Scanning current view…" : "Scan now"}
              </Button>
              {snapshot.goal && <Button onClick={clearGoal} variant="ghost" size="icon" className="size-13 rounded-2xl" aria-label="Clear current goal"><CircleStop className="size-5" /></Button>}
            </div>

            <div className="flex min-h-12 items-center justify-between gap-4 rounded-2xl bg-background px-4 py-2.5">
              <label htmlFor="low-bandwidth" className="flex flex-1 cursor-pointer items-center gap-3 text-sm font-semibold"><Gauge className="size-5 text-muted-foreground" /> Low bandwidth mode</label>
              <Switch id="low-bandwidth" checked={lowBandwidth} onCheckedChange={toggleBandwidth} aria-label="Use low bandwidth mode" />
            </div>

            <Button type="button" onClick={() => { void testSound(); }} variant="outline" className="min-h-12 w-full justify-between rounded-2xl px-4 text-base font-bold">
              <span className="flex items-center gap-2"><Volume2 className="size-5" /> Test Sound</span>
              <span className="text-sm font-medium text-muted-foreground">{soundEnabled ? "Enabled" : "Tap to enable"}</span>
            </Button>

            <form onSubmit={submitGoal} className="safe-bottom">
              <label htmlFor="goal-input" className="sr-only">Tell SightLoop what you need</label>
              <div className="flex gap-2">
                <Button type="button" variant={listening ? "default" : "outline"} size="icon" className="size-14 shrink-0 rounded-2xl" onClick={() => {
                  if (listening) { audioRef.current.stop(); setListening(false); }
                  else startListening();
                }} aria-label={listening ? "Stop listening" : "Start listening"}>
                  {listening ? <Mic className="size-5" /> : <MicOff className="size-5" />}
                </Button>
                <Input id="goal-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Try “Find my red bottle”" className="h-14 min-w-0 rounded-2xl px-4 text-base" />
                <Button type="submit" size="icon" className="size-14 shrink-0 rounded-2xl" aria-label="Send request"><Send className="size-5" /></Button>
              </div>
              <p className="mt-2 text-center text-sm text-muted-foreground"><span className={`mr-2 inline-block size-2 rounded-full ${listening ? "bg-red-500" : "bg-zinc-400"}`} aria-hidden="true" />{speechStatus}</p>
            </form>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" className="min-h-12 w-full justify-between rounded-2xl px-4 text-base">
                  <span className="flex items-center gap-2"><ListTree className="size-5" /> Agent view</span><ChevronRight className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="mx-auto max-h-[82dvh] w-full max-w-3xl overflow-y-auto rounded-t-[1.75rem] border-x p-0">
                <SheetHeader className="border-b border-border p-5 pr-14 text-left">
                  <SheetTitle className="text-2xl tracking-tight">Agent view</SheetTitle>
                  <SheetDescription>What SightLoop observed, decided, remembered, and acted on.</SheetDescription>
                </SheetHeader>
                <div className="grid gap-4 p-5 sm:grid-cols-2">
                  <dl className="space-y-3 rounded-2xl border border-border bg-card p-4 text-sm">
                    <div><dt className="font-bold text-muted-foreground">GOAL</dt><dd className="mt-1 text-base">{goalLabel(snapshot)}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">OBSERVATION</dt><dd className="mt-1 text-base">{snapshot.observation?.sceneSummary ?? "No observation yet"}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">MEMORY</dt><dd className="mt-1 text-base">{snapshot.memory.at(-1) ? `${snapshot.memory.at(-1)?.subject} · ${snapshot.memory.at(-1)?.location}` : "No saved event"}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">DECISION</dt><dd className="mt-1 text-base">{snapshot.status.replace("_", " ")}{snapshot.confirmationCount ? ` · confirmation ${snapshot.confirmationCount}/2` : ""}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">REALTIME TRANSPORT</dt><dd className="mt-1 text-base">{realtimeTelemetry.transport}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">WEBRTC</dt><dd className="mt-1 text-base">peer {realtimeTelemetry.peerConnectionState} · ICE {realtimeTelemetry.iceConnectionState} · data {realtimeTelemetry.dataChannelState}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">REALTIME VIDEO</dt><dd className="mt-1 text-base">session {realtimeTelemetry.realtimeSessionState} · track {realtimeTelemetry.realtimeVideoTrackState} · {realtimeTelemetry.lastRealtimeVideoFrameAt ? `last frame ${timeLabel(realtimeTelemetry.lastRealtimeVideoFrameAt)}` : "no frame sent"}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">NATIVE AUDIO</dt><dd className="mt-1 text-base">track {realtimeTelemetry.nativeAudioTrackReceived ? "received" : "not received"} · playback {realtimeTelemetry.nativeAudioPlaying ? "active" : "fallback ready"}</dd></div>
                    {realtimeTelemetry.lastError && <div><dt className="font-bold text-muted-foreground">CONNECTION ERROR</dt><dd className="mt-1 break-words text-base">{realtimeTelemetry.lastError}</dd></div>}
                    <div><dt className="font-bold text-muted-foreground">ASR LATENCY</dt><dd className="mt-1 text-base">{latency(turn?.speechEndAt, turn?.transcriptAt)}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">MODEL TTFT</dt><dd className="mt-1 text-base">{latency(turn?.requestSentAt, turn?.firstModelEventAt)}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">FIRST AUDIO LATENCY</dt><dd className="mt-1 text-base">{latency(turn?.speechEndAt, turn?.firstAudioAt)}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">TOTAL TURN LATENCY</dt><dd className="mt-1 text-base">{latency(turn?.speechEndAt, turn?.responseDoneAt)}</dd></div>
                    <div><dt className="font-bold text-muted-foreground">VISION LATENCY</dt><dd className="mt-1 text-base">{performance.visionLatencyMs || "—"} ms · encode {Math.round(performance.encodeLatencyMs)} ms</dd></div>
                    <div><dt className="font-bold text-muted-foreground">PRESSURE</dt><dd className="mt-1 text-base">{performance.pendingCalls} active · {performance.droppedFrames} stale dropped · queue 0</dd></div>
                  </dl>
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <h3 className="flex items-center gap-2 font-bold"><Activity className="size-5" /> Timeline</h3>
                    <ol className="mt-4 space-y-4">
                      {[...snapshot.timeline].reverse().slice(0, 12).map((item) => (
                        <li key={item.id} className="grid grid-cols-[68px_1fr] gap-3 text-sm">
                          <time className="font-mono text-muted-foreground">{timeLabel(item.timestamp)}</time>
                          <div><p className="font-semibold">{item.label}</p>{item.detail && <p className="mt-0.5 leading-5 text-muted-foreground">{item.detail}</p>}</div>
                        </li>
                      ))}
                      {!snapshot.timeline.length && <li className="text-sm text-muted-foreground">Start the camera and set a goal to see the loop unfold.</li>}
                    </ol>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </section>
      </div>

      <footer className="mx-auto mt-3 flex max-w-3xl items-start gap-2 px-2 py-2 text-sm leading-5 text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>Experimental visual assistance. Do not rely on it as your sole mobility or safety aid. Raw camera video is not stored.</p>
      </footer>
      <span className="sr-only" aria-live="assertive">{messages.filter((item) => item.role === "agent").at(-1)?.text}</span>
    </main>
  );
}
