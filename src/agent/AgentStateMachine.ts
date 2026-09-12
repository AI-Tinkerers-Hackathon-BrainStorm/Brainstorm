import type { AgentMode, AgentStatus } from "../types/index.ts";

const validStatuses: Record<AgentMode, AgentStatus[]> = {
  IDLE: ["LISTENING", "DEGRADED", "ERROR"],
  EXPLORE: ["OBSERVING", "THINKING", "DEGRADED", "ERROR"],
  FIND: ["SEARCHING", "THINKING", "GUIDING", "VERIFYING", "TARGET_FOUND", "DEGRADED", "ERROR"],
  READ: ["READING", "THINKING", "DEGRADED", "ERROR"],
  REMEMBER: ["OBSERVING", "THINKING", "DEGRADED", "ERROR"],
  REVIEW: ["THINKING", "LISTENING", "DEGRADED", "ERROR"],
};

export class AgentStateMachine {
  private currentMode: AgentMode = "IDLE";
  private currentStatus: AgentStatus = "LISTENING";

  get mode() { return this.currentMode; }
  get status() { return this.currentStatus; }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
    const defaultStatus: Record<AgentMode, AgentStatus> = {
      IDLE: "LISTENING",
      EXPLORE: "OBSERVING",
      FIND: "SEARCHING",
      READ: "READING",
      REMEMBER: "OBSERVING",
      REVIEW: "THINKING",
    };
    this.currentStatus = defaultStatus[mode];
  }

  transition(status: AgentStatus): void {
    if (!validStatuses[this.currentMode].includes(status)) {
      throw new Error(`Invalid ${this.currentMode} transition to ${status}`);
    }
    this.currentStatus = status;
  }

  degrade(): void { this.currentStatus = "DEGRADED"; }
  fail(): void { this.currentStatus = "ERROR"; }
  reset(): void { this.setMode("IDLE"); }
}
