import assert from "node:assert/strict";
import { test } from "node:test";
import { Brain, FAILURES, setBrainDefaults } from "../src/brain.js";

// A Brain wired to a fake UI. No request reaches the API or the desktop in these tests: every approval is declined.
function brain(confirm = async () => "deny") {
  const cards = [];
  const b = new Brain({
    apiKey: "sk-test",
    status() {},
    point: async () => {},
    confirm: async (...a) => (cards.push(a), confirm(...a)),
  });
  b.labels.set("@s1:e1", '"Search" (textfield)');
  b.bounds.set("@s1:e1", /** @type {any} */ ({ x: 10, y: 20, width: 200, height: 30 }));
  return { b, cards };
}

test("approval cards describe the real action, whatever Claude's summary says", () => {
  const { b } = brain();
  assert.equal(b.describeAction({ action: "type", ref: "@s1:e1", text: "hello", summary: "Click Save" }), 'Type "hello" into "Search" (textfield)');
  assert.equal(b.describeAction({ action: "set_value", ref: "@s1:e1", text: "42" }), 'Set "Search" (textfield) to "42"');
  assert.equal(b.describeAction({ action: "select", ref: "@s1:e1", text: "Blue" }), 'Choose "Blue" in "Search" (textfield)');
  assert.equal(b.describeAction({ action: "press", keys: "alt+f4" }), "Press alt+f4");
  assert.equal(b.describeAction({ action: "double_click", ref: "@s1:e1" }), 'Double-click "Search" (textfield)');
  assert.equal(b.describeAction({ action: "click", ref: "@s1:e9" }), "Click the highlighted control");
});

test("long text on a card is shortened, not hidden", () => {
  const { b } = brain();
  const summary = b.describeAction({ action: "type", ref: "@s1:e1", text: "x".repeat(500) });
  assert.ok(summary.length < 220);
  assert.match(summary, /…"/);
});

test("a declined action reports so, and the card pointed at the element with Claude's words as a note", async () => {
  const { b, cards } = brain();
  const result = await b.act({ action: "type", ref: "@s1:e1", text: "hello", summary: "Click Save" });
  assert.equal(result, "The user declined.");
  assert.deepEqual(cards.map((c) => c.slice(0, 3)), [['Type "hello" into "Search" (textfield)', { x: 10, y: 20, width: 200, height: 30 }, "Click Save"]]);
  assert.ok(cards[0][3] === undefined || cards[0][3] instanceof AbortSignal, "the asker's signal goes along, so a stopped answer withdraws its card");
});

test("moving windows and opening apps ask first", async () => {
  const { b, cards } = brain();
  assert.equal(await b.runTool("window", { action: "minimize", app: "WINWORD.EXE" }), "The user declined.");
  assert.equal(await b.runTool("launch_app", { name: "notepad" }), "The user declined.");
  assert.deepEqual(cards.map((c) => c[0]), ["Minimize WINWORD", "Open notepad"]);
});

test("each Brain reads and acts in its own agent-desktop session", () => {
  const a = brain().b;
  const c = brain().b;
  assert.notEqual(a.session, c.session);
  assert.match(a.session, /^buddy-\d+-\d+$/);
});

// A long conversation: twelve turns, each with an image, a tool call and 50k characters of tool output.
function longHistory(b) {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(200_000) } };
  for (let t = 0; t < 12; t++) {
    b.messages.push({ role: "user", content: [image, { type: "text", text: `question ${t}` }] });
    b.messages.push({ role: "assistant", content: [{ type: "tool_use", id: `tu${t}`, name: "read_page", input: {} }] });
    b.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu${t}`, content: "x".repeat(50_000) }] });
    b.messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${t}` }] });
  }
  b.messages.push({ role: "user", content: "the current question" });
}

test("history past its budget is trimmed into a valid conversation", () => {
  const { b } = brain();
  longHistory(b);
  const before = JSON.stringify(b.messages).length;
  b.fitHistory();
  assert.ok(JSON.stringify(b.messages).length < before / 5, "trimmed substantially");
  assert.equal(b.messages[0].role, "user", "starts with the user");
  assert.equal(b.messages.at(-1).content, "the current question", "the question in progress is kept");
  const used = new Set();
  for (const m of b.messages) {
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === "tool_use") used.add(block.id);
      if (block.type === "tool_result") assert.ok(used.has(block.tool_use_id), `orphan result ${block.tool_use_id}`);
    }
  }
  for (let i = 1; i < b.messages.length; i++) assert.notEqual(b.messages[i].role, b.messages[i - 1].role, `roles alternate at ${i}`);
});

test("history under budget is left exactly as it is (the prompt cache depends on it)", () => {
  const { b } = brain();
  b.messages.push({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "hi" }] });
  const before = JSON.stringify(b.messages);
  b.fitHistory();
  assert.equal(JSON.stringify(b.messages), before);
});

test("a cancelled answer leaves no tool call without a result", () => {
  const { b } = brain();
  b.messages.push({ role: "user", content: "do it" });
  b.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "act", input: {} }] });
  b.closeDanglingToolUse();
  assert.deepEqual(b.messages.at(-1), { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Cancelled by the user." }] });
});

test("model failures are told in words the user can act on", () => {
  assert.match(FAILURES.billing_error, /out of credit/);
  assert.match(FAILURES.billing_error, /console\.anthropic\.com/);
  for (const text of Object.values(FAILURES)) assert.doesNotMatch(text, /\b(4\d\d|5\d\d)\b|error/i, "no status codes or jargon");
});

test("Buddy answers through an OpenAI-style provider, and says its failures in that provider's words", async () => {
  setBrainDefaults({ model: "claude-opus-5-5", effort: "low", providerModels: { openai: "gpt-test" } });
  const realFetch = globalThis.fetch;
  const sent = [];
  const done = { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Click Data, then Sort." }] }] } };
  let reply = { status: 200, body: `data: ${JSON.stringify(done)}\n\n` };
  globalThis.fetch = async (url, init) => (sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization }), new Response(reply.body, { status: reply.status }));
  try {
    const b = new Brain({ apiKey: "sk-proj-test", provider: "openai", point: async () => {}, confirm: async () => "deny", status: () => {} });
    assert.equal(await b.run(null, "How do I sort?"), "Click Data, then Sort.");
    assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
    assert.equal(sent[0].body.model, "gpt-test");
    assert.equal(sent[0].auth, "Bearer sk-proj-test");
    assert.ok(sent[0].body.tools.some((t) => t.name === "point_at"), "Buddy's tools go along");
    reply = { status: 429, body: JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }) };
    const said = await b.run(null, "And filter?");
    assert.match(said, /OpenAI account is out of credit/);
    assert.match(said, /platform\.openai\.com/);
  } finally {
    globalThis.fetch = realFetch;
    setBrainDefaults({ model: "claude-opus-5-5", effort: "medium" });
  }
});
