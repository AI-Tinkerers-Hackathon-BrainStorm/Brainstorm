import type { DetectedObject, EpistemicState, MemoryEvent, VisionObservation } from "../types/index.ts";

function matches(subject: string, object: DetectedObject): boolean {
  const names = [object.label, ...(object.aliases ?? [])].map((name) => name.toLowerCase());
  const query = subject.toLowerCase();
  return names.some((name) => query.includes(name) || name.includes(query));
}

export class EpisodicMemory {
  private events: MemoryEvent[];

  constructor(events: MemoryEvent[] = [], private readonly maxItems = 100) {
    this.events = events.slice(-maxItems);
  }

  remember(event: MemoryEvent): void {
    const duplicate = this.events.findIndex(
      (item) => item.subject.toLowerCase() === event.subject.toLowerCase() && item.action === event.action && item.location === event.location,
    );
    if (duplicate >= 0) this.events.splice(duplicate, 1);
    this.events.push({ ...event, epistemic: event.epistemic === "UNKNOWN" ? "INFERRED" : event.epistemic });
    this.events = this.events.slice(-this.maxItems);
  }

  recall(subject: string, current?: VisionObservation): { state: EpistemicState; event?: MemoryEvent; object?: DetectedObject } {
    const visible = current?.objects.find((object) => matches(subject, object));
    if (visible && visible.confidence >= 0.65) return { state: "CURRENTLY_VISIBLE", object: visible };
    const event = [...this.events].reverse().find((item) => item.subject.toLowerCase().includes(subject.toLowerCase()) || subject.toLowerCase().includes(item.subject.toLowerCase()));
    return event ? { state: event.epistemic, event } : { state: "UNKNOWN" };
  }

  formatRecall(subject: string, current?: VisionObservation): string {
    const result = this.recall(subject, current);
    if (result.state === "CURRENTLY_VISIBLE") return `I can see ${subject} in the current view.`;
    if (result.state === "LAST_SEEN" && result.event) {
      return `I last saw what appeared to be ${subject}${result.event.location ? ` ${result.event.location}` : ""}. I can’t confirm it’s still there.`;
    }
    if (result.state === "INFERRED" && result.event) {
      return `It looks like ${subject} may have been ${result.event.action.toLowerCase()}${result.event.location ? ` ${result.event.location}` : ""}. I can’t confirm that now.`;
    }
    return `I can’t confirm where ${subject} is now.`;
  }

  all(): readonly MemoryEvent[] { return this.events; }
}
