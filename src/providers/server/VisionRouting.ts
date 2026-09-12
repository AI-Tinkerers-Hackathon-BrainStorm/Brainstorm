import { MODELS } from "../../config/models.ts";

export type VisionDetailTier = "fast" | "max";

export interface VisionRoutePlan {
  model: string;
  timeoutMs: number;
  maxTokens: number;
  maxPixels: number;
}

export function selectVisionRoute(purpose: "background" | "detailed", detailTier?: VisionDetailTier): VisionRoutePlan {
  if (purpose === "background") {
    return { model: MODELS.deepVision, timeoutMs: 8_000, maxTokens: 700, maxPixels: 786_432 };
  }
  if (detailTier === "max") {
    return { model: MODELS.deepVisionMax, timeoutMs: 32_000, maxTokens: 1_800, maxPixels: 2_621_440 };
  }
  return { model: MODELS.deepVision, timeoutMs: 13_000, maxTokens: 1_000, maxPixels: 1_572_864 };
}
