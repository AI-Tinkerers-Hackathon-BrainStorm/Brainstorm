import { speechSupported } from "../a11y/speech.ts";

let activeUtterance: SpeechSynthesisUtterance | undefined;
let pendingSpeech: ReturnType<typeof setTimeout> | undefined;

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
  if (pendingSpeech) clearTimeout(pendingSpeech);
  const synthesis = window.speechSynthesis;
  synthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.lang = /[\u3400-\u9fff]/u.test(text) ? "zh-CN" : (navigator.language || "en-US");
  utterance.onstart = () => callbacks.onStart?.(Date.now());
  utterance.onend = () => { if (activeUtterance === utterance) activeUtterance = undefined; callbacks.onEnd?.(Date.now()); };
  utterance.onerror = (event) => { if (activeUtterance === utterance) activeUtterance = undefined; callbacks.onError?.(event.error || "speech_synthesis_failed"); };
  activeUtterance = utterance; // Safari may stop speech if the utterance is garbage-collected.
  synthesis.resume();
  const start = () => { pendingSpeech = undefined; synthesis.resume(); synthesis.speak(utterance); };
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) pendingSpeech = setTimeout(start, 40);
  else start();
  return true;
}
