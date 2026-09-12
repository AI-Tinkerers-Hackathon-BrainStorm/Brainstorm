import { speechSupported } from "../a11y/speech.ts";

export interface AnnounceCallbacks {
  onStart?: (at: number) => void;
  onEnd?: (at: number) => void;
  onError?: (message: string) => void;
}

/**
 * Agent speech. Uses the same SpeechSynthesis channel as guided navigation so
 * the two can never talk over each other, while preserving iOS audio callbacks.
 */
export function announce(text: string, callbacks: AnnounceCallbacks = {}): boolean {
  if (!speechSupported() || typeof SpeechSynthesisUtterance === "undefined") {
    callbacks.onError?.("speech_synthesis_unavailable");
    return false;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 1;
  utterance.onstart = () => callbacks.onStart?.(Date.now());
  utterance.onend = () => callbacks.onEnd?.(Date.now());
  utterance.onerror = (event) => callbacks.onError?.(event.error || "speech_synthesis_failed");
  window.speechSynthesis.speak(utterance);
  return true;
}
