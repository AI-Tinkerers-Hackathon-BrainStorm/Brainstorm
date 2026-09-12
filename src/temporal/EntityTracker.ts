import type { DetectedObject, VisionObservation } from "../types/index.ts";

export interface Track {
  id: string;
  label: string;
  color?: string;
  lastSeenAt: number;
  lastFrameId: string;
  center?: { x: number; y: number };
  bbox?: DetectedObject["bbox"];
  confidence: number;
  missed: number;
}

function centerOf(object: DetectedObject) {
  if (object.center) return object.center;
  if (!object.bbox) return undefined;
  return { x: (object.bbox.x1 + object.bbox.x2) / 2, y: (object.bbox.y1 + object.bbox.y2) / 2 };
}

function distance(a?: { x: number; y: number }, b?: { x: number; y: number }) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class EntityTracker {
  private tracks: Track[] = [];
  private sequence = 0;

  update(observation: VisionObservation): Track[] {
    const touched = new Set<string>();
    for (const object of observation.objects) {
      const center = centerOf(object);
      const match = this.tracks
        .filter((track) => track.label.toLowerCase() === object.label.toLowerCase())
        .filter((track) => !track.color || !object.color || track.color.toLowerCase() === object.color.toLowerCase())
        .sort((a, b) => distance(a.center, center) - distance(b.center, center))[0];
      const track = match && distance(match.center, center) <= 0.28
        ? match
        : { id: `track-${++this.sequence}`, label: object.label, lastSeenAt: observation.capturedAt, lastFrameId: observation.frameId, confidence: object.confidence, missed: 0 };
      Object.assign(track, {
        color: object.color,
        center,
        bbox: object.bbox,
        lastSeenAt: observation.capturedAt,
        lastFrameId: observation.frameId,
        confidence: object.confidence,
        missed: 0,
      });
      if (!this.tracks.includes(track)) this.tracks.push(track);
      object.id = track.id;
      touched.add(track.id);
    }
    this.tracks.forEach((track) => { if (!touched.has(track.id)) track.missed += 1; });
    this.tracks = this.tracks.filter((track) => track.missed <= 2);
    return this.active();
  }

  active(): Track[] { return this.tracks.map((track) => ({ ...track })); }
}
