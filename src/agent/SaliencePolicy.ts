import type { AgentGoal, TemporalEvent, VisionObservation } from "../types/index.ts";

export type SalienceDecision = "ANNOUNCE" | "SILENT_UPDATE" | "IGNORE";

export class SaliencePolicy {
  decide(observation: VisionObservation, goal?: AgentGoal, events: TemporalEvent[] = []): SalienceDecision {
    void events; // Temporal events remain visible in the debug timeline; the stable build does not speak bbox-growth alerts.
    if (goal?.type === "find" && observation.goalAssessment?.relevant) return observation.goalAssessment.shouldSpeak ? "ANNOUNCE" : "SILENT_UPDATE";
    if (goal?.type === "read" && observation.text.length) return "ANNOUNCE";
    if (goal?.type === "remember") return "SILENT_UPDATE";
    return "IGNORE";
  }
}
