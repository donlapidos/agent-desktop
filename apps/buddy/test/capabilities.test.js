import assert from "node:assert/strict";
import { test } from "node:test";
import { Brain, setBrainDefaults } from "../src/brain.js";
import { capsOf, chatTurn, describeModels, familyCaps, useCapsStore, verdict, withoutImages } from "../src/providers.js";

const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const LOCAL = "http://127.0.0.1:11434/v1";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (...chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
const said = (text) => sse({ choices: [{ delta: { content: text }, finish_reason: "stop" }] });
/** A fresh, empty store for each test, and what it saved. */
function freshStore() {
  const saved = [];
  useCapsStore({}, (entries) => saved.push(entries));
  return saved;
}

test("model families: what's known without asking", () => {
  assert.equal(verdict(familyCaps("anthropic", "claude-opus-5-5")), "good");
  assert.equal(verdict(familyCaps("openai", "gpt-6.1-sol")), "good");
  assert.equal(verdict(familyCaps("openai", "gpt-3.5-turbo")), "no_images");
  assert.equal(verdict(familyCaps("deepseek", "deepseek-chat")), "no_images");
  assert.equal(verdict(familyCaps("ollama", "qwen3:8b")), "unknown", "a local model's abilities aren't guessed from a bare name");
  assert.deepEqual(familyCaps("ollama", "qwen2.5vl:7b"), { tools: null, vision: true });
  assert.equal(verdict({ tools: false, vision: true }), "no_tools", "no tools outweighs everything");
});

test("Ollama, LM Studio and OpenRouter say what their models can do, and Buddy remembers", async () => {
  const saved = freshStore();
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/show")) {
      const { model } = JSON.parse(init.body);
      return json({ capabilities: { "qwen3:8b": ["completion", "tools", "thinking"], "gemma3:4b": ["completion", "vision"], "qwen2.5vl:7b": ["completion", "vision", "tools"] }[model] });
    }
    if (u.endsWith("/api/v0/models")) return json({ data: [{ id: "qwen2-vl-7b", type: "vlm", capabilities: ["tool_use"] }, { id: "phi-4", type: "llm" }] });
    if (u.endsWith("/models")) return json({ data: [{ id: "x/model", architecture: { input_modalities: ["text"] }, supported_parameters: ["tools", "temperature"] }] });
    return json({}, 404);
  };
  await describeModels("ollama", "", ["qwen3:8b", "gemma3:4b", "qwen2.5vl:7b"], { baseURL: LOCAL, fetchImpl });
  assert.equal(verdict(capsOf("ollama", LOCAL, "qwen3:8b")), "no_images");
  assert.equal(verdict(capsOf("ollama", LOCAL, "gemma3:4b")), "no_tools", "what the server reports beats the name");
  assert.equal(verdict(capsOf("ollama", LOCAL, "qwen2.5vl:7b")), "good");
  await describeModels("lmstudio", "", ["qwen2-vl-7b", "phi-4"], { baseURL: "http://localhost:1234/v1", fetchImpl });
  assert.equal(verdict(capsOf("lmstudio", "http://localhost:1234/v1", "qwen2-vl-7b")), "good");
  assert.deepEqual(capsOf("lmstudio", "http://localhost:1234/v1", "phi-4"), { tools: null, vision: false });
  await describeModels("openrouter", "k", ["x/model"], { fetchImpl });
  assert.equal(verdict(capsOf("openrouter", "https://openrouter.ai/api/v1", "x/model")), "no_images");
  assert.ok(saved.length > 0, "learned abilities are handed over to be saved");
  useCapsStore(saved.at(-1), () => {});
  assert.equal(verdict(capsOf("ollama", LOCAL, "gemma3:4b")), "no_tools", "and come back after a restart");
});

