import { configNumber, errorResponse, jsonResponse } from "./http.js";
import type { ObjectState, RelayEnvironment } from "./runtime.js";

export type QuotaKind = "register-ip" | "register-global" | "connect-ip";
interface Counter { count: number; resetsAt: number }
type Counters = Partial<Record<QuotaKind, Counter>>;

/** One object per hashed source IP, plus one global registration budget object. */
export class RelayQuotaObject {
  private readonly ready: Promise<void>;
  private counters: Counters = {};

  constructor(
    private readonly state: ObjectState,
    private readonly env: RelayEnvironment,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.ready = state.blockConcurrencyWhile(async () => {
      this.counters = await state.storage.get<Counters>("quota") ?? {};
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method !== "POST" || new URL(request.url).pathname !== "/consume") {
      return errorResponse("NOT_FOUND", 404);
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || !("kind" in body)
      || !["register-ip", "register-global", "connect-ip"].includes(String(body.kind))) {
      return errorResponse("INVALID_QUOTA", 400);
    }
    const kind = body.kind as QuotaKind;
    return this.state.blockConcurrencyWhile(async () => {
      const now = this.now();
      const [limit, windowMs] = this.limit(kind);
      const previous = this.counters[kind];
      const current = previous && previous.resetsAt > now ? previous : { count: 0, resetsAt: now + windowMs };
      if (current.count >= limit) {
        return errorResponse("RATE_LIMITED", 429, Math.max(1, Math.ceil((current.resetsAt - now) / 1000)));
      }
      current.count += 1;
      this.counters[kind] = current;
      await this.save(now);
      return jsonResponse({ allowed: true });
    });
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.state.blockConcurrencyWhile(() => this.save(this.now()));
  }

  private limit(kind: QuotaKind): [number, number] {
    switch (kind) {
      case "register-ip": return [configNumber(this.env.RELAY_MAX_CREATES_PER_IP_HOUR, 5, 1000), 3_600_000];
      case "register-global": return [configNumber(this.env.RELAY_MAX_CREATES_PER_DAY, 1000, 1_000_000), 86_400_000];
      case "connect-ip": return [configNumber(this.env.RELAY_MAX_CONNECTS_PER_IP_MINUTE, 120, 10_000), 60_000];
    }
  }

  private async save(now: number): Promise<void> {
    for (const key of Object.keys(this.counters) as QuotaKind[]) {
      if (this.counters[key]!.resetsAt <= now) delete this.counters[key];
    }
    const counters = Object.values(this.counters);
    if (counters.length === 0) {
      await this.state.storage.delete("quota");
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.put("quota", this.counters);
    await this.state.storage.setAlarm(Math.min(...counters.map((counter) => counter.resetsAt)));
  }
}
