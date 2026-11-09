import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY, NEXT, canMove } from "../src/modes.js";

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