test("a model that refuses images is remembered as blind; the turn goes on without them", async () => {
  freshStore();
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const withImage = JSON.stringify(body.messages).includes("image_url");
    return withImage ? json({ error: { message: "Model does not support images. Please use a model that does." } }, 400) : said("I read the window instead.");
  };
  const turn = { provider: /** @type {const} */ ("lmstudio"), baseURL: "http://localhost:1234/v1", key: "", model: "phi-4", effort: "low", system: "s", tools: [], messages: [{ role: "user", content: [png, { type: "text", text: "What's this?" }] }], maxTokens: 50, fetchImpl };
  const reply = await chatTurn(turn);
  assert.deepEqual(reply.content, [{ type: "text", text: "I read the window instead." }]);
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1].messages), /can't see images/);
  assert.equal(capsOf("lmstudio", "http://localhost:1234/v1", "phi-4").vision, false);
  await chatTurn(turn);
  assert.equal(bodies.length, 3, "next time the images are left out up front");
});

test("a model that refuses tools says so, and isn't confused with a refused setting", async () => {
  freshStore();
  const noTools = async () => json({ error: { message: "registry.ollama.ai/library/gemma3:4b does not support tools" } }, 400);
  const turn = { provider: /** @type {const} */ ("ollama"), baseURL: LOCAL, key: "", model: "gemma3:4b", effort: "low", system: "s", tools: [{ name: "look", description: "Look", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }], maxTokens: 50 };
  await assert.rejects(chatTurn({ ...turn, fetchImpl: noTools }), (e) => e.kind === "no_tools");
  assert.equal(capsOf("ollama", LOCAL, "gemma3:4b").tools, false);
  freshStore();
  let calls = 0;
  const reasoning = async () => (++calls === 1 ? json({ error: { message: "Function tools with reasoning_effort are not supported for this model." } }, 400) : said("ok"));
  assert.deepEqual((await chatTurn({ ...turn, model: "other", fetchImpl: reasoning })).content, [{ type: "text", text: "ok" }]);
  assert.notEqual(capsOf("ollama", LOCAL, "other").tools, false, "a refused setting doesn't mark the model as tool-less");
  // The same refusal after the setting is gone (the model reasons by default): an error, still not "no tools".
  const always = async () => json({ error: { message: "Function tools with reasoning_effort are not supported for this model." } }, 400);
  await assert.rejects(chatTurn({ ...turn, model: "thinker", fetchImpl: always }), (e) => e.kind !== "no_tools");
  assert.notEqual(capsOf("ollama", LOCAL, "thinker").tools, false);
});

test("the conversation without images keeps everything else", () => {
  const out = withoutImages([
    { role: "user", content: [png, { type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [png] }] },
    { role: "user", content: "plain" },
  ]);
  assert.deepEqual(out[0].content[1], { type: "text", text: "hi" });
  assert.match(out[0].content[0].text, /can't see images/);
  assert.match(out[1].content[0].content[0].text, /look or read_page/);
  assert.equal(out[2].content, "plain");
});

test("Buddy works blind without a screenshot tool, and won't start with a model that can't use tools", async () => {
  const saved = freshStore();
  void saved;
  setBrainDefaults({ model: "claude-opus-5-5", effort: "low", providerModels: { ollama: "qwen3:8b" } });
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => (sent.push(JSON.parse(init.body)), said("Click Data."));
  try {
    const ui = { apiKey: "", provider: /** @type {const} */ ("ollama"), baseURL: LOCAL, point: async () => {}, confirm: async () => "deny", status: () => {} };
    useCapsStore({ [`${LOCAL}|qwen3:8b`]: { tools: true, vision: false } }, () => {});
    assert.equal(await new Brain(ui).run(null, "How do I sort?"), "Click Data.");
    assert.ok(!sent[0].tools.some((t) => t.function.name === "screenshot"), "no screenshot tool for a blind model");
    assert.match(sent[0].messages[0].content, /can't see images/);
    useCapsStore({ [`${LOCAL}|qwen3:8b`]: { tools: false } }, () => {});
    const reply = await new Brain(ui).run(null, "How do I sort?");
    assert.match(reply, /can't use tools/);
    assert.equal(sent.length, 1, "no call is made for a model known to lack tools");
  } finally {
    globalThis.fetch = realFetch;
    setBrainDefaults({ model: "claude-opus-5-5", effort: "medium" });
    useCapsStore({}, () => {});
  }
});
