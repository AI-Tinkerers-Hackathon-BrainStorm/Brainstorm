import type { PerformanceSnapshot } from "../types/index.ts";
import { AdaptiveQualityController } from "./AdaptiveQualityController.ts";

export class PerformanceMonitor {
  private latency = 0;
  private encode = 0;
  private failures = 0;
  private pending = 0;
  private dropped = 0;

  constructor(private readonly controller: AdaptiveQualityController) {}
  requestStarted() { this.pending += 1; }
  requestFinished(latencyMs: number, failed = false) {
    this.pending = Math.max(0, this.pending - 1);
    this.latency = latencyMs;
    if (failed) this.failures += 1;
    this.controller.record(latencyMs, failed, this.encode);
  }
  encoded(ms: number) { this.encode = ms; }
  frameDropped() { this.dropped += 1; }
  snapshot(): PerformanceSnapshot {
    return this.controller.snapshot({
      visionLatencyMs: this.latency,
      encodeLatencyMs: this.encode,
      requestFailures: this.failures,
      pendingCalls: this.pending,
      droppedFrames: this.dropped,
    });
  }
}
