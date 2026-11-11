import assert from "node:assert/strict";
import { test } from "node:test";
import { redeem, requestApproval } from "../src/approvals.js";
import { appKey, decide } from "../src/policy.js";
import { DEFAULTS, normalize } from "../src/settings.js";

const policy = (p) => ({ rope: "ask", trustedApps: [], blockedApps: [], ...p });

test("by default every action is asked about, and password managers are blocked", () => {
  const p = normalize({});
  assert.equal(decide(p, { kind: "click", app: "EXCEL.EXE" }), "ask");
  assert.equal(decide(p, { kind: "scroll_to", app: "EXCEL.EXE" }), "ask");
  assert.equal(decide(p, { kind: "click", app: "KeePass.exe" }), "block");
  assert.ok(DEFAULTS.blockedApps.includes("1Password"));
});

test("'safe' allows only moves that change what's in view", () => {
  const p = policy({ rope: "safe" });
  for (const kind of ["scroll_to", "expand", "collapse", "focus", "restore", "minimize", "maximize"]) assert.equal(decide(p, { kind, app: "x" }), "allow", kind);
  for (const kind of ["click", "type", "set_value", "press", "select", "launch", "check", "double_click"]) assert.equal(decide(p, { kind, app: "x" }), "ask", kind);
});

test("'trusted' allows everything in trusted apps, and only safe moves elsewhere", () => {
  const p = policy({ rope: "trusted", trustedApps: ["Excel"] });
  assert.equal(decide(p, { kind: "type", app: "EXCEL.EXE" }), "allow");
  assert.equal(decide(p, { kind: "type", app: "WINWORD.EXE" }), "ask");
  assert.equal(decide(p, { kind: "expand", app: "WINWORD.EXE" }), "allow");
  assert.equal(decide(p, { kind: "type", app: null }), "ask", "an unknown app is never trusted");
});

test("trusted apps don't count unless the rope is 'trusted'", () => {
  assert.equal(decide(policy({ rope: "safe", trustedApps: ["Excel"] }), { kind: "click", app: "excel" }), "ask");
});

test("a blocked app wins over everything, however its name is written", () => {
  const p = policy({ rope: "trusted", trustedApps: ["KeePass"], blockedApps: ["KeePass"] });
  for (const app of ["KeePass", "keepass.exe", " KEEPASS.EXE "]) {
    assert.equal(decide(p, { kind: "scroll_to", app }), "block", app);
  }
  assert.equal(appKey("EXCEL.EXE"), "excel");
});

test("approvals honour the policy: blocked gets no slip, allowed gets one without asking", async () => {
  let asked = 0;
  const confirm = async () => (asked++, "allow");
  const blocked = await requestApproval({ kind: "click", app: "KeePass", args: ["click", "@s:e1"], headed: false, summary: "Click" }, { confirm, standing: new Set(), policy: policy({ blockedApps: ["KeePass"] }) });
  assert.equal(blocked, null);
  assert.equal(asked, 0, "a blocked action never even reaches the card");
  const allowed = await requestApproval({ kind: "scroll_to", app: "Excel", args: ["scroll-to", "@s:e1"], headed: false, summary: "Scroll" }, { confirm, standing: new Set(), policy: policy({ rope: "safe" }) });
  assert.ok(redeem(allowed));
  assert.equal(asked, 0, "an allowed action isn't asked about");
  const asking = await requestApproval({ kind: "click", app: "Excel", args: ["click", "@s:e1"], headed: false, summary: "Click" }, { confirm, standing: new Set(), policy: policy({ rope: "safe" }) });
  assert.ok(asking);
  assert.equal(asked, 1);
});
