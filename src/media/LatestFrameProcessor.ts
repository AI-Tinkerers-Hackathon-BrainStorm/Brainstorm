export class LatestFrameProcessor<T> {
  private running = false;
  private pending?: T;
  private stopped = false;

  constructor(
    private readonly process: (item: T) => Promise<void>,
    private readonly dispose: (item: T) => void = () => undefined,
    private readonly onDrop: () => void = () => undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  push(item: T): void {
    if (this.stopped) { this.dispose(item); return; }
    if (this.running) {
      if (this.pending) { this.dispose(this.pending); this.onDrop(); }
      this.pending = item;
      return;
    }
    void this.drain(item);
  }

  stop(): void {
    this.stopped = true;
    if (this.pending) this.dispose(this.pending);
    this.pending = undefined;
  }

  private async drain(item: T): Promise<void> {
    this.running = true;
    try { await this.process(item); } catch (error) { this.onError(error); } finally {
      const next = this.pending;
      this.pending = undefined;
      this.running = false;
      if (next && !this.stopped) void this.drain(next);
      else if (next) this.dispose(next);
    }
  }
}
