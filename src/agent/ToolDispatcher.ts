import type { TimelineEntry } from "../types/index.ts";

type ToolHandler = (input: unknown) => unknown | Promise<unknown>;

export class ToolDispatcher {
  private handlers = new Map<string, ToolHandler>();
  private entries: TimelineEntry[] = [];

  constructor(private readonly maxTimeline = 100) {}

  register(name: string, handler: ToolHandler): void { this.handlers.set(name, handler); }

  async dispatch(name: string, input: unknown): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const result = await handler(input);
    this.log("action", name, typeof input === "string" ? input : undefined);
    return result;
  }

  log(kind: TimelineEntry["kind"], label: string, detail?: string): void {
    const timestamp = Date.now();
    this.entries.push({ id: `${timestamp}-${this.entries.length}`, timestamp, kind, label, detail });
    this.entries = this.entries.slice(-this.maxTimeline);
  }

  timeline(): readonly TimelineEntry[] { return this.entries; }
}
