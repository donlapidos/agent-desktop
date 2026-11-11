import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppSessions } from "../src/app-sessions.js";

const fakeBrain = (conn, client) => ({ conn, client, standing: new Set(), abort: null, target: null });
const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r("hung"), ms))]);

test("each session has a Brain of its own: its window and Allow for this task stay its own", async () => {
  const s = createAppSessions({ makeBrain: fakeBrain, gapMs: 120_000 });
  const live = new AbortController().signal;
  const codex = await s.call(1, "Codex", live, async (b) => b);
  const claude = await s.call(2, "Claude", live, async (b) => b);
  assert.notEqual(codex, claude);
  codex.standing.add("screen");
  codex.target = { app_name: "EXCEL.EXE" };
  assert.equal(claude.standing.size, 0, "Codex's Allow for this task doesn't reach Claude Code");
  assert.equal(claude.target, null);
  assert.equal(await s.call(1, "Codex", live, async (b) => b), codex, "the same session keeps its Brain");
});

test("within a session calls take turns, each with its own cancel; a cancelled waiting call never runs", async () => {
  const s = createAppSessions({ makeBrain: fakeBrain, gapMs: 120_000 });
  const ran = [];
  let release;
  const first = new AbortController();
  const second = new AbortController();
  const third = new AbortController();
  const a = s.call(1, "Claude", first.signal, (b) => {
    ran.push("a");
    const mine = b.abort;
    return new Promise((r) => (release = () => r(mine.signal.aborted ? "a stopped" : "a done")));
  });
  const bCall = s.call(1, "Claude", second.signal, async (b) => (ran.push("b"), b.abort.signal.aborted ? "b stopped" : "b done"));
  const cCall = s.call(1, "Claude", third.signal, async () => (ran.push("c"), "c done"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ran, ["a"], "one at a time");
  third.abort();
  second.abort();
  release();
  assert.equal(await within(a), "a done", "cancelling the later calls didn't stop the running one");
  assert.equal(await within(bCall), "Cancelled before it started.");
  assert.equal(await within(cCall), "Cancelled before it started.");
  assert.deepEqual(ran, ["a"], "neither cancelled call ran");
});

test("cancelling the running call stops it, and the next call starts with a fresh cancel", async () => {
  const s = createAppSessions({ makeBrain: fakeBrain, gapMs: 120_000 });
  const stop = new AbortController();
  let seen;
  const running = s.call(1, "Claude", stop.signal, (b) => new Promise((r) => b.abort.signal.addEventListener("abort", () => r("stopped"))));
  await new Promise((r) => setTimeout(r, 10));
  stop.abort();
  assert.equal(await within(running), "stopped");
  await s.call(1, "Claude", new AbortController().signal, async (b) => (seen = b.abort.signal.aborted));
  assert.equal(seen, false);
});

test("a failed call doesn't block the next, Allow for this task lapses after a quiet spell, and closing drops the Brain", async () => {
  let t = 0;
  const s = createAppSessions({ makeBrain: fakeBrain, gapMs: 1000, now: () => t });
  const live = new AbortController().signal;
  await assert.rejects(s.call(1, "Claude", live, async () => { throw new Error("boom"); }));
  const b = await s.call(1, "Claude", live, async (brain) => brain);
  b.standing.add("screen");
  t += 500;
  await s.call(1, "Claude", live, async () => {});
  assert.ok(b.standing.has("screen"), "still the same task");
  t += 1500;
  await s.call(1, "Claude", live, async () => {});
  assert.equal(b.standing.size, 0, "a new task after a quiet spell");
  s.close(1);
  assert.equal(s.size(), 0);
  assert.notEqual(await s.call(1, "Claude", live, async (brain) => brain), b);
});
