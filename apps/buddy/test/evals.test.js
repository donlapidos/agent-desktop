import assert from "node:assert/strict";
import { test } from "node:test";
import { setBrainDefaults } from "../src/brain.js";
import { CASES, runEvals } from "../src/evals.js";
import { useCapsStore } from "../src/providers.js";

const URL = "http://127.0.0.1:9/v1";
const call = (name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
const text = (t) => ({ choices: [{ delta: { content: t }, finish_reason: "stop" }] });
const sse = (chunk) => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
const refOf = (tree, name) => {
  let found = null;
  const walk = (n) => {
    if (n.name === name && n.ref_id) found ??= n.ref_id;
    for (const k of n.children ?? []) walk(k);
  };
  walk(tree);
  return found;
};

/** A model that plays each case's turns from a script: one reply per call, in order. */
async function withScript(script, run) {
  setBrainDefaults({ model: "claude-opus-5-5", effort: "low", providerModels: { custom: "scripted" } });
  useCapsStore({}, () => {});
  const realFetch = globalThis.fetch;
  const sent = [];
  let i = 0;
  globalThis.fetch = async (_url, init) => (sent.push(JSON.parse(init.body)), sse(script[i++] ?? text("Done.")));
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = realFetch;
    setBrainDefaults({ model: "claude-opus-5-5", effort: "medium" });
  }
}

const one = (id) => CASES.filter((c) => c.id === id);

test("a model that guides the right route passes, with the window already in its first message", async () => {
  await withScript(
    [call("guide_steps", { steps: [{ caption: "Open Data", target: "Data", done_when: ["Sort"] }, { caption: "Sort largest first", target: "Sort Largest to Smallest", done_when: [] }] }), text("Sorted, largest first.")],
    async (sent) => {
      const run = await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("excel-sort") });
      assert.equal(run.passed, 1, run.results[0].problem ?? "");
      assert.equal(run.results[0].turns, 2);
      assert.match(sent[0].messages.at(-1).content, /Sort & Filter/, "the case's window is what the model sees");
    },
  );
});

test("a wrong route fails and says what was shown; acting when asked how fails too", async () => {
  const excel = CASES.find((c) => c.id === "excel-sort").window;
  await withScript([call("point_at", { ref: refOf(excel, "Insert"), caption: "Click Insert" }), text("There.")], async () => {
    const run = await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("excel-sort") });
    assert.equal(run.passed, 0);
    assert.match(run.results[0].problem, /"insert"/);
  });
  await withScript([call("act", { action: "click", ref: refOf(excel, "Data") }), call("point_at", { ref: refOf(excel, "Sort & Filter"), caption: "Sort" }), text("Done.")], async () => {
    const run = await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("excel-sort") });
    assert.match(run.results[0].problem ?? "", /acted when the user only asked how/);
  });
});

test("doing it when asked passes by clicking Bold or pressing Ctrl+B; a shortcut in words passes where one exists", async () => {
  const word = CASES.find((c) => c.id === "word-bold-do").window;
  await withScript([call("act", { action: "click", ref: refOf(word, "Bold") }), text("Bolded.")], async () => {
    assert.equal((await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("word-bold-do") })).passed, 1);
  });
  await withScript([call("act", { action: "press", keys: "ctrl+b" }), text("Bolded.")], async () => {
    assert.equal((await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("word-bold-do") })).passed, 1);
  });
  await withScript([text("Press Ctrl + Shift + N to make a new folder.")], async () => {
    assert.equal((await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("explorer-folder") })).passed, 1);
  });
});

test("every case's window renders, and each case is told apart from the others by its check", () => {
  const ids = new Set(CASES.map((c) => c.id));
  assert.equal(ids.size, CASES.length);
  for (const c of CASES) assert.notEqual(c.check([], ""), null, `${c.id}: doing nothing doesn't pass`);
});

test("the file task passes when the list is written with everything on it", async () => {
  await withScript([call("write_file", { path: "Shopping list.txt", content: "- Eggs\n- Milk\n- Bread\n" }), text("Saved your list.")], async (sent) => {
    const run = await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("shopping-file") });
    assert.equal(run.passed, 1, run.results[0].problem ?? "");
    assert.ok(sent[0].tools.some((t) => t.function.name === "write_file"), "the model is offered the PC tools");
  });
  await withScript([call("write_file", { path: "list.txt", content: "eggs, milk" }), text("Saved.")], async () => {
    const run = await runEvals({ provider: "custom", apiKey: "", baseURL: URL, cases: one("shopping-file") });
    assert.match(run.results[0].problem ?? "", /missing bread/);
  });
});
