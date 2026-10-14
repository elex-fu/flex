import { expect, it } from "vitest";
import { ControlLane } from "./control-lane.js";

it("orders control delivery per runtime and applies the queue budget without waiting for a Turn", async () => {
  let release!: () => void; const held = new Promise<void>((yes) => { release = yes; }); const lane = new ControlLane(2); const calls: string[] = [];
  const first = lane.submit("runtime", async () => { calls.push("first"); await held; }); const second = lane.submit("runtime", () => { calls.push("second"); });
  await expect(lane.submit("runtime", () => {})).rejects.toThrow("CONTROL_QUEUE_FULL"); await Promise.resolve(); expect(calls).toEqual(["first"]);
  release(); await Promise.all([first, second]); await lane.drain(); expect(calls).toEqual(["first", "second"]); expect(lane.size).toBe(0);
});
