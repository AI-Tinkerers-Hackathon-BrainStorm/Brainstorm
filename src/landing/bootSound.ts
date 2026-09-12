import { announce } from "../tools/announce.ts";

/**
 * The boot chime, synthesised with Web Audio rather than shipped as an audio
 * file. No binary asset, nothing to download, and it cannot block first paint.
 *
 * Browsers refuse to start audio before a user gesture, so `playBootSound`
 * reports whether it actually managed to start. The caller arms a one-shot
 * listener when it did not.
 */

let context: AudioContext | undefined;

function getContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  context ??= new Ctor();
  return context;
}

/** A slow rise, a filtered sweep across it, then two confirmation bells. */
export function playBootSound(): boolean {
  const ctx = getContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume();
  if (ctx.state !== "running") return false;

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  // Layer 1 - the reactor spinning up.
  const rise = ctx.createOscillator();
  const riseGain = ctx.createGain();
  rise.type = "sine";
  rise.frequency.setValueAtTime(58, now);
  rise.frequency.exponentialRampToValueAtTime(190, now + 1.15);
  riseGain.gain.setValueAtTime(0.0001, now);
  riseGain.gain.exponentialRampToValueAtTime(0.32, now + 0.35);
  riseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
  rise.connect(riseGain).connect(master);
  rise.start(now);
  rise.stop(now + 1.55);

  // Layer 2 - air moving past it.
  const sweep = ctx.createOscillator();
  const sweepGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  sweep.type = "sawtooth";
  sweep.frequency.setValueAtTime(150, now);
  sweep.frequency.exponentialRampToValueAtTime(900, now + 1.1);
  filter.type = "lowpass";
  filter.Q.value = 9;
  filter.frequency.setValueAtTime(280, now);
  filter.frequency.exponentialRampToValueAtTime(4200, now + 1.1);
  sweepGain.gain.setValueAtTime(0.0001, now);
  sweepGain.gain.exponentialRampToValueAtTime(0.13, now + 0.5);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
  sweep.connect(filter).connect(sweepGain).connect(master);
  sweep.start(now);
  sweep.stop(now + 1.4);

  // Layer 3 - two bells, the system reporting for duty.
  for (const [index, frequency] of [880, 1318.5].entries()) {
    const at = now + 1.12 + index * 0.16;
    const bell = ctx.createOscillator();
    const bellGain = ctx.createGain();
    bell.type = "sine";
    bell.frequency.value = frequency;
    bellGain.gain.setValueAtTime(0.0001, at);
    bellGain.gain.exponentialRampToValueAtTime(0.2, at + 0.015);
    bellGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    bell.connect(bellGain).connect(master);
    bell.start(at);
    bell.stop(at + 0.6);
  }

  return true;
}

export function bootSoundSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
}

/** The line the landing speaks once the chime has finished. */
export const INTRO_LINE = "SightJarvis is back.";

/** Chime runs about 1.7s; the voice follows so the two never overlap. */
const LINE_DELAY_MS = 1500;

let lineTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The full entrance: chime, then the spoken line.
 *
 * The line goes through `announce` rather than its own utterance so it shares
 * the single speech channel with guided navigation and agent speech, and so it
 * inherits the iOS handling there. Returns false when audio could not start,
 * which is the caller's signal to wait for a user gesture.
 */
export function playIntro(): boolean {
  if (!playBootSound()) return false;
  cancelIntro();
  lineTimer = setTimeout(() => {
    lineTimer = undefined;
    announce(INTRO_LINE);
  }, LINE_DELAY_MS);
  return true;
}

export function cancelIntro(): void {
  if (lineTimer) clearTimeout(lineTimer);
  lineTimer = undefined;
}
