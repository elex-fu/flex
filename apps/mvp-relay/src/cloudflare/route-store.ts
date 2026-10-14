import type { RelayRouteRecord, RelayRouteStore } from "../route-registry.js";
import { stubFor } from "./runtime.js";
import type { ObjectNamespace } from "./runtime.js";

/** Only the internal DO binding can access these URLs; the public Worker rejects them. */
export class NamespaceRouteStore implements RelayRouteStore {
  constructor(private readonly namespace: ObjectNamespace) {}

  async get(routeId: string): Promise<RelayRouteRecord | null> {
    const response = await stubFor(this.namespace, routeId).fetch(new Request("https://relay.internal/record"));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("RELAY_STORAGE_UNAVAILABLE");
    return response.json() as Promise<RelayRouteRecord>;
  }

  async put(record: RelayRouteRecord): Promise<void> {
    const response = await stubFor(this.namespace, record.routeId).fetch(new Request("https://relay.internal/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }));
    if (response.status === 409) throw new Error("ROUTE_EXISTS");
    if (!response.ok) throw new Error("RELAY_STORAGE_UNAVAILABLE");
  }

  async delete(routeId: string): Promise<void> {
    const response = await stubFor(this.namespace, routeId).fetch(new Request("https://relay.internal/record", { method: "DELETE" }));
    if (!response.ok) throw new Error("RELAY_STORAGE_UNAVAILABLE");
  }
}
