import { Signal } from "./common.js";
import type { Unsubscribe } from "./types.js";

export type ClockTimer = ReturnType<typeof setTimeout>;
/** Clock readings are elapsed time, never a wall-clock timestamp. */
export interface MonotonicClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ClockTimer;
  clearTimeout(timer: ClockTimer): void;
  setInterval(callback: () => void, delayMs: number): ClockTimer;
  clearInterval(timer: ClockTimer): void;
}
export const systemMonotonicClock: MonotonicClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer),
};
export interface PlatformState { online: boolean; visibility: "visible" | "hidden" }
export type PlatformSignal =
  | { type: "online" | "offline"; at: number }
  | { type: "visibility"; visibility: PlatformState["visibility"]; at: number }
  | { type: "pageshow"; persisted: boolean; at: number };
export interface PlatformSignals {
  readonly clock: MonotonicClock;
  getState(): PlatformState;
  subscribe(handler: (signal: PlatformSignal) => void): Unsubscribe;
}
export interface BrowserPlatformOptions {
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  navigator?: Pick<Navigator, "onLine">;
  clock?: MonotonicClock;
}

/** Reports platform facts. The connection supervisor owns every reconnect. */
export class BrowserPlatformSignals implements PlatformSignals {
  readonly clock: MonotonicClock;
  private target: BrowserPlatformOptions["onlineTarget"];
  private document: BrowserPlatformOptions["document"];
  private navigator: BrowserPlatformOptions["navigator"];
  private changed = new Signal<PlatformSignal>();
  private observers = 0;
  private online: boolean;
  private onOnline = () => { this.online = true; this.changed.emit({ type: "online", at: this.clock.now() }); };
  private onOffline = () => { this.online = false; this.changed.emit({ type: "offline", at: this.clock.now() }); };
  private onVisibility = () => this.changed.emit({ type: "visibility", visibility: this.getState().visibility, at: this.clock.now() });
  private onPageshow = (event: Event) => this.changed.emit({ type: "pageshow", persisted: "persisted" in event && event.persisted === true, at: this.clock.now() });
  constructor(options: BrowserPlatformOptions = {}) {
    this.clock = options.clock ?? systemMonotonicClock;
    this.target = options.onlineTarget ?? (typeof window !== "undefined" ? window : undefined);
    this.document = options.document ?? (typeof document !== "undefined" ? document : undefined);
    this.navigator = options.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
    this.online = this.navigator?.onLine ?? true;
  }
  getState(): PlatformState { return { online: this.online, visibility: this.document?.visibilityState === "hidden" ? "hidden" : "visible" }; }
  subscribe(handler: (signal: PlatformSignal) => void): Unsubscribe {
    if (this.observers++ === 0) {
      // Refresh after a period with no listener, before the supervisor starts.
      this.online = this.navigator?.onLine ?? this.online;
      this.target?.addEventListener("online", this.onOnline);
      this.target?.addEventListener("offline", this.onOffline);
      this.target?.addEventListener("pageshow", this.onPageshow);
      this.document?.addEventListener("visibilitychange", this.onVisibility);
    }
    const off = this.changed.subscribe(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      off();
      if (--this.observers === 0) {
        this.target?.removeEventListener("online", this.onOnline);
        this.target?.removeEventListener("offline", this.onOffline);
        this.target?.removeEventListener("pageshow", this.onPageshow);
        this.document?.removeEventListener("visibilitychange", this.onVisibility);
      }
    };
  }
}
export function createBrowserPlatformSignals(options: BrowserPlatformOptions = {}): PlatformSignals { return new BrowserPlatformSignals(options); }
