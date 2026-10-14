import { Signal } from "./common.js";
import type { MonotonicClock, PlatformSignal, PlatformSignals, PlatformState } from "./platform.js";
import type { Unsubscribe } from "./types.js";

export const testClock: MonotonicClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, delay) => setInterval(callback, delay), clearInterval: (timer) => clearInterval(timer),
};
export class TestPlatformSignals implements PlatformSignals {
  readonly clock = testClock;
  private changed = new Signal<PlatformSignal>();
  observers = 0;
  constructor(private state: PlatformState = { online: true, visibility: "visible" }) {}
  getState(): PlatformState { return { ...this.state }; }
  subscribe(handler: (signal: PlatformSignal) => void): Unsubscribe { this.observers++; const off = this.changed.subscribe(handler); return () => { off(); this.observers--; }; }
  online(value: boolean): void { this.state.online = value; this.changed.emit({ type: value ? "online" : "offline", at: this.clock.now() }); }
  visibility(value: PlatformState["visibility"]): void { this.state.visibility = value; this.changed.emit({ type: "visibility", visibility: value, at: this.clock.now() }); }
  pageshow(persisted = false): void { this.changed.emit({ type: "pageshow", persisted, at: this.clock.now() }); }
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
