import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalQueue } from "../src/approval-queue.js";

/** What a request settled as, or "hung" if it hasn't within `ms`: a regression here must fail, not hang the run. */
const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r("hung"), ms))]);

/** A queue whose card is a log: what it showed and when it came down. */
function card() {
  const shown = [];
  const q = createApprovalQueue({ show: (r) => shown.push(r.summary), clear: () => shown.push("(clear)") });
  return { q, shown };
}

test("two askers at once: the card shows the oldest, then the next, and each gets its own answer", async () => {
  const { q, shown } = card();
  const chat = q.ask("Click Save", null);
  const app = q.ask("Type the total", null);
  assert.deepEqual(shown, ["Click Save"], "only the oldest is on the card");
  assert.equal(q.size(), 2);
  q.answer("allow");
  assert.equal(await chat, "allow");
  assert.deepEqual(shown, ["Click Save", "Type the total"]);
  q.answer("deny");
  assert.equal(await app, "deny");
  assert.deepEqual(shown, ["Click Save", "Type the total", "(clear)"]);
  assert.equal(q.answer("allow"), false, "an answer with nothing waiting changes nothing");
});

test("an asker that stops withdraws its request: the card moves on or comes down, and it hears deny", async () => {
  const { q, shown } = card();
  const stop = new AbortController();
  const chat = q.ask("Click Save", null, undefined, stop.signal);
  const app = q.ask("Type the total", null);
  stop.abort();
  assert.equal(await within(chat), "deny");
  assert.deepEqual(shown, ["Click Save", "Type the total"], "the next request is shown at once");
  q.answer("always");
  assert.equal(await within(app), "always", "the user's answer goes to the request they saw");

  const alone = new AbortController();
  const p = q.ask("Open Notepad", null, undefined, alone.signal);
  alone.abort();
  assert.equal(await within(p), "deny");
  assert.equal(shown.at(-1), "(clear)", "nothing left: the card comes down");
});

test("withdrawing a request that's still waiting leaves the card alone; an already stopped asker isn't shown at all", async () => {
  const { q, shown } = card();
  const later = new AbortController();
  const first = q.ask("Click Save", null);
  const second = q.ask("Type the total", null, undefined, later.signal);
  later.abort();
  assert.equal(await within(second), "deny");
  assert.deepEqual(shown, ["Click Save"]);
  q.answer("allow");
  assert.equal(await within(first), "allow");
  assert.deepEqual(shown, ["Click Save", "(clear)"], "the withdrawn one never appears");
  const gone = new AbortController();
  gone.abort();
  assert.equal(await q.ask("Delete it", null, undefined, gone.signal), "deny");
  assert.equal(shown.at(-1), "(clear)");
});

test("a stopped answer doesn't hang on its approval card", async () => {
  const { Brain } = await import("../src/brain.js");
  const { q } = card();
  const brain = new Brain({ point: async () => {}, status: () => {}, confirm: (s, b, n, signal) => q.ask(s, b, n, signal) });
  brain.abort = new AbortController();
  const asked = brain.runTool("launch_app", { name: "notepad" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(q.size(), 1, "the request is on the card");
  brain.cancel();
  const settled = await Promise.race([asked.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
  assert.equal(settled, "settled");
  assert.equal(q.size(), 0, "and it's off the card");
});
