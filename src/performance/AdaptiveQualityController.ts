import type { PerformanceSnapshot, QualityTier } from "../types/index.ts";

export const QUALITY_PROFILES: Record<QualityTier, { previewHeight: number; aiFps: number; effects: boolean }> = {
  HIGH: { previewHeight: 720, aiFps: 1, effects: true },
  BALANCED: { previewHeight: 540, aiFps: 0.7, effects: true },
  SAFE: { previewHeight: 360, aiFps: 0.4, effects: false },
};

export class AdaptiveQualityController {
  private tier: QualityTier = "HIGH";
  private badSamples = 0;
  private goodSamples = 0;

  get quality() { return this.tier; }
  get profile() { return QUALITY_PROFILES[this.tier]; }

  record(latencyMs: number, failed = false, encodeMs = 0): QualityTier {
    const bad = failed || latencyMs > 3_500 || encodeMs > 120;
    if (bad) {
      this.badSamples += 1;
      this.goodSamples = 0;
    } else {
      this.goodSamples += 1;
      this.badSamples = 0;
    }
    if (this.badSamples >= 2) {
      this.tier = this.tier === "HIGH" ? "BALANCED" : "SAFE";
      this.badSamples = 0;
    } else if (this.goodSamples >= 6) {
      this.tier = this.tier === "SAFE" ? "BALANCED" : "HIGH";
      this.goodSamples = 0;
    }
    return this.tier;
  }

  force(tier: QualityTier): void { this.tier = tier; }

  snapshot(metrics: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
    return {
      quality: this.tier,
      aiFps: this.profile.aiFps,
      previewHeight: this.profile.previewHeight,
      visionLatencyMs: 0,
      encodeLatencyMs: 0,
      requestFailures: 0,
      pendingCalls: 0,
      droppedFrames: 0,
      ...metrics,
    };
  }
}
