import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ROUTE_ID_PATTERN, type RelayRouteRecord, type RelayRouteStore } from "./route-registry.js";

/** Durable Node route metadata. Files contain only a verifier and routing metadata. */
export class FileRelayRouteStore implements RelayRouteStore {
  private operation = Promise.resolve();
  constructor(private readonly directory: string, private readonly maxRoutes = 10_000) {}

  async get(routeId: string): Promise<RelayRouteRecord | null> {
    if (!ROUTE_ID_PATTERN.test(routeId)) return null;
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, `${routeId}.json`), "utf8"));
      if (!raw || typeof raw !== "object") return null;
      const value = raw as Record<string, unknown>;
      if (value.routeId !== routeId || typeof value.credentialHash !== "string" || !/^[a-f0-9]{64}$/.test(value.credentialHash)
        || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
      return { routeId, credentialHash: value.credentialHash, createdAt: value.createdAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw new Error("ROUTE_STORE_UNAVAILABLE");
    }
  }

  put(record: RelayRouteRecord): Promise<void> {
    const result = this.operation.then(async () => {
      if (!ROUTE_ID_PATTERN.test(record.routeId) || !/^[a-f0-9]{64}$/.test(record.credentialHash)) throw new Error("INVALID_ROUTE_RECORD");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entries = await readdir(this.directory);
      if (entries.filter(name => /^[A-Za-z0-9_-]{32,128}\.json$/.test(name)).length >= this.maxRoutes) throw new Error("ROUTE_QUOTA_EXCEEDED");
      const file = await open(join(this.directory, `${record.routeId}.json`), "wx", 0o600);
      try { await file.writeFile(JSON.stringify(record), "utf8"); await file.sync(); } finally { await file.close(); }
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
    this.operation = result.catch(() => undefined);
    return result;
  }

  async delete(routeId: string): Promise<void> {
    if (!ROUTE_ID_PATTERN.test(routeId)) return;
    try { await unlink(join(this.directory, `${routeId}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("ROUTE_STORE_UNAVAILABLE"); }
  }
}
