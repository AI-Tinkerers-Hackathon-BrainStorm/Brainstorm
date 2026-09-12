import type { CachedDetailedScene, VisionObservation } from "../types/index.ts";

export class DetailedSceneMemory {
  private scenes: CachedDetailedScene[];

  constructor(scenes: CachedDetailedScene[] = [], private readonly maxItems = 6) {
    this.scenes = scenes
      .filter((scene) => scene?.epistemic === "LAST_SEEN" && Number.isFinite(scene.capturedAt) && typeof scene.sceneSummary === "string")
      .slice(-maxItems);
  }

  add(observation: VisionObservation): CachedDetailedScene {
    const scene: CachedDetailedScene = {
      id: `detailed-${observation.frameId}`,
      capturedAt: observation.capturedAt,
      receivedAt: observation.receivedAt,
      model: observation.model ?? "unknown",
      sceneSummary: observation.sceneSummary,
      objects: observation.objects.slice(0, 30).map((object) => ({
        label: object.label,
        color: object.color,
        confidence: object.confidence,
        spatialRelation: object.spatialRelation,
      })),
      text: observation.text.slice(0, 20).map((item) => item.text),
      epistemic: "LAST_SEEN",
    };
    this.scenes = [...this.scenes.filter((item) => item.id !== scene.id), scene].slice(-this.maxItems);
    return scene;
  }

  latest(): CachedDetailedScene | undefined { return this.scenes.at(-1); }
  all(): readonly CachedDetailedScene[] { return this.scenes; }
}
