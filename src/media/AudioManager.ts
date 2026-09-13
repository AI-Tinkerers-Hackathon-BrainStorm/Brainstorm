export type TranscriptTiming = { speechEndAt: number; transcriptAt: number };

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
};

type AudioContextConstructor = new () => AudioContext;
type TranscriptionCallbacks = {
  onTranscript: (text: string, timing: TranscriptTiming) => void;
  onError: (message: string) => void;
};

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const CHUNK_MS = 3_000;
const SPEECH_THRESHOLD = 0.018;

export function normalizeTranscript(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

// Kept as a pure compatibility helper for transcript-event tests. The runtime
// now captures PCM and sends it to the same-origin Whisper route instead.
export function newFinalTranscripts(event: SpeechRecognitionEventLike): string[] {
  const transcripts: string[] = [];
  for (let index = Math.max(0, event.resultIndex); index < event.results.length; index += 1) {
    const text = event.results[index]?.[0]?.transcript?.trim();
    if (text) transcripts.push(text);
  }
  return transcripts;
}

export function hasAudibleSpeech(samples: Float32Array, threshold = SPEECH_THRESHOLD): boolean {
  if (!samples.length) return false;
  let amplitude = 0;
  for (const sample of samples) amplitude += Math.abs(sample);
  return amplitude / samples.length >= threshold;
}

export class TranscriptDeduper {
  private recent = new Map<string, number>();

  constructor(private readonly windowMs = 2_500) {}

  accept(text: string, now = Date.now()): boolean {
    const normalized = normalizeTranscript(text);
    if (!normalized) return false;
    for (const [value, timestamp] of this.recent) {
      if (now - timestamp > this.windowMs) this.recent.delete(value);
    }
    const previous = this.recent.get(normalized);
    this.recent.set(normalized, now);
    return previous === undefined || now - previous > this.windowMs;
  }
}

export interface AudioUnlockResult {
  audioContextReady: boolean;
  mediaElementReady: boolean;
  speechSynthesisReady: boolean;
  errors: string[];
}

export function shouldUseSpeechSynthesis(nativeAudioTrackReceived: boolean, nativeAudioPlaying: boolean): boolean {
  return !nativeAudioTrackReceived || !nativeAudioPlaying;
}

function concatSamples(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function pcmToWav(samples: Float32Array, sourceRate: number, targetRate = 16_000): Blob {
  const ratio = sourceRate / targetRate;
  const frames = Math.max(1, Math.floor(samples.length / ratio));
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + frames * 2, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const position = Math.min(samples.length - 1, Math.floor(frame * ratio));
    view.setInt16(44 + frame * 2, Math.max(-1, Math.min(1, samples[position])) * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export class AudioManager {
  private keepListening = false;
  private readonly deduper = new TranscriptDeduper();
  private audioContext?: AudioContext;
  private captureContext?: AudioContext;
  private inputStream?: MediaStream;
  private inputSource?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private silenceGain?: GainNode;
  private chunks: Float32Array[] = [];
  private speechDetected = false;
  private chunkTimer?: ReturnType<typeof setTimeout>;
  private transcriptionInFlight = false;
  private pendingClip?: { audio: Blob; speechEndAt: number; callbacks: TranscriptionCallbacks; generation: number };
  private generation = 0;
  private callbacks?: TranscriptionCallbacks;
  private remoteAudio?: HTMLAudioElement;
  private unlockUtterance?: SpeechSynthesisUtterance;

  get supported() {
    if (typeof window === "undefined") return false;
    const source = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
    return Boolean(source.AudioContext ?? source.webkitAudioContext);
  }

  attachInputStream(stream: MediaStream): void {
    if (this.inputStream === stream) return;
    this.stopCapture();
    this.inputStream = stream;
  }

  getRemoteAudioElement(): HTMLAudioElement | undefined {
    if (typeof document === "undefined") return undefined;
    if (!this.remoteAudio) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.hidden = true;
      document.body.appendChild(audio);
      this.remoteAudio = audio;
    }
    return this.remoteAudio;
  }

  async unlock(testText = "SightLoop audio enabled."): Promise<AudioUnlockResult> {
    const errors: string[] = [];
    let audioContextReady = false;
    let mediaElementReady = false;
    let speechSynthesisReady = false;
    if (typeof window === "undefined") return { audioContextReady, mediaElementReady, speechSynthesisReady, errors: ["browser_unavailable"] };

    let contextResume: Promise<void> | undefined;
    let mediaPlay: Promise<void> | undefined;
    let audio: HTMLAudioElement | undefined;
    try {
      const source = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
      const Context = source.AudioContext ?? source.webkitAudioContext;
      if (Context) {
        this.audioContext ??= new Context();
        contextResume = this.audioContext.resume();
        const oscillator = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain);
        gain.connect(this.audioContext.destination);
        oscillator.start();
        oscillator.stop(this.audioContext.currentTime + 0.01);
      }
      audio = this.getRemoteAudioElement();
      if (audio) {
        audio.srcObject = null;
        audio.src = SILENT_WAV;
        mediaPlay = audio.play();
      }
      if ("speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined") {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(testText);
        utterance.lang = /[\u3400-\u9fff]/u.test(testText) ? "zh-CN" : (navigator.language || "en-US");
        utterance.volume = 1;
        utterance.onend = () => { this.unlockUtterance = undefined; };
        utterance.onerror = () => { this.unlockUtterance = undefined; };
        this.unlockUtterance = utterance;
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utterance);
        speechSynthesisReady = true;
      }
    } catch (error) {
      errors.push(`audio_unlock_start:${error instanceof Error ? error.name : "failed"}`);
    }
    if (contextResume) {
      try {
        await contextResume;
        audioContextReady = this.audioContext?.state === "running";
      } catch (error) { errors.push(`audio_context:${error instanceof Error ? error.name : "failed"}`); }
    }
    if (mediaPlay && audio) {
      try {
        await mediaPlay;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        mediaElementReady = true;
      } catch (error) { errors.push(`media_element:${error instanceof Error ? error.name : "failed"}`); }
    }
    return { audioContextReady, mediaElementReady, speechSynthesisReady, errors };
  }

  start(onTranscript: TranscriptionCallbacks["onTranscript"], onError: TranscriptionCallbacks["onError"]): void {
    if (!this.supported || this.keepListening) return;
    if (!this.inputStream?.getAudioTracks().some((track) => track.enabled && track.readyState === "live")) {
      onError("microphone_stream_unavailable");
      return;
    }
    this.keepListening = true;
    const callbacks = { onTranscript, onError };
    this.callbacks = callbacks;
    const generation = ++this.generation;
    void this.startCapture(callbacks, generation);
  }

  stop(): void {
    this.keepListening = false;
    this.finishChunk(this.callbacks);
    this.stopCapture();
    this.callbacks = undefined;
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.keepListening = false;
    this.callbacks = undefined;
    this.pendingClip = undefined;
    this.stopCapture();
    this.remoteAudio?.pause();
    this.remoteAudio?.remove();
    this.remoteAudio = undefined;
    this.unlockUtterance = undefined;
    await this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
  }

  private async startCapture(callbacks: TranscriptionCallbacks, generation: number): Promise<void> {
    if (!this.keepListening || generation !== this.generation || !this.inputStream) return;
    try {
      const source = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
      const Context = source.AudioContext ?? source.webkitAudioContext;
      if (!Context) throw new Error("audio_capture_unavailable");
      this.captureContext ??= new Context();
      await this.captureContext.resume();
      this.inputSource ??= this.captureContext.createMediaStreamSource(this.inputStream);
      this.processor ??= this.captureContext.createScriptProcessor(4096, 1, 1);
      this.silenceGain ??= this.captureContext.createGain();
      this.silenceGain.gain.value = 0;
      this.inputSource.connect(this.processor);
      this.processor.connect(this.silenceGain);
      this.silenceGain.connect(this.captureContext.destination);
      this.processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input);
        this.chunks.push(copy);
        if (hasAudibleSpeech(copy)) this.speechDetected = true;
      };
      this.beginChunk(callbacks, generation);
    } catch (error) {
      this.keepListening = false;
      callbacks.onError(error instanceof Error ? error.message : "whisper_capture_failed");
    }
  }

  private beginChunk(callbacks: TranscriptionCallbacks, generation: number): void {
    this.chunks = [];
    this.speechDetected = false;
    this.chunkTimer = setTimeout(() => {
      this.finishChunk(callbacks, generation);
      if (this.keepListening && generation === this.generation) this.beginChunk(callbacks, generation);
    }, CHUNK_MS);
  }

  private finishChunk(callbacks?: TranscriptionCallbacks, generation = this.generation): void {
    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = undefined;
    const samples = concatSamples(this.chunks);
    const capturedSpeech = this.speechDetected;
    this.chunks = [];
    this.speechDetected = false;
    if (!callbacks || !capturedSpeech || samples.length < 1_600 || !this.captureContext) return;
    this.enqueueTranscription(pcmToWav(samples, this.captureContext.sampleRate), Date.now(), callbacks, generation);
  }

  private enqueueTranscription(audio: Blob, speechEndAt: number, callbacks: TranscriptionCallbacks, generation: number): void {
    const clip = { audio, speechEndAt, callbacks, generation };
    if (this.transcriptionInFlight) {
      this.pendingClip = clip;
      return;
    }
    this.transcriptionInFlight = true;
    void this.transcribe(clip).finally(() => {
      this.transcriptionInFlight = false;
      const next = this.pendingClip;
      this.pendingClip = undefined;
      if (next && next.generation === this.generation) this.enqueueTranscription(next.audio, next.speechEndAt, next.callbacks, next.generation);
    });
  }

  private async transcribe(clip: { audio: Blob; speechEndAt: number; callbacks: TranscriptionCallbacks; generation: number }): Promise<void> {
    try {
      const form = new FormData();
      form.set("audio", clip.audio, "speech.wav");
      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      if (!response.ok) throw new Error(`whisper_${response.status}`);
      const payload = await response.json() as { text?: string };
      const transcriptAt = Date.now();
      const text = payload.text?.trim();
      if (text && clip.generation === this.generation && this.deduper.accept(text, transcriptAt)) {
        clip.callbacks.onTranscript(text, { speechEndAt: clip.speechEndAt, transcriptAt });
      }
    } catch (error) {
      if (clip.generation === this.generation) clip.callbacks.onError(error instanceof Error ? error.message : "whisper_transcription_failed");
    }
  }

  private stopCapture(): void {
    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = undefined;
    this.processor?.disconnect();
    this.inputSource?.disconnect();
    this.silenceGain?.disconnect();
    this.processor = undefined;
    this.inputSource = undefined;
    this.silenceGain = undefined;
    this.chunks = [];
    this.speechDetected = false;
    void this.captureContext?.close().catch(() => undefined);
    this.captureContext = undefined;
  }
}
