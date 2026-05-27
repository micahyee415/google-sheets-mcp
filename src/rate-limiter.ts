/**
 * Per-user in-memory rate limiter for HTTP (Cloud Run) mode.
 * Fixed-window counter: 60 requests per minute per user by default.
 * Per-instance — fine for a mid-size company on min-instances=1.
 * If you scale to multiple instances, move this to Firestore or Redis.
 */

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 60, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
    setInterval(() => {
      const now = Date.now();
      for (const [key, win] of this.windows) {
        if (now >= win.resetAt) this.windows.delete(key);
      }
    }, windowMs).unref();
  }

  check(key: string): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (existing.count >= this.max) return false;
    existing.count++;
    return true;
  }

  retryAfter(key: string): number {
    const existing = this.windows.get(key);
    if (!existing) return 0;
    return Math.ceil((existing.resetAt - Date.now()) / 1000);
  }
}
