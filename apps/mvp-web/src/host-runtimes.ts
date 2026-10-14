import { createFlyxClient, getDefaultHostRuntimeRegistry } from "@flyx/client-core";
import type { FlyxClient, HostRuntime, HostRuntimeRegistry, Unsubscribe } from "@flyx/client-core";

type WebRuntime = HostRuntime & { pair(input: string, deviceName?: string): Promise<void> };
/** Application ownership survives React observer mounts and cleanup. */
export class WebHostRuntimes<T extends WebRuntime = FlyxClient> {
  private current: T | undefined;
  private bootstrap: T | undefined;
  private startup: Promise<void> | undefined;
  private transition = 0;
  private observers = new Set<(runtime: T) => void>();
  constructor(readonly registry: HostRuntimeRegistry<T>, private createBootstrap: () => T) {}
  getCurrent(): T { return this.current ??= this.registry.desiredHost ? this.registry.get(this.registry.desiredHost) : this.bootstrap ??= this.createBootstrap(); }
  observe(handler: (runtime: T) => void): Unsubscribe { handler(this.getCurrent()); this.observers.add(handler); return () => { this.observers.delete(handler); }; }
  private publish(runtime: T): void { this.current = runtime; for (const handler of this.observers) handler(runtime); }
  async setDesired(hostId: string | undefined): Promise<T | undefined> {
    this.transition++;
    const runtime = hostId ? this.registry.get(hostId) : undefined;
    if (!runtime && this.current && this.current === this.bootstrap) this.current.stop();
    if (runtime && runtime !== this.current) { if (this.current && this.current === this.bootstrap) this.current.stop(); this.publish(runtime); }
    return this.registry.setDesiredHost(hostId);
  }
  initialize(initialPairing?: string): Promise<void> {
    if (this.startup) return this.startup;
    const transition = this.transition;
    const runtime = this.getCurrent();
    this.startup = (async () => {
      if (initialPairing) { await this.pair(initialPairing, "Flyx 浏览器"); return; }
      await runtime.start();
      if (transition !== this.transition) return;
      const hostId = runtime.getState().profile?.hostId;
      if (!hostId) return;
      const existing = this.registry.peek(hostId);
      if (existing && existing !== runtime) { runtime.stop(); this.bootstrap = undefined; await this.setDesired(hostId); return; }
      this.registry.adopt(hostId, runtime); if (this.bootstrap === runtime) this.bootstrap = undefined; await this.setDesired(hostId);
    })().catch((error: unknown) => { this.startup = undefined; throw error; });
    return this.startup;
  }
  async pair(input: string, deviceName: string): Promise<void> {
    const transition = ++this.transition;
    // An unregistered bootstrap can discover a new Host without changing the
    // identity owned by any existing registry runtime.
    const runtime = this.createBootstrap();
    try {
      await runtime.pair(input, deviceName);
      const hostId = runtime.getState().profile?.hostId;
      if (transition !== this.transition || !hostId) throw new Error("Pairing selection changed before activation");
      const existing = this.registry.peek(hostId);
      if (existing && existing !== runtime) this.registry.closeHost(hostId);
      if (this.current && this.current === this.bootstrap && this.current !== runtime) this.current.stop();
      this.registry.adopt(hostId, runtime); this.publish(runtime); await this.setDesired(hostId);
    } catch (error) { runtime.stop(); throw error; }
  }
}
function options() {
  return { directBaseUrl: window.location.origin, allowInsecureLoopback: window.location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname) };
}
let webRuntimes: WebHostRuntimes | undefined;
export function getWebHostRuntimes(): WebHostRuntimes { return webRuntimes ??= new WebHostRuntimes(getDefaultHostRuntimeRegistry(options()), () => createFlyxClient(options())); }
/** Call from the app's selected/desired Host lifecycle, never observer cleanup. */
export function setDesiredWebHost(hostId: string | undefined): Promise<FlyxClient | undefined> { return getWebHostRuntimes().setDesired(hostId); }
