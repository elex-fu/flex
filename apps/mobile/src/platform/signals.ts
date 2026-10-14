import type { MonotonicClock, PlatformSignal, PlatformSignals, PlatformState, Unsubscribe } from "@flyx/client-core";
export interface AppStateBridge { currentState: string | null; addEventListener(type: "change", handler: (state: string) => void): { remove(): void } }
export interface NetworkState { isConnected: boolean | null; isInternetReachable: boolean | null }
export interface NetworkBridge { fetch(): Promise<NetworkState>; addEventListener(handler: (state: NetworkState) => void): Unsubscribe }
export const nativeMonotonicClock: MonotonicClock = {
  now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id),
};
/** NetInfo/AppState publish facts; shared Supervisor owns retries and wakeup probes. */
export class NativePlatformSignals implements PlatformSignals {
  private state: PlatformState;
  private handlers = new Set<(event: PlatformSignal) => void>();
  private off: Unsubscribe[] = [];
  private life = 0;
  private networkVersion = 0;
  constructor(private app: AppStateBridge, private network: NetworkBridge, readonly clock: MonotonicClock = nativeMonotonicClock) {
    this.state = { online: false, visibility: app.currentState === "active" ? "visible" : "hidden" };
  }
  getState(): PlatformState { return { ...this.state }; }
  private emit(event: PlatformSignal): void { for (const handler of this.handlers) handler(event); }
  private updateNetwork(state: NetworkState): void {
    const online = state.isConnected === true && state.isInternetReachable !== false;
    if (online === this.state.online) return;
    this.state.online = online; this.emit({ type: online ? "online" : "offline", at: this.clock.now() });
  }
  subscribe(handler: (event: PlatformSignal) => void): Unsubscribe {
    this.handlers.add(handler);
    if (this.handlers.size === 1) {
      const life = ++this.life;
      this.state = { online: false, visibility: this.app.currentState === "active" ? "visible" : "hidden" };
      const listener = this.app.addEventListener("change", (value) => {
        const visibility = value === "active" ? "visible" : "hidden";
        if (visibility === this.state.visibility) return;
        this.state.visibility = visibility; this.emit({ type: "visibility", visibility, at: this.clock.now() });
      });
      this.off = [() => listener.remove(), this.network.addEventListener((value) => { this.networkVersion++; this.updateNetwork(value); })];
      const version = this.networkVersion;
      void this.network.fetch().then((value) => { if (life === this.life && version === this.networkVersion) this.updateNetwork(value); }).catch(() => { /* Unknown reachability stays offline. */ });
    }
    let active = true;
    return () => { if (!active) return; active = false; this.handlers.delete(handler); if (this.handlers.size === 0) { this.life++; for (const off of this.off) off(); this.off = []; } };
  }
}
