import test from "node:test";
import assert from "node:assert/strict";
import { SCENE_CAPABILITY_POLICY, parseSceneCapabilities } from "./scene-capabilities.mjs";

test("maps each evidence scene capability to its destination policy name", () => {
  assert.equal(SCENE_CAPABILITY_POLICY.get("approval"), "interactiveApprovals");
  assert.equal(SCENE_CAPABILITY_POLICY.get("interrupt"), "interrupt");
  assert.equal(SCENE_CAPABILITY_POLICY.get("reconnect"), "resumeConversation");
  assert.equal(SCENE_CAPABILITY_POLICY.size, 3);
});

test("parses comma-separated scene names in order, tolerating blanks", () => {
  assert.deepEqual(parseSceneCapabilities("approval,interrupt,reconnect"),
    ["interactiveApprovals", "interrupt", "resumeConversation"]);
  assert.deepEqual(parseSceneCapabilities(" approval , , reconnect "), ["interactiveApprovals", "resumeConversation"]);
  assert.deepEqual(parseSceneCapabilities(undefined), []);
  assert.deepEqual(parseSceneCapabilities(""), []);
});

test("refuses unknown and duplicated scene capability names", () => {
  assert.throws(() => parseSceneCapabilities("turn"), /BOOTSTRAP_CAPABILITY_UNKNOWN:turn/);
  assert.throws(() => parseSceneCapabilities("approval,question"), /BOOTSTRAP_CAPABILITY_UNKNOWN:question/);
  assert.throws(() => parseSceneCapabilities("approval,approval"), /BOOTSTRAP_CAPABILITY_DUPLICATE:approval/);
  assert.throws(() => parseSceneCapabilities(7), /BOOTSTRAP_USAGE/);
});
