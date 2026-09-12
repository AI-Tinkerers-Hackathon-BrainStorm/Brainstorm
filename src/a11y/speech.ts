/**
 * One speech channel for the whole app.
 *
 * Both guided navigation and agent announcements route through here so they can
 * never talk over each other. Latest call wins, matching the previous behaviour
 * of `src/tools/announce.ts`.
 */

let rate = 1.05;

export function setSpeechRate(value: number): void {
  rate = Math.max(0.5, Math.min(2, value));
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(text: string): void {
  if (!speechSupported()) return;
  const value = text.trim();
  if (!value) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.rate = rate;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeech(): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
}
