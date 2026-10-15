export class RateLimiter {
  private timestamps: number[] = [];
  private readonly max: number;
  private readonly intervalMs: number;

  constructor(opts: { maxRequestsPerInterval: number; intervalMs: number }) {
    this.max = opts.maxRequestsPerInterval;
    this.intervalMs = opts.intervalMs;
  }

  /** Resolve when the next request may be sent */
  async limit(): Promise<void> {
    const now = Date.now();
    // Remove timestamps older than the window
    while (this.timestamps.length && now - this.timestamps[0] > this.intervalMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.max) {
      const wait = this.intervalMs - (now - this.timestamps[0]) + 10;
      await new Promise((r) => setTimeout(r, wait));
    }
    this.timestamps.push(Date.now());
  }
}
