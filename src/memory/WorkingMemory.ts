import type { VisionObservation } from "../types/index.ts";

export class WorkingMemory {
  private observations: VisionObservation[] = [];

  constructor(private readonly maxItems = 20, private readonly windowMs = 20_000) {}

  add(observation: VisionObservation): void {
    const cutoff = observation.capturedAt - this.windowMs;
    this.observations = [...this.observations, observation]
      .filter((item) => item.capturedAt >= cutoff)
      .slice(-this.maxItems);
  }

  all(): readonly VisionObservation[] { return this.observations; }
  latest(): VisionObservation | undefined { return this.observations.at(-1); }
  clear(): void { this.observations = []; }
}
