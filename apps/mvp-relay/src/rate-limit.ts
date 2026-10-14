/** Monotonic token refill, bounded burst. Works in Node and Durable Objects. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly capacity: number, private readonly periodMs: number, now: number) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  consume(cost: number, now: number): boolean {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.capacity / this.periodMs);
    this.updatedAt = Math.max(now, this.updatedAt);
    if (!Number.isFinite(cost) || cost < 0 || cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Bounded identity table prevents random-IP/route keys from growing memory forever. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; usedAt: number }>();
  constructor(private readonly capacity: number, private readonly periodMs: number, private readonly maxKeys = 10_000) {}

  consume(key: string, now: number, cost = 1): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      for (const [candidate, value] of this.buckets) {
        if (now - value.usedAt >= this.periodMs) this.buckets.delete(candidate);
      }
      // Reject an unseen identity if the table is full; do not evict active quota state.
      if (this.buckets.size >= this.maxKeys) return false;
      entry = { bucket: new TokenBucket(this.capacity, this.periodMs, now), usedAt: now };
      this.buckets.set(key, entry);
    }
    entry.usedAt = now;
    return entry.bucket.consume(cost, now);
  }
}
