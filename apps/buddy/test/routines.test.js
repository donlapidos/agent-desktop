import assert from "node:assert/strict";
import { test } from "node:test";
import { CATCH_UP_MS, describe, nextRun, verdict } from "../src/routines.js";
import { routine } from "../src/settings.js";

// Local times, built the way the scheduler sees them. 2026-11-09 is a Monday.
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m);
const sched = (s) => ({ every: "day", time: "09:00", days: [], hours: 4, ...s });

test("every day: later today if the time hasn't passed, else tomorrow", () => {
  assert.deepEqual(nextRun(sched({}), at(9, 8, 0)), at(9, 9));
  assert.deepEqual(nextRun(sched({}), at(9, 9, 0)), at(10, 9), "exactly at the time counts as passed");
  assert.deepEqual(nextRun(sched({}), at(9, 23, 59)), at(10, 9));
});

test("weekdays skip Saturday and Sunday", () => {
  assert.deepEqual(nextRun(sched({ every: "weekday" }), at(13, 10)), at(16, 9), "Friday after 9 -> Monday");
  assert.deepEqual(nextRun(sched({ every: "weekday" }), at(14, 12)), at(16, 9), "Saturday -> Monday");
});

test("chosen days of the week", () => {
  const s = sched({ every: "week", days: [1, 3, 5], time: "17:30" }); // Mon, Wed, Fri
  assert.deepEqual(nextRun(s, at(9, 18)), at(11, 17, 30), "Monday evening -> Wednesday");
  assert.deepEqual(nextRun(s, at(13, 18)), at(16, 17, 30), "Friday evening -> next Monday");
});

test("every few hours, from the start time to midnight, each day", () => {
  const s = sched({ every: "hours", hours: 4, time: "08:00" }); // 8, 12, 16, 20
  assert.deepEqual(nextRun(s, at(9, 7)), at(9, 8));
  assert.deepEqual(nextRun(s, at(9, 12)), at(9, 16));
  assert.deepEqual(nextRun(s, at(9, 21)), at(10, 8), "after the last slot -> tomorrow's first");
});

test("a due routine runs; a disabled one never does", () => {
  const r = routine({ id: "r1abc", prompt: "Summarise my inbox", schedule: sched({}) });
  assert.equal(verdict(r, at(9, 8), at(9, 8, 30)), "wait");
  assert.equal(verdict(r, at(9, 8), at(9, 9, 1)), "run");
  assert.equal(verdict({ ...r, enabled: false }, at(9, 8), at(9, 9, 1)), "wait");
});

test("a run missed by a little still happens; one missed long ago is skipped", () => {
  const r = routine({ id: "r1abc", prompt: "Summarise my inbox", schedule: sched({}) });
  const due = at(9, 9);
  assert.equal(verdict(r, at(9, 8), new Date(due.getTime() + CATCH_UP_MS - 60_000)), "run");
  assert.equal(verdict(r, at(9, 8), new Date(due.getTime() + CATCH_UP_MS + 60_000)), "skip");
});

test("schedules read as plain words", () => {
  assert.equal(describe(sched({ every: "weekday" })), "Weekdays at 9:00");
  assert.equal(describe(sched({ every: "week", days: [1, 3, 5], time: "17:30" })), "Mon, Wed, Fri at 17:30");
  assert.equal(describe(sched({ every: "hours", hours: 1, time: "08:00" })), "Every hour from 8:00");
});

test("stored routines are validated", () => {
  assert.equal(routine({ id: "r1abc", prompt: "   " }), null, "no prompt, no routine");
  assert.equal(routine({ id: "bad id!", prompt: "x" }), null);
  const r = routine({ id: "r1abc", prompt: "x".repeat(5000), schedule: { every: "week", days: [], time: "25:00", hours: 99 } });
  assert.equal(r.prompt.length, 2000);
  assert.deepEqual(r.schedule, { every: "week", time: "09:00", days: [1], hours: 4 });
  assert.equal(r.enabled, true);
});
