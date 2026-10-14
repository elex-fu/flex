import { describe, expect, it } from "vitest";
import { BrowserPlatformSignals } from "./platform.js";
import { testClock } from "./platform-test-support.js";

class TestDocument extends EventTarget { visibilityState: DocumentVisibilityState = "visible"; }
describe("platform signals", () => {
  it("reports facts with a monotonic clock and releases every browser listener", () => {
    const target = new EventTarget();
    const document = new TestDocument();
    const source = new BrowserPlatformSignals({ onlineTarget: target, document, navigator: { onLine: false }, clock: testClock });
    const events: string[] = [];
    const off = source.subscribe((event) => events.push(event.type));
    expect(source.getState()).toEqual({ online: false, visibility: "visible" });
    target.dispatchEvent(new Event("online"));
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    target.dispatchEvent(new Event("pageshow"));
    target.dispatchEvent(new Event("offline"));
    expect(source.getState()).toEqual({ online: false, visibility: "hidden" });
    expect(events).toEqual(["online", "visibility", "pageshow", "offline"]);
    off(); off();
    target.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(events).toHaveLength(4);
  });
});
