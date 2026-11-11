import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, chatModels, chatTurn, foldChunks, fromChat, fromResponses, keyFits, listModels, providerForKey, toChatMessages, toChatTools, toResponsesInput } from "../src/providers.js";

const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

test("a pasted key goes to the provider it belongs to", () => {
  assert.equal(providerForKey("sk-ant-api03-abcdefghijklmnopqrstuv", "openai"), "anthropic");
  assert.equal(providerForKey("sk-proj-abcdefghijklmnopqrstuvwxyz", "anthropic"), "openai");
  assert.equal(providerForKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz", "anthropic"), "openrouter");
  assert.equal(providerForKey("AIzaSyabcdefghijklmnopqrstuvwxyz", "openai"), "gemini");
  assert.equal(providerForKey("sk-abcdefghijklmnopqrstuvwxyz0123", "deepseek"), "deepseek", "a plain sk- key stays with DeepSeek when that's chosen");
  assert.equal(providerForKey("sk-abcdefghijklmnopqrstuvwxyz0123", "anthropic"), "openai", "and is taken as OpenAI's otherwise");
  assert.ok(keyFits("openai", "sk-abcdefghijklmnopqrstuvwxyz0123"));
  assert.ok(!keyFits("anthropic", "sk-proj-abcdefghijklmnopqrstuvwxyz"), "another provider's key is refused");
  assert.ok(!keyFits("openai", "sk-ant-api03-abcdefghijklmnopqrstuv"));
  assert.ok(!keyFits("openai", "sk-short"));
  assert.ok(!keyFits("openai", "sk-has spaces in it and is long enough"));
});

test("OpenAI's model list is narrowed to chat models, newest flagship first", () => {
  const ids = ["whisper-1", "text-embedding-3-large", "gpt-4o", "gpt-5.1-mini", "gpt-5.1", "gpt-5", "gpt-5-2025-08-07", "o3", "gpt-realtime", "dall-e-3", "gpt-4o-mini-tts", "gpt-5-pro", "omni-moderation-latest"];
  const models = chatModels("openai", ids);
  assert.equal(models[0], "gpt-5.1");
  assert.ok(models.indexOf("gpt-5") < models.indexOf("gpt-5-pro"), "pro and dated snapshots come after the flagship");
  for (const gone of ["whisper-1", "text-embedding-3-large", "gpt-realtime", "dall-e-3", "gpt-4o-mini-tts", "omni-moderation-latest"]) assert.ok(!models.includes(gone), gone);
});

test("Buddy's conversation converts to Chat Completions, screenshots included", () => {
  const messages = [
    { role: "user", content: [png, { type: "text", text: "How do I sort this?" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "look", input: {} }, { type: "tool_use", id: "t2", name: "screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "window tree" }, { type: "tool_result", tool_use_id: "t2", content: [png] }] },
  ];
  const out = toChatMessages("be Buddy", messages);
  assert.deepEqual(out[0], { role: "system", content: "be Buddy" });
  assert.deepEqual(out[1], { role: "user", content: [{ type: "text", text: "How do I sort this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] });
  assert.deepEqual(out[2], {
    role: "assistant",
    content: "Let me look.",
    tool_calls: [
      { id: "t1", type: "function", function: { name: "look", arguments: "{}" } },
      { id: "t2", type: "function", function: { name: "screenshot", arguments: "{}" } },
    ],
  });
  assert.deepEqual(out[3], { role: "tool", tool_call_id: "t1", content: "window tree" });
  assert.deepEqual(out[4], { role: "tool", tool_call_id: "t2", content: "(screenshot below)" });
  assert.deepEqual(out[5], { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }, "the screenshot follows the tool messages");
  assert.equal(out.length, 6);
  assert.deepEqual(toChatTools([{ name: "look", description: "Look", input_schema: { type: "object", properties: {} } }]), [
    { type: "function", function: { name: "look", description: "Look", parameters: { type: "object", properties: {} } } },
  ]);
});

test("a streamed reply with tool calls comes back as Buddy's blocks", () => {
  const { message, finish, usage } = foldChunks([
    { choices: [{ delta: { content: "On " } }] },
    { choices: [{ delta: { content: "it.", tool_calls: [{ index: 0, id: "call_a", function: { name: "point_at", arguments: '{"ref":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"@s1:e2"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 900, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } },
  ]);
  const reply = fromChat(message, finish, usage);
  assert.deepEqual(reply.content, [{ type: "text", text: "On it." }, { type: "tool_use", id: "call_a", name: "point_at", input: { ref: "@s1:e2" } }]);
  assert.equal(reply.stop_reason, "tool_use");
  assert.deepEqual(reply.usage, { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 800 });
  assert.equal(fromChat({ content: "Hi" }, "length").stop_reason, "max_tokens");
});

const sse = (...chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });

test("a setting the model refuses is dropped and the turn retried", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ("reasoning_effort" in body) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } }), { status: 400 });
    return sse({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] });
  };
  const turn = { provider: /** @type {const} */ ("deepseek"), key: "k", model: "deepseek-test", effort: "low", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, fetchImpl };
  const reply = await chatTurn(turn);
  assert.deepEqual(reply.content, [{ type: "text", text: "Hello" }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 100);
  await chatTurn(turn);
  assert.equal(bodies.length, 3, "remembered for that model: no second refusal");
});

test("provider failures are sorted into kinds Buddy can explain", async () => {
  const fail = (status, error) => async () => new Response(JSON.stringify({ error }), { status });
  const kind = (status, error) =>
    chatTurn({ provider: "openrouter", key: "k", model: "m", effort: "low", system: "", tools: [], messages: [], maxTokens: 1, fetchImpl: fail(status, error) }).then(
      () => null,
      (e) => (assert.ok(e instanceof ProviderError), e.kind),
    );
  assert.equal(await kind(401, { message: "Incorrect API key provided" }), "authentication_failed");
  assert.equal(await kind(429, { message: "You exceeded your current quota", code: "insufficient_quota" }), "billing_error");
  assert.equal(await kind(429, { message: "Rate limit reached" }), "rate_limit");
  assert.equal(await kind(404, { message: "The model `m` does not exist" }), "model_not_found");
  assert.equal(await kind(500, { message: "oops" }), "server_error");
  await assert.rejects(listModels("openai", "bad", fail(401, { message: "Incorrect API key" })), (e) => e.kind === "authentication_failed");
});

const events = (...list) => new Response(list.map((e) => `event: ${e.type}
data: ${JSON.stringify(e)}

`).join(""), { status: 200 });

test("OpenAI is called through Responses, where its models reason and use tools together", async () => {
  const sent = [];
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAA" };
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return events(
      { type: "response.output_text.delta", delta: "Opening" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [reasoning, { type: "message", content: [{ type: "output_text", text: "Opening the Data tab." }] }, { type: "function_call", call_id: "call_9", name: "point_at", arguments: '{"ref":"@s1:e4"}' }],
          usage: { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 1000 } },
        },
      },
    );
  };
  const reply = await chatTurn({ provider: "openai", key: "k", model: "gpt-6.1-sol", effort: "medium", system: "be Buddy", tools: [{ name: "point_at", description: "Point", input_schema: { type: "object" } }], messages: [{ role: "user", content: "Sort it" }], maxTokens: 500, fetchImpl });
  assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
  const body = sent[0].body;
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.store, false, "OpenAI keeps nothing");
  assert.equal(body.instructions, "be Buddy");
  assert.deepEqual(body.tools, [{ type: "function", name: "point_at", description: "Point", parameters: { type: "object" } }]);
  assert.deepEqual(reply.content, [
    { type: "openai_reasoning", item: reasoning },
    { type: "text", text: "Opening the Data tab." },
    { type: "tool_use", id: "call_9", name: "point_at", input: { ref: "@s1:e4" } },
  ]);
  assert.equal(reply.stop_reason, "tool_use");
  assert.deepEqual(reply.usage, { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1000 });
});

test("the next Responses turn hands back the reasoning, the calls and their results, screenshots after", () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAA" };
  const input = toResponsesInput([
    { role: "user", content: [png, { type: "text", text: "Sort it" }] },
    { role: "assistant", content: [{ type: "openai_reasoning", item: reasoning }, { type: "text", text: "Looking." }, { type: "tool_use", id: "c1", name: "screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [png] }] },
  ]);
  assert.deepEqual(input, [
    { role: "user", content: [{ type: "input_text", text: "Sort it" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] },
    reasoning,
    { role: "assistant", content: "Looking." },
    { type: "function_call", call_id: "c1", name: "screenshot", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "(screenshot below)" },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] },
  ]);
  assert.equal(fromResponses({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }).stop_reason, "max_tokens");
  assert.equal(fromResponses({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }).stop_reason, "refusal");
});

test("a Responses reply that fails mid-stream is reported, out of credit included", async () => {
  const fetchImpl = async () => events({ type: "response.failed", response: { error: { code: "insufficient_quota", message: "You exceeded your current quota." } } });
  await assert.rejects(
    chatTurn({ provider: "openai", key: "k", model: "m", effort: "low", system: "", tools: [], messages: [], maxTokens: 1, fetchImpl }),
    (e) => e instanceof ProviderError && e.kind === "billing_error",
  );
});

test("addresses: https anywhere, plain http only on this PC or the local network", async () => {
  const { addressProblem } = await import("../src/providers.js");
  for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://192.168.1.20:8000/v1", "http://10.0.0.5/v1", "http://[::1]:8080/v1", "http://gpu-box.local:8000/v1", "https://llm.example.com/v1"]) assert.equal(addressProblem(ok), null, ok);
  assert.match(addressProblem("http://llm.example.com/v1"), /https/);
  assert.match(addressProblem("ftp://localhost/v1"), /http/);
  assert.match(addressProblem("localhost:11434"), /http|address/);
  assert.match(addressProblem("not a url"), /address/);
});

// A stand-in for Ollama's OpenAI-compatible API (GET /v1/models, streamed POST /v1/chat/completions), over real HTTP.
async function fakeOllama(handle) {
  const http = await import("node:http");
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b", object: "model", owned_by: "library" }, { id: "nomic-embed-text:latest", object: "model" }, { id: "gemma3:4b", object: "model" }] }));
    }
    handle(req, res, seen.at(-1).body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => server.close(r)) };
}

test("Ollama and LM Studio: no key, the models installed in the server's order, tool calls streamed back", async () => {
  const server = await fakeOllama((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    const chunk = (c) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "qwen3:8b", choices: [c] })}\n\n`);
    chunk({ index: 0, delta: { role: "assistant", content: "" } });
    chunk({ index: 0, delta: { tool_calls: [{ id: "call_x", index: 0, type: "function", function: { name: "look", arguments: "{}" } }] } });
    chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
    res.end("data: [DONE]\n\n");
  });
  try {
    assert.deepEqual(await listModels("ollama", "", { baseURL: server.url }), ["qwen3:8b", "gemma3:4b"], "embeddings left out; order kept");
    const reply = await chatTurn({ provider: "ollama", baseURL: server.url, key: "", model: "qwen3:8b", effort: "low", system: "s", tools: [{ name: "look", description: "Look", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.deepEqual(reply.content, [{ type: "tool_use", id: "call_x", name: "look", input: {} }]);
    assert.equal(server.seen.every((r) => r.auth === undefined), true, "no Authorization header without a key");
    assert.equal(server.seen.at(-1).url, "/v1/chat/completions");
  } finally {
    await server.close();
  }
});

test("Ollama not running, or a server out of reach, is told apart from a refusal", async () => {
  const server = await fakeOllama(() => {});
  const url = server.url;
  await server.close();
  await assert.rejects(listModels("ollama", "", { baseURL: url }), (e) => e instanceof ProviderError && e.kind === "not_running");
  await assert.rejects(
    chatTurn({ provider: "custom", baseURL: url, key: "", model: "m", effort: "low", system: "", tools: [], messages: [], maxTokens: 1 }),
    (e) => e instanceof ProviderError && e.kind === "unreachable",
  );
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(chatTurn({ provider: "custom", baseURL: url, key: "", model: "m", effort: "low", system: "", tools: [], messages: [], maxTokens: 1, signal: ctl.signal }), (e) => e.name === "AbortError", "a cancel stays a cancel");
});

test("a key for another server stays with that server, even one shaped like OpenAI's", () => {
  assert.equal(providerForKey("sk-proj-abcdefghijklmnopqrstuvwxyz", "custom"), "custom");
});
