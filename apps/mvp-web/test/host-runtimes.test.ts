import assert from "node:assert/strict";
import test from "node:test";
import { HostRuntimeRegistry, MemoryClientStore, type ClientState, type HostProfile } from "@flyx/client-core";
import { WebHostRuntimes } from "../src/host-runtimes.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
function profile(hostId: string): HostProfile { return { hostId, label: hostId, hostPublicKey: "public", signingPublicKey: "signing", fingerprint: `sha256:${"a".repeat(64)}`, endpoints: [] }; }
class Runtime {
  readonly store = new MemoryClientStore(); activations = 0; stops = 0; pairs = 0; bound: string | undefined; private started = false;
  private state: ClientState = { connection: "idle", sync: "unknown", transportGeneration: 0, pairingRequired: false };
  constructor(private hostId: string, private gate?: Promise<void>) {}
  bindHostOwner(hostId: string) { if (this.bound && this.bound !== hostId) throw new Error("owner changed"); this.bound = hostId; }
  async start() { if (this.started) return; this.started = true; this.activations++; await this.gate; this.state = { ...this.state, profile: profile(this.hostId), connection: "online" }; }
  stop() { this.stops++; this.started = false; }
  getState() { return this.state; }
  onState(handler: (state: ClientState) => void) { handler(this.state); return () => {}; }
  async pair(hostId: string) { this.pairs++; this.hostId = hostId; await this.start(); }
}
test("repeat mounts share bootstrap activation and releasing observers never stops it", async () => {
  const runtime = new Runtime("host-a"); const registry = new HostRuntimeRegistry((hostId) => new Runtime(hostId)); const owners = new WebHostRuntimes(registry, () => runtime);
  const releaseA = owners.observe(() => {}); const releaseB = owners.observe(() => {}); const first = owners.initialize(); const second = owners.initialize(); assert.equal(first, second); await first;
  releaseA(); releaseB(); assert.equal(runtime.activations, 1); assert.equal(runtime.stops, 0); assert.equal(registry.peek("host-a"), runtime);
});
test("selected Host switches owners and observers without mutating the old identity", async () => {
  const runtime = new Runtime("host-a"); const registry = new HostRuntimeRegistry((hostId) => new Runtime(hostId)); const owners = new WebHostRuntimes(registry, () => runtime); let observed: Runtime | undefined;
  owners.observe((value) => { observed = value; }); await owners.initialize(); await owners.setDesired("host-b"); assert.equal(runtime.bound, "host-a"); assert.equal(runtime.stops, 1); assert.equal(observed, registry.peek("host-b")); assert.equal(registry.desiredHost, "host-b");
});
test("a late bootstrap cannot replace a newer selected Host", async () => {
  const gate = deferred(); const bootstrap = new Runtime("host-a", gate.promise); const registry = new HostRuntimeRegistry((hostId) => new Runtime(hostId)); const owners = new WebHostRuntimes(registry, () => bootstrap);
  const starting = owners.initialize(); await owners.setDesired("host-b"); gate.resolve(); await starting; assert.equal(registry.peek("host-a"), undefined); assert.equal(owners.getCurrent(), registry.peek("host-b"));
});
test("pairing a different Host uses an unbound bootstrap then adopts its proven owner", async () => {
  const candidates: Runtime[] = []; const registry = new HostRuntimeRegistry((hostId) => new Runtime(hostId)); const owners = new WebHostRuntimes(registry, () => { const runtime = new Runtime("host-a"); candidates.push(runtime); return runtime; });
  await owners.initialize(); const previous = owners.getCurrent(); await owners.pair("host-b", "browser"); assert.equal(previous.bound, "host-a"); assert.equal(previous.pairs, 0); assert.equal(previous.stops, 1); assert.equal(owners.getCurrent().bound, "host-b"); assert.equal(candidates.at(-1)?.pairs, 1);
});

test("explicitly clearing the desired Host closes a still-unregistered bootstrap", async () => {
  const gate = deferred(); const bootstrap = new Runtime("host-a", gate.promise); const registry = new HostRuntimeRegistry((hostId) => new Runtime(hostId)); const owners = new WebHostRuntimes(registry, () => bootstrap);
  const starting = owners.initialize(); await owners.setDesired(undefined); assert.equal(bootstrap.stops, 1); gate.resolve(); await starting; assert.equal(registry.peek("host-a"), undefined); assert.equal(registry.desiredHost, undefined);
});
