import assert from "node:assert/strict";
import test from "node:test";
import type { CoreControls, FlyxClient } from "@flyx/client-core";
import { webInterrupt } from "../src/use-host.js";

type Call = { method: string; payload: unknown };
function fakeClient(options: { catalog: boolean; projection: "canonical" | "legacy" }) {
  const commands: Call[] = [];
  const client = {
    getNegotiatedHello: () => ({ capabilities: options.catalog ? ["session-registry-v1"] : [] }),
    getProjectionMode: () => options.projection,
    command: async (method: string, payload?: unknown) => { commands.push({ method, payload }); return { ok: true }; },
  };
  return { client: client as unknown as FlyxClient, commands };
}
function fakeControls(options: { failWith?: string; initialError?: string } = {}) {
  let error: string | undefined = options.initialError;
  let interrupted = 0;
  return {
    controls: {
      interrupt: async () => { interrupted++; if (options.failWith !== undefined) error = options.failWith; },
      getState: () => ({ error }),
    } as unknown as CoreControls,
    get interrupted() { return interrupted; },
  };
}

test("a catalog Host on the canonical projection interrupts through CoreControls only", async () => {
  const { client, commands } = fakeClient({ catalog: true, projection: "canonical" });
  const fake = fakeControls();
  await webInterrupt(client, fake.controls, "session");
  assert.equal(fake.interrupted, 1);
  assert.equal(commands.length, 0);
});
test("a CoreControls interrupt failure is rethrown so the Host error banner shows it", async () => {
  const { client, commands } = fakeClient({ catalog: true, projection: "canonical" });
  const fake = fakeControls({ failWith: "TURN_NOT_INTERRUPTIBLE: Refresh the active Turn" });
  await assert.rejects(() => webInterrupt(client, fake.controls, "session"), /Refresh the active Turn/);
  assert.equal(commands.length, 0);
});
test("a pre-existing CoreControls error does not mask a successful interrupt", async () => {
  const { client } = fakeClient({ catalog: true, projection: "canonical" });
  const fake = fakeControls({ initialError: "earlier refresh failed" });
  await webInterrupt(client, fake.controls, "session");
  assert.equal(fake.interrupted, 1);
});
test("a Host without the Session catalog keeps the legacy raw command without a session target", async () => {
  const { client, commands } = fakeClient({ catalog: false, projection: "legacy" });
  const fake = fakeControls();
  await webInterrupt(client, fake.controls, "session");
  assert.equal(fake.interrupted, 0);
  assert.deepEqual(commands, [{ method: "session.interrupt", payload: {} }]);
});
test("a catalog Host still on the legacy projection has no typed snapshot, so it keeps the legacy command with its session target", async () => {
  const { client, commands } = fakeClient({ catalog: true, projection: "legacy" });
  const fake = fakeControls();
  await webInterrupt(client, fake.controls, "session");
  assert.equal(fake.interrupted, 0);
  assert.deepEqual(commands, [{ method: "session.interrupt", payload: { sessionId: "session" } }]);
  await webInterrupt(client, fake.controls, undefined);
  assert.deepEqual(commands.at(-1), { method: "session.interrupt", payload: {} });
});
