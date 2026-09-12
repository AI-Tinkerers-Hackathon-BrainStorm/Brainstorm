export type HapticPattern = "LEFT" | "RIGHT" | "FOUND" | "WARNING";

const patterns: Record<HapticPattern, number[]> = {
  LEFT: [55, 70, 55],
  RIGHT: [45, 55, 45, 55, 45],
  FOUND: [180, 80, 55, 80, 180],
  WARNING: [180, 100, 180],
};

export function vibrate(pattern: HapticPattern): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
    ? navigator.vibrate(patterns[pattern])
    : false;
}
