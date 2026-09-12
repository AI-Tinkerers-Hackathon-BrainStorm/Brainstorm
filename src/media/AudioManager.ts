export type TranscriptTiming = { speechEndAt: number; transcriptAt: number };

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
};

type SpeechRecognitionErrorEventLike = { error: string };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
};
type RecognitionConstructor = new () => SpeechRecognitionLike;
type AudioContextConstructor = new () => AudioContext;

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export function normalizeTranscript(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function newFinalTranscripts(event: SpeechRecognitionEventLike): string[] {
  const transcripts: string[] = [];
  for (let index = Math.max(0, event.resultIndex); index < event.results.length; index += 1) {
    const text = event.results[index]?.[0]?.transcript?.trim();
    if (text) transcripts.push(text);
  }
  return transcripts;
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

export class AudioManager {
  private recognition?: SpeechRecognitionLike;
  private keepListening = false;
  private lastSpeechEndAt = 0;
  private readonly deduper = new TranscriptDeduper();
  private audioContext?: AudioContext;
  private remoteAudio?: HTMLAudioElement;

  get supported() {
    if (typeof window === "undefined") return false;
    return Boolean((window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition);
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
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(testText));
        speechSynthesisReady = true;
      }
    } catch (error) {
      errors.push(`audio_unlock_start:${error instanceof Error ? error.name : "failed"}`);
    }

    if (contextResume) {
      try {
        await contextResume;
        audioContextReady = this.audioContext?.state === "running";
      } catch (error) {
        errors.push(`audio_context:${error instanceof Error ? error.name : "failed"}`);
      }
    }
    if (mediaPlay && audio) {
      try {
        await mediaPlay;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        mediaElementReady = true;
      } catch (error) {
        errors.push(`media_element:${error instanceof Error ? error.name : "failed"}`);
      }
    }

    return { audioContextReady, mediaElementReady, speechSynthesisReady, errors };
  }

  start(onTranscript: (text: string, timing: TranscriptTiming) => void, onError: (message: string) => void): void {
    if (!this.supported || this.recognition) return;
    const source = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Recognition = source.SpeechRecognition ?? source.webkitSpeechRecognition!;
    this.recognition = new Recognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = navigator.language || "en-US";
    this.recognition.onspeechend = () => { this.lastSpeechEndAt = Date.now(); };
    this.recognition.onresult = (event) => {
      const transcriptAt = Date.now();
      const speechEndAt = this.lastSpeechEndAt || transcriptAt;
      for (const text of newFinalTranscripts(event)) {
        if (this.deduper.accept(text, transcriptAt)) onTranscript(text, { speechEndAt, transcriptAt });
      }
    };
    this.recognition.onerror = (event) => onError(event.error);
    this.recognition.onend = () => {
      const restart = this.keepListening;
      this.recognition = undefined;
      if (restart) this.start(onTranscript, onError);
    };
    this.keepListening = true;
    this.recognition.start();
  }

  stop(): void {
    this.keepListening = false;
    this.recognition?.stop();
    this.recognition = undefined;
  }

  async close(): Promise<void> {
    this.stop();
    this.remoteAudio?.pause();
    this.remoteAudio?.remove();
    this.remoteAudio = undefined;
    await this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
  }
}
