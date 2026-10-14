import { createFlyxClient, getDefaultHostRuntimeRegistry } from "@flyx/client-core";
import type { FlyxClient, HostRuntime, HostRuntimeRegistry, Unsubscribe } from "@flyx/client-core";
import { StoredWebBootstrapPreference, type WebBootstrapPreference } from "./bootstrap-preference.js";

type WebRuntime = HostRuntime & { pair(input: string, deviceName?: string): Promise<void> };
/** Application ownership survives React observer mounts and cleanup. */
export class WebHostRuntimes<T extends WebRuntime = FlyxClient> {
  private current: T | undefined;
  private bootstrap: T | undefined;
  private startup: Promise<void> | undefined;
  private transition = 0;
  private bootstrapBlocked = false;
  private observers = new Set<(runtime: T) => void>();
  private errors = new Set<(error: string) => void>();
  private error = "";
  private sessions = new Map<string, string>();
  constructor(readonly registry: HostRuntimeRegistry<T>, private createBootstrap: () => T, private preference?: WebBootstrapPreference) {}
  getCurrent(): T { return this.current ??= this.registry.desiredHost ? this.registry.get(this.registry.desiredHost) : this.bootstrap ??= this.createBootstrap(); }
  observe(handler: (runtime: T) => void): Unsubscribe { handler(this.getCurrent()); this.observers.add(handler); return () => { this.observers.delete(handler); }; }
  observeError(handler: (error: string) => void): Unsubscribe { handler(this.error); this.errors.add(handler); return () => { this.errors.delete(handler); }; }
  private publishError(error: string): void { this.error = error; for (const handler of this.errors) handler(error); }
  sessionFor(hostId: string): string | undefined { return this.sessions.get(hostId); }
  rememberSession(hostId: string, sessionId: string): void { this.sessions.set(hostId, sessionId); }
  private publish(runtime: T): void { this.current = runtime; for (const handler of this.observers) handler(runtime); }
  async setDesired(hostId: string | undefined): Promise<T | undefined> { return this.activateDesired(hostId,true); }
  private async activateDesired(hostId: string | undefined, explicit: boolean): Promise<T | undefined> {
    this.transition++;
    this.publishError("");
    const runtime = hostId ? this.registry.get(hostId) : undefined;
    if (!runtime && this.current && this.current === this.bootstrap) this.current.stop();
    if (runtime && runtime !== this.current) { if (this.current && this.current === this.bootstrap) this.current.stop(); this.publish(runtime); }
    const result = await this.registry.setDesiredHost(hostId);
    if (explicit && hostId && result && this.registry.desiredHost === hostId) {
      try { this.preference?.allow(); this.bootstrapBlocked = false; } catch (cause) { this.bootstrapBlocked = true; this.publishError(cause instanceof Error ? cause.message : "自动连接偏好未保存"); }
    }
    return result;
  }
  initialize(initialPairing?: string): Promise<void> {
    if (this.startup) return this.startup;
    if (!initialPairing) {
      try { if (this.bootstrapBlocked || this.preference?.isBlocked()) { this.bootstrapBlocked = true; return Promise.resolve(); } }
      catch (cause) { this.bootstrapBlocked = true; this.publishError(cause instanceof Error ? cause.message : "自动连接设置不可用"); return Promise.reject(cause); }
    }
    const transition = this.transition;
    const runtime = this.getCurrent();
    this.startup = (async () => {
      if (initialPairing) { await this.pair(initialPairing, "Flyx 浏览器"); return; }
      await runtime.start();
      if (transition !== this.transition) return;
      if (this.bootstrapBlocked || this.preference?.isBlocked()) { runtime.stop(); return; }
      const hostId = runtime.getState().profile?.hostId;
      if (!hostId) return;
      const existing = this.registry.peek(hostId);
      if (existing && existing !== runtime) { runtime.stop(); this.bootstrap = undefined; await this.activateDesired(hostId,false); return; }
      this.registry.adopt(hostId, runtime); if (this.bootstrap === runtime) this.bootstrap = undefined; await this.activateDesired(hostId,false);
    })().catch((error: unknown) => { this.startup = undefined; if (transition === this.transition) this.publishError(error instanceof Error ? error.message : "连接初始化失败"); throw error; });
    return this.startup;
  }
  async pair(input: string, deviceName: string): Promise<void> {
    const transition = ++this.transition;
    this.publishError("");
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
    } catch (error) { runtime.stop(); if (transition === this.transition) this.publishError(error instanceof Error ? error.message : "配对失败"); throw error; }
  }
  /** Explicit local deletion; no remote revocation is implied. */
  async forgetLocalHost(hostId: string): Promise<void> {
    const transition = ++this.transition;
    const displayed = this.current === this.registry.peek(hostId) || this.current?.getState().profile?.hostId === hostId;
    this.publishError("");
    if (displayed) {
      this.bootstrapBlocked = true;
      try { this.preference?.block(); } catch (cause) { this.publishError(cause instanceof Error ? cause.message : "停止自动连接的设置保存失败"); throw cause; }
    }
    if (displayed && !this.registry.peek(hostId) && this.current?.getState().profile?.hostId === hostId) this.registry.adopt(hostId,this.current);
    await this.registry.forgetLocalHost(hostId);
    this.sessions.delete(hostId);
    if (transition !== this.transition || !displayed) return;
    this.startup = undefined;
    this.bootstrap = this.createBootstrap();
    this.publish(this.bootstrap);
  }
}
function options() {
  return { directBaseUrl: window.location.origin, allowInsecureLoopback: window.location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname) };
}
let webRuntimes: WebHostRuntimes | undefined;
export function getWebHostRuntimes(): WebHostRuntimes { return webRuntimes ??= new WebHostRuntimes(getDefaultHostRuntimeRegistry(options()), () => createFlyxClient(options()), new StoredWebBootstrapPreference(() => window.localStorage)); }
/** Call from the app's selected/desired Host lifecycle, never observer cleanup. */
export function setDesiredWebHost(hostId: string | undefined): Promise<FlyxClient | undefined> { return getWebHostRuntimes().setDesired(hostId); }
