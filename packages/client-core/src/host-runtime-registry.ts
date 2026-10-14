import { ClientError } from "./common.js";
import { FlyxClient } from "./client.js";
import type { FlyxClientOptions } from "./client.js";
import type { HostRuntime } from "./host-runtime.js";
import type { ClientState, Unsubscribe } from "./types.js";

/** Scope is this execution realm. Separate browser tabs have separate registries. */
export class HostRuntimeRegistry<T extends HostRuntime = FlyxClient> {
  private runtimes = new Map<string, T>();
  private desiredHostId: string | undefined;
  private transition = 0;
  private forgetting = new Set<string>();
  private startTasks = new Map<T, Promise<void>>();
  private startRuntime(runtime: T): Promise<void> {
    const existing = this.startTasks.get(runtime);
    if (existing) return existing;
    const task = runtime.start().catch((error: unknown) => { if (this.startTasks.get(runtime) === task) this.startTasks.delete(runtime); throw error; });
    this.startTasks.set(runtime, task);
    return task;
  }
  private stopRuntime(runtime: T): void { this.startTasks.delete(runtime); runtime.stop(); }
  constructor(private factory: (hostId: string) => T) {}
  get desiredHost(): string | undefined { return this.desiredHostId; }
  get(hostId: string): T {
    if (this.forgetting.has(hostId)) throw new ClientError("HOST_FORGETTING", "Local Host data is being removed");
    let runtime = this.runtimes.get(hostId);
    if (!runtime) { runtime = this.factory(hostId); runtime.bindHostOwner?.(hostId); this.runtimes.set(hostId, runtime); }
    return runtime;
  }
  peek(hostId: string): T | undefined { return this.runtimes.get(hostId); }
  /** Used after a bootstrap pairing discovers the Host's pinned identity. */
  adopt(hostId: string, runtime: T): T {
    const existing = this.runtimes.get(hostId);
    if (existing && existing !== runtime) throw new ClientError("HOST_RUNTIME_EXISTS", "A runtime already owns this Host");
    if (this.forgetting.has(hostId)) throw new ClientError("HOST_FORGETTING", "Local Host data is being removed");
    for (const [id, value] of this.runtimes) if (value === runtime && id !== hostId) throw new ClientError("HOST_RUNTIME_BOUND", "Runtime already belongs to a different Host");
    runtime.bindHostOwner?.(hostId);
    this.runtimes.set(hostId, runtime);
    return runtime;
  }
  observe(hostId: string, handler: (state: ClientState) => void): Unsubscribe {
    // Releasing an observer has no effect on the owner's lifecycle.
    return this.get(hostId).onState(handler);
  }
  async setDesiredHost(hostId: string | undefined): Promise<T | undefined> {
    const runtime = hostId ? this.get(hostId) : undefined;
    if (hostId === this.desiredHostId) { if (runtime) await this.startRuntime(runtime); return runtime; }
    const previous = this.desiredHostId;
    const transition = ++this.transition;
    this.desiredHostId = hostId;
    const previousRuntime = previous ? this.runtimes.get(previous) : undefined;
    if (previousRuntime) this.stopRuntime(previousRuntime);
    if (!runtime) return undefined;
    await this.startRuntime(runtime);
    if (transition !== this.transition && this.desiredHostId !== hostId) this.stopRuntime(runtime);
    return runtime;
  }
  closeHost(hostId: string): void {
    if (this.desiredHostId === hostId) { this.desiredHostId = undefined; this.transition++; }
    const runtime = this.runtimes.get(hostId);
    if (runtime) this.stopRuntime(runtime);
    this.runtimes.delete(hostId);
  }
  async forgetLocalHost(hostId: string): Promise<void> {
    const runtime = this.get(hostId);
    this.forgetting.add(hostId);
    this.closeHost(hostId);
    try {
      if (runtime.forgetLocalHost) await runtime.forgetLocalHost(hostId);
      else await runtime.store.forgetLocalHost(hostId);
    } finally { this.forgetting.delete(hostId); }
  }
  stopAll(): void {
    this.desiredHostId = undefined;
    this.transition++;
    for (const runtime of this.runtimes.values()) this.stopRuntime(runtime);
  }
}
export function createHostRuntimeRegistry(options: FlyxClientOptions = {}): HostRuntimeRegistry<FlyxClient> {
  return new HostRuntimeRegistry((hostId) => new FlyxClient({ ...options, hostId }));
}
let defaultRegistry: HostRuntimeRegistry<FlyxClient> | undefined;
/** Application entrypoints share this registry; component cleanup only unsubscribes. */
export function getDefaultHostRuntimeRegistry(options: FlyxClientOptions = {}): HostRuntimeRegistry<FlyxClient> {
  return defaultRegistry ??= createHostRuntimeRegistry(options);
}
