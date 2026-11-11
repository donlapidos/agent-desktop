import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY, NEXT, TASK_NEXT, canMove, canMoveTask, taskBusy } from "../src/modes.js";

const MODES = Object.keys(NEXT);

test("every move goes to a mode that exists", () => {
  for (const [from, tos] of Object.entries(NEXT)) for (const to of tos) assert.ok(MODES.includes(to), `${from} -> ${to}`);
});

test("from every mode there is a way back to idle", () => {
  for (const start of MODES) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) for (const to of NEXT[queue.shift()]) if (!seen.has(to)) (seen.add(to), queue.push(to));
    assert.ok(seen.has("idle"), `${start} can't get back to idle`);
  }
});

test("every mode but idle tells the user why Buddy is busy", () => {
  assert.deepEqual(Object.keys(BUSY).sort(), [...MODES].sort());
  for (const m of MODES) if (m !== "idle") assert.ok(BUSY[m].length > 0, m);
});

test("the moves Buddy relies on are allowed, and the dangerous ones aren't", () => {
  assert.ok(canMove("idle", "working"));
  assert.ok(canMove("listening", "working"), "typing while the mic is open");
  assert.ok(canMove("marking", "working"), "click in mark mode explains");
  assert.ok(canMove("working", "working"), "staying put is always fine");
  assert.ok(!canMove("working", "marking"), "can't start marking mid-answer");
  assert.ok(!canMove("working", "listening"), "can't open the mic mid-answer");
  assert.ok(!canMove("reading-marks", "working"), "the marks must finish reading first");
});

test("the tables can't be changed at runtime", () => {
  assert.ok(Object.isFrozen(NEXT));
  assert.ok(Object.isFrozen(BUSY));
});

test("task states: each moves only where it may, every one can get back to idle, and busy follows the state", () => {
  const states = Object.keys(TASK_NEXT);
  for (const [from, tos] of Object.entries(TASK_NEXT)) for (const to of tos) assert.ok(states.includes(to), `${from} -> ${to}`);
  const reach = (from, seen = new Set()) => {
    if (from === "idle" || seen.has(from)) return from === "idle";
    seen.add(from);
    return TASK_NEXT[from].some((to) => reach(to, seen));
  };
  for (const s of states) assert.ok(reach(s), `${s} can't get back to idle`);
  // The path an answer takes, approval and all, and its status lines (working to working) are allowed.
  for (const [a, b] of [["idle", "working"], ["working", "working"], ["working", "confirm"], ["confirm", "working"], ["working", "done"], ["done", "idle"], ["working", "error"], ["error", "working"], ["done", "working"]]) assert.ok(canMoveTask(a, b), `${a} -> ${b}`);
  // An answer can't finish while it waits for an OK, and an idle task can't wait for one.
  for (const [a, b] of [["confirm", "done"], ["confirm", "idle"], ["idle", "confirm"], ["idle", "done"], ["error", "done"]]) assert.ok(!canMoveTask(a, b), `${a} -> ${b}`);
  assert.deepEqual(states.filter(taskBusy), ["working", "confirm"]);
  assert.ok(Object.isFrozen(TASK_NEXT));
});
