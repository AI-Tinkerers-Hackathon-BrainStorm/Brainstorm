import type { TurnLatencyTelemetry } from "../types/index.ts";

export const ASR_WATCHDOG_MS = 2_500;
export const USER_TURN_TIMEOUT_MS = 10_000;

export function shouldFallbackUnansweredTurn(
  turn: Pick<TurnLatencyTelemetry, "firstModelEventAt" | "responseDoneAt"> | undefined,
  elapsedMs: number,
  budgetMs = ASR_WATCHDOG_MS,
): boolean {
  if (turn?.firstModelEventAt || turn?.responseDoneAt) return false;
  return elapsedMs >= budgetMs;
}
