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
  assert.equal(await requestApproval(action, { confirm, standing: new Set() }), null);
});

test("an allowed request yields a slip that works exactly once", async () => {
  const { confirm } = answering("allow");
  const slip = await requestApproval(action, { confirm, standing: new Set() });
  assert.ok(slip);
  assert.equal(redeem(slip), true);
  assert.equal(redeem(slip), false);
});

test("a slip can't be forged by copying its shape", async () => {
  const { confirm } = answering("allow");
  const real = await requestApproval(action, { confirm, standing: new Set() });
  assert.equal(redeem(Object.freeze({ ...real })), false);
  assert.equal(redeem(null), false);
  assert.equal(redeem("slip"), false);
});

test("a slip is a frozen copy, so changing the request afterwards changes nothing", async () => {
  const { confirm } = answering("allow");
  const request = { ...action, args: [...action.args] };
  const slip = await requestApproval(request, { confirm, standing: new Set() });
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
  await requestApproval(action, { confirm, bounds, note: "Save the file", standing: new Set() });
  assert.deepEqual(calls, [[action.summary, bounds, "Save the file"]]);
});

test("Allow for this task stops asking for the rest of that answer only", async () => {
  const standing = new Set();
  await requestApproval(action, { ...answering("always"), standing });
  const later = answering("deny");
  assert.ok(await requestApproval(action, { confirm: later.confirm, standing }));
  assert.equal(later.calls.length, 0);
  // A new answer starts with a fresh standing (Brain.run resets it), so it asks again.
  const next = answering("deny");
  assert.equal(await requestApproval(action, { confirm: next.confirm, standing: new Set() }), null);
  assert.equal(next.calls.length, 1);
});

test("askUser asks without issuing a slip", async () => {
  assert.equal(await askUser("Create a document", { ...answering("allow"), standing: new Set() }), true);
  assert.equal(await askUser("Create a document", { ...answering("deny"), standing: new Set() }), false);
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

test("the dictation slip can only ever paste, and only once", async () => {
  const { dictationPaste } = await import("../src/approvals.js");
  const slip = dictationPaste();
  assert.deepEqual([...slip.args], ["press", "ctrl+v"]);
  assert.equal(slip.kind, "paste");
  assert.throws(() => slip.args.push("--app", "anything"), "its arguments can't be changed");
  assert.equal(redeem(slip), true);
  assert.equal(redeem(slip), false);
});

test("the focus slip can only focus the window the user was in", async () => {
  const { returnFocus } = await import("../src/approvals.js");
  const slip = returnFocus({ app_name: "EXCEL.EXE", id: "w-1234" });
  assert.deepEqual([...slip.args], ["focus-window", "--app", "EXCEL.EXE", "--window-id", "w-1234"]);
  assert.equal(slip.kind, "focus");
  assert.throws(() => slip.args.splice(0, 1, "click"), "its arguments can't be changed");
  assert.equal(redeem(slip), true);
  assert.equal(redeem(slip), false);
});

test("Allow for this task covers more of the same kind only: screen, files, PowerShell, each site", async () => {
  const standing = new Set();
  let asked = 0;
  const always = { confirm: async () => (asked++, "always"), standing };
  const click = { kind: "click", app: "Excel", args: ["click", "@s:e1"], headed: false, summary: "Click Save" };
  assert.ok(await requestApproval(click, always));
  assert.ok(await requestApproval({ ...click, summary: "Click Bold" }, always));
  assert.equal(asked, 1, "a second click passes");
  assert.equal(await askUser("Run a command", { ...always, scope: "powershell" }), true);
  assert.equal(asked, 2, "but PowerShell still asked: a click's allowance doesn't cover it");
  await askUser("Read a page on bbc.co.uk", { ...always, scope: "web:bbc.co.uk" });
  await askUser("Read another page on bbc.co.uk", { ...always, scope: "web:bbc.co.uk" });
  assert.equal(asked, 3, "the same site passes");
  await askUser("Read a page on evil.example", { ...always, scope: "web:evil.example" });
  assert.equal(asked, 4, "another site asks");
  await askUser("Something with no scope", always);
  await askUser("Something with no scope", always);
  assert.equal(asked, 6, "a request without a scope always asks, and its Allow for this task covers nothing");
  assert.deepEqual([...standing].sort(), ["powershell", "screen", "web:bbc.co.uk", "web:evil.example"]);
});
