import type { RelayMetric } from "./relay-port.js";

const gaugeNames = new Set(["routes_online", "control_connections", "client_connections", "pairs_active"]);

/** Bounded labels only. No socket/route/IP identity appears in metrics output. */
export class RelayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly routeGauges = new Map<string, Map<string, number>>();
  private readonly pairDurationBuckets = [25, 50, 100, 250, 500, 1000, 5000, 15_000];
  private readonly pairDurationCounts = new Map<number, number>();
  private pairDurationCount = 0;
  private pairDurationSum = 0;

  record(routeKey: string, metric: RelayMetric): void {
    if (!Number.isFinite(metric.value)) return;
    if (metric.name === "pair_duration_ms") {
      this.pairDurationCount += 1;
      this.pairDurationSum += metric.value;
      for (const bound of this.pairDurationBuckets) {
        if (metric.value <= bound) this.pairDurationCounts.set(bound, (this.pairDurationCounts.get(bound) ?? 0) + 1);
      }
      return;
    }
    if (gaugeNames.has(metric.name)) {
      let gauges = this.routeGauges.get(routeKey);
      if (!gauges) { gauges = new Map(); this.routeGauges.set(routeKey, gauges); }
      gauges.set(metric.name, metric.value);
      return;
    }
    const suffix = metric.direction ? `{direction="${metric.direction}"}` : metric.reason ? `{reason="${metric.reason}"}` : "";
    const name = `relay_${metric.name}${suffix}`;
    this.counters.set(name, (this.counters.get(name) ?? 0) + metric.value);
  }

  removeRoute(routeKey: string): void { this.routeGauges.delete(routeKey); }

  render(): string {
    const lines: string[] = [];
    for (const name of gaugeNames) {
      let value = 0;
      for (const gauges of this.routeGauges.values()) value += gauges.get(name) ?? 0;
      lines.push(`relay_${name} ${value}`);
    }
    for (const [name, value] of [...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right))) lines.push(`${name} ${value}`);
    if (this.pairDurationCount) {
      lines.push("# TYPE relay_pair_duration_ms histogram");
      for (const bound of this.pairDurationBuckets) lines.push(`relay_pair_duration_ms_bucket{le="${bound}"} ${this.pairDurationCounts.get(bound) ?? 0}`);
      lines.push(`relay_pair_duration_ms_bucket{le="+Inf"} ${this.pairDurationCount}`,
        `relay_pair_duration_ms_count ${this.pairDurationCount}`, `relay_pair_duration_ms_sum ${this.pairDurationSum}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
