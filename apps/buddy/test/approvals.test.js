import assert from "node:assert/strict";
import { test } from "node:test";
import { askUser, redeem, requestApproval } from "../src/approvals.js";
import { observe, perform } from "../src/desktop.js";

const action = { args: ["click", "@s1:e1"], headed: false, summary: "Click \"Save\" (button)" };
const answering = (decision) => {
  const calls = [];
  return { calls, confirm: async (...a) => (calls.push(a), decision) };
};

test("a declined request yields no slip", async () => {
  const { confirm } = answering("deny");
  assert.equal(await requestApproval(action, { confirm, standing: { allowed: false } }), null);
});

test("an allowed request yields a slip that works exactly once", async () => {
  const { confirm } = answering("allow");
  const slip = await requestApproval(action, { confirm, standing: { allowed: false } });
  assert.ok(slip);
  assert.equal(redeem(slip), true);
  assert.equal(redeem(slip), false);
});

test("a slip can't be forged by copying its shape", async () => {
  const { confirm } = answering("allow");
  const real = await requestApproval(action, { confirm, standing: { allowed: false } });
  assert.equal(redeem(Object.freeze({ ...real })), false);
  assert.equal(redeem(null), false);
  assert.equal(redeem("slip"), false);
});

test("a slip is a frozen copy, so changing the request afterwards changes nothing", async () => {
  const { confirm } = answering("allow");
  const request = { ...action, args: [...action.args] };
  const slip = await requestApproval(request, { confirm, standing: { allowed: false } });
  request.args[0] = "type";
  assert.equal(slip.args[0], "click");
  assert.throws(() => {
    "use strict";
    slip.args = ["press", "alt+f4"];
  });
});

test("the card shows the action's own summary, with Claude's note beside it", async () => {
  const { calls, confirm } = answering("deny");
  const bounds = { x: 1, y: 2, width: 3, height: 4 };
  await requestApproval(action, { confirm, bounds, note: "Save the file", standing: { allowed: false } });
  assert.deepEqual(calls, [[action.summary, bounds, "Save the file"]]);
});

test("Allow for this task stops asking for the rest of that answer only", async () => {
  const standing = { allowed: false };
  await requestApproval(action, { ...answering("always"), standing });
  const later = answering("deny");
  assert.ok(await requestApproval(action, { confirm: later.confirm, standing }));
  assert.equal(later.calls.length, 0);
  // A new answer starts with a fresh standing (Brain.run resets it), so it asks again.
  const next = answering("deny");
  assert.equal(await requestApproval(action, { confirm: next.confirm, standing: { allowed: false } }), null);
  assert.equal(next.calls.length, 1);
});

test("askUser asks without issuing a slip", async () => {
  assert.equal(await askUser("Create a document", { ...answering("allow"), standing: { allowed: false } }), true);
  assert.equal(await askUser("Create a document", { ...answering("deny"), standing: { allowed: false } }), false);
});

test("perform refuses anything that isn't a slip, without running the CLI", async () => {
  const res = await perform(/** @type {any} */ ({ ...action }));
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, "NOT_APPROVED");
});

test("observe runs only commands that look, never ones that act", async () => {
  for (const cmd of ["click", "type", "press", "set-value", "launch", "focus-window", "minimize", "close-app", "drag"]) {
    const res = await observe([cmd, "x"]);
    assert.equal(res.ok === false && res.error.code, "NOT_READ_ONLY", cmd);
  }
});
