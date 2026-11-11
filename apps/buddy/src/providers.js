// Which AI provider Buddy thinks with. Anthropic is called through its own SDK (brain.js), OpenAI through its
// Responses API, and the rest through Chat Completions, which they all speak. Buddy's conversation stays in
// Anthropic's message format (text, image, tool_use and tool_result blocks); it is converted on the way out and the
// reply converted back, so history, trimming and tools work the same whichever provider answers.

/**
 * @typedef {"anthropic" | "openai" | "openrouter" | "gemini" | "deepseek" | "ollama" | "lmstudio" | "custom"} ProviderId
 * @typedef {{ id: ProviderId, label: string, note: string, baseURL?: string, keyFrom: string, keyEnv?: string, placeholder: string, prefix?: RegExp, loose?: boolean, key: "required" | "none" | "optional", local?: boolean }} Provider
 * prefix: how this provider's keys start (or, with loose, how some of them do: other sk- keys may be theirs too).
 * key: whether it needs one. local: it runs on this PC, so a refused connection means it isn't running.
 */

/** @type {Readonly<Record<ProviderId, Provider>>} */
export const PROVIDERS = Object.freeze({
  anthropic: { id: "anthropic", label: "Anthropic", note: "Claude models.", keyFrom: "console.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…", prefix: /^sk-ant-/, key: "required" },
  openai: { id: "openai", label: "OpenAI", note: "GPT models.", baseURL: "https://api.openai.com/v1", keyFrom: "platform.openai.com", keyEnv: "OPENAI_API_KEY", placeholder: "sk-…", prefix: /^sk-(proj|svcacct|admin)-/, loose: true, key: "required" },
  openrouter: { id: "openrouter", label: "OpenRouter", note: "One key for hundreds of models.", baseURL: "https://openrouter.ai/api/v1", keyFrom: "openrouter.ai/keys", keyEnv: "OPENROUTER_API_KEY", placeholder: "sk-or-…", prefix: /^sk-or-/, key: "required" },
  gemini: { id: "gemini", label: "Google Gemini", note: "Gemini models; Google AI Studio has a free tier.", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyFrom: "aistudio.google.com", keyEnv: "GEMINI_API_KEY", placeholder: "AIza…", prefix: /^AIza/, key: "required" },
  deepseek: { id: "deepseek", label: "DeepSeek", note: "DeepSeek models.", baseURL: "https://api.deepseek.com/v1", keyFrom: "platform.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", placeholder: "sk-…", loose: true, key: "required" },
  ollama: { id: "ollama", label: "Ollama", note: "Models on this PC. Free and private; no key.", baseURL: "http://localhost:11434/v1", keyFrom: "ollama.com", placeholder: "", key: "none", local: true },
  lmstudio: { id: "lmstudio", label: "LM Studio", note: "Models on this PC. Free and private; no key.", baseURL: "http://localhost:1234/v1", keyFrom: "lmstudio.ai", placeholder: "", key: "none", local: true },
  custom: { id: "custom", label: "Other server", note: "Any OpenAI-compatible server, at an address you give.", keyFrom: "the server's owner", placeholder: "Key, if the server needs one", loose: true, key: "optional" },
});
export const PROVIDER_IDS = /** @type {ProviderId[]} */ (Object.keys(PROVIDERS));

/**
 * Whether `url` is an address Buddy may send requests (and a key) to: https anywhere, or plain http only on this PC
 * or the local network, where servers like Ollama listen without TLS. Returns a problem in words, or null.
 */
export function addressProblem(/** @type {string} */ url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "That isn't a web address. It looks like http://localhost:11434/v1.";
  }
  if (u.protocol === "https:") return null;
  if (u.protocol !== "http:") return "The address has to start with http:// or https://.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const nearby = host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  return nearby ? null : "Use https:// for a server outside this PC and your local network, so your questions travel encrypted.";
}

/** The provider a key unmistakably belongs to, from its prefix, or null (a plain sk- key could be OpenAI or DeepSeek). */
export function providerOfKey(/** @type {string} */ key) {
  return PROVIDER_IDS.find((id) => PROVIDERS[id].prefix?.test(key)) ?? null;
}

/**
 * The provider to save a pasted key for: the one it unmistakably belongs to; else the chosen provider, if its keys
 * can look like this; else OpenAI, whose keys most plain sk- keys are.
 * @param {string} key @param {ProviderId} chosen @returns {ProviderId}
 */
export function providerForKey(key, chosen) {
  if (PROVIDERS[chosen].key === "optional") return chosen;
  return providerOfKey(key) ?? (PROVIDERS[chosen].loose || !PROVIDERS[chosen].prefix ? chosen : "openai");
}

/** Whether `key` could be a key for `id`: the right shape, and not obviously another provider's. */
export function keyFits(/** @type {ProviderId} */ id, /** @type {string} */ key) {
  if (!/^[A-Za-z0-9_.-]{20,300}$/.test(key)) return false;
  const owner = providerOfKey(key);
  return owner ? owner === id : !PROVIDERS[id].prefix || !!PROVIDERS[id].loose;
}

// ---------- Models ----------

// Models that can't hold a conversation with tools and images, by id.
const NOT_CHAT = /(embed|whisper|tts|transcribe|audio|realtime|dall-e|image|moderation|search|davinci|babbage|instruct|codex|computer-use|sora)/i;

/** Chat models from a provider's /models list, best first: newest version of the main family, then the rest. */
export function chatModels(/** @type {ProviderId} */ provider, /** @type {string[]} */ ids) {
  const usable = [...new Set(ids)].filter((id) => !NOT_CHAT.test(id));
  // Models people installed themselves (Ollama, LM Studio, their own server) keep the server's order: version
  // numbers there say nothing about which is best.
  if (provider === "ollama" || provider === "lmstudio" || provider === "custom") return usable;
  const list = provider === "openai" ? usable.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id)) : usable;
  return list.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
}

// Higher is better: a family's flagship (gpt-5.1) above its variants (gpt-5.1-mini), newer versions above older,
// dated snapshots below their alias.
function rank(/** @type {string} */ id) {
  const version = Number(id.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const variant = /(mini|nano|lite|flash|small|pro|deep-research|chat-latest|preview|\d{4}-\d{2}-\d{2})/i.test(id) ? 0 : 1;
  return version * 10 + variant * 5;
}

const authHeaders = (/** @type {string} */ key) => (key ? { authorization: `Bearer ${key}` } : {});

/**
 * The provider's chat models for this key, best first. Throws a ProviderError if the key is refused or the server
 * can't be reached. `baseURL` is for providers at an address the user gave.
 */
export async function listModels(/** @type {ProviderId} */ provider, /** @type {string} */ key, { baseURL = PROVIDERS[provider].baseURL, fetchImpl = fetch } = {}) {
  const res = await reach(provider, () => fetchImpl(`${baseURL}/models`, { headers: authHeaders(key), signal: AbortSignal.timeout(15_000) }));
  if (!res.ok) throw await providerError(res);
  const body = await res.json();
  return chatModels(provider, (body.data ?? []).map((m) => String(m.id).replace(/^models\//, "")));
}

// ---------- Errors ----------

/** A failed call, sorted into one of brain.js FAILURES' kinds. */
export class ProviderError extends Error {
  /** @param {string} kind @param {number} status @param {string} message */
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** A request that couldn't reach the server at all, as a ProviderError: not running (on this PC) or unreachable. */
async function reach(/** @type {ProviderId} */ provider, /** @type {() => Promise<Response>} */ send) {
  try {
    return await send();
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ProviderError(PROVIDERS[provider].local ? "not_running" : "unreachable", 0, String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err));
  }
}

async function providerError(/** @type {Response} */ res) {
  let text = "";
  try {
    text = await res.text();
  } catch {}
  let message = text;
  try {
    const e = JSON.parse(text);
    message = (Array.isArray(e) ? e[0] : e)?.error?.message ?? text;
  } catch {}
  const s = res.status;
  const kind =
    s === 401 || s === 403 ? "authentication_failed"
    : s === 402 || /insufficient_quota|quota|credit|balance|billing/i.test(text) ? "billing_error"
    : s === 404 || /model_not_found|does not exist|not found/i.test(text) ? "model_not_found"
    : s === 429 ? "rate_limit"
    : s === 503 || s === 529 ? "overloaded"
    : s >= 500 ? "server_error"
    : "invalid_request";
  return new ProviderError(kind, s, String(message).slice(0, 500));
}

// ---------- Anthropic format -> Chat Completions ----------

const dataUrl = (b) => `data:${b.source.media_type};base64,${b.source.data}`;
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const imagesOf = (content) => (Array.isArray(content) ? content.filter((b) => b.type === "image" && b.source?.type === "base64") : []);

/**
 * Buddy's conversation as Chat Completions messages. Tool results become "tool" messages; screenshots in them (which
 * tool messages can't carry) follow in one user message, so the model still sees them.
 * @param {string} system @param {any[]} messages
 */
export function toChatMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use");
      const text = textOf(blocks);
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) } : {}),
      });
      continue;
    }
    const images = [];
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const said = textOf(b.content);
      const seen = imagesOf(b.content);
      images.push(...seen);
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: said || (seen.length ? "(screenshot below)" : "Done.") });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source?.type === "base64") images.push(b);
    }
    for (const b of images) parts.push({ type: "image_url", image_url: { url: dataUrl(b) } });
    if (parts.length) out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
  }
  return out;
}

/** Buddy's tools as Chat Completions functions. */
export const toChatTools = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

/**
 * The request body for one turn. `drop` names optional fields the provider has refused before (see chatTurn).
 * @param {{ provider: ProviderId, model: string, effort: string, system: string, tools: any[], messages: any[], maxTokens: number, drop?: Set<string> }} o
 */
export function chatRequest({ provider, model, effort, system, tools, messages, maxTokens, drop = new Set() }) {
  /** @type {Record<string, unknown>} */
  const body = { model, messages: toChatMessages(system, messages), tools: toChatTools(tools), stream: true };
  const tokens = provider === "openai" ? "max_completion_tokens" : "max_tokens";
  if (!drop.has(tokens)) body[tokens] = maxTokens;
  if (!drop.has("reasoning_effort")) body.reasoning_effort = effort;
  if (!drop.has("stream_options")) body.stream_options = { include_usage: true };
  return body;
}

// ---------- Chat Completions -> Anthropic format ----------

const STOP = { tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal", stop: "end_turn" };

/**
 * A finished Chat Completions message as the Anthropic-shaped reply brain.js works with.
 * @param {{ content?: string | null, tool_calls?: any[] }} message @param {string | null} finish @param {any} [usage]
 */
export function fromChat(message, finish, usage) {
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const c of message.tool_calls ?? []) {
    let input = {};
    try {
      input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  const stop = message.tool_calls?.length ? "tool_use" : (STOP[finish ?? "stop"] ?? "end_turn");
  return {
    content,
    stop_reason: stop,
    usage: { input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens, cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens },
  };
}

/** Folds a streamed reply's chunks into one message, as the non-streamed API would have returned it. */
export function foldChunks(/** @type {any[]} */ chunks) {
  const message = { content: "", tool_calls: /** @type {any[]} */ ([]) };
  let finish = null;
  let usage = null;
  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? {};
      if (d.content) message.content += d.content;
      for (const t of d.tool_calls ?? []) {
        const i = t.index ?? message.tool_calls.length;
        message.tool_calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        const call = message.tool_calls[i];
        if (t.id) call.id = t.id;
        if (t.function?.name) call.function.name += t.function.name;
        if (t.function?.arguments) call.function.arguments += t.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  message.tool_calls = message.tool_calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return { message, finish, usage };
}

// ---------- Anthropic format <-> OpenAI Responses ----------
// OpenAI itself is called through its Responses API: its newest models reason and use tools together only there.
// Reasoning comes back encrypted (store: false, so OpenAI keeps nothing) and stays in Buddy's history as an
// "openai_reasoning" block, handed back next turn so the model keeps its train of thought between tool calls.

/** Buddy's conversation as Responses input items. @param {any[]} messages */
export function toResponsesInput(messages) {
  const out = [];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "assistant") {
      for (const b of blocks) {
        if (b.type === "openai_reasoning") out.push(b.item);
        else if (b.type === "text" && b.text) out.push({ role: "assistant", content: b.text });
        else if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    const images = [];
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const said = textOf(b.content);
      const seen = imagesOf(b.content);
      images.push(...seen);
      out.push({ type: "function_call_output", call_id: b.tool_use_id, output: said || (seen.length ? "(screenshot below)" : "Done.") });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) parts.push({ type: "input_text", text: b.text });
      else if (b.type === "image" && b.source?.type === "base64") images.push(b);
    }
    for (const b of images) parts.push({ type: "input_image", image_url: dataUrl(b) });
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

/** @param {{ model: string, effort: string, system: string, tools: any[], messages: any[], maxTokens: number, drop?: Set<string> }} o */
export function responsesRequest({ model, effort, system, tools, messages, maxTokens, drop = new Set() }) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    instructions: system,
    input: toResponsesInput(messages),
    tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema })),
    store: false,
    stream: true,
  };
  if (!drop.has("max_output_tokens")) body.max_output_tokens = maxTokens;
  if (!drop.has("reasoning")) {
    body.reasoning = { effort };
    body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

/** A finished Responses reply as the Anthropic-shaped reply brain.js works with. @param {any} response */
export function fromResponses(response) {
  const content = [];
  let refusal = false;
  for (const item of response.output ?? []) {
    if (item.type === "reasoning") content.push({ type: "openai_reasoning", item });
    else if (item.type === "function_call") {
      let input = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {}
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    } else if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
        if (part.type === "refusal") refusal = true;
      }
    }
  }
  const stop = content.some((b) => b.type === "tool_use") ? "tool_use"
    : refusal ? "refusal"
    : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens" ? "max_tokens"
    : "end_turn";
  const u = response.usage ?? {};
  return { content, stop_reason: stop, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.input_tokens_details?.cached_tokens } };
}

// ---------- One turn ----------

// Optional fields a provider or model may refuse ("Unsupported parameter: reasoning_effort"); a refused one is
// left out from then on for that model.
const OPTIONAL = ["reasoning_effort", "reasoning", "max_completion_tokens", "max_output_tokens", "max_tokens", "stream_options"];
/** @type {Map<string, Set<string>>} */
const refused = new Map();

/**
 * One model turn on a provider other than Anthropic, streamed: OpenAI through Responses, the rest through Chat
 * Completions. Resolves the Anthropic-shaped reply.
 * @param {{ provider: ProviderId, key: string, model: string, effort: string, system: string, tools: any[], messages: any[], maxTokens: number, baseURL?: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} o
 */
export async function chatTurn({ provider, key, model, signal, baseURL = PROVIDERS[provider].baseURL, fetchImpl = fetch, ...rest }) {
  const responses = provider === "openai";
  const memo = `${baseURL}|${model}`;
  const drop = refused.get(memo) ?? new Set();
  for (let attempt = 0; attempt <= OPTIONAL.length; attempt++) {
    const body = responses ? responsesRequest({ model, drop, ...rest }) : chatRequest({ provider, model, drop, ...rest });
    const res = await reach(provider, () =>
      fetchImpl(`${baseURL}${responses ? "/responses" : "/chat/completions"}`, {
        method: "POST",
        headers: { ...authHeaders(key), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
    if (res.ok) return responses ? readResponses(res) : readStream(res);
    const err = await providerError(res);
    const field = err.kind === "invalid_request" ? OPTIONAL.find((f) => f in body && err.message.includes(f)) : undefined;
    if (!field) throw err;
    drop.add(field);
    refused.set(memo, drop);
  }
  throw new ProviderError("invalid_request", 400, "The provider refused every form of the request.");
}

/** Server-sent events, one parsed JSON object per data line. */
async function* events(/** @type {Response} */ res) {
  const decoder = new TextDecoder();
  let buf = "";
  // @ts-ignore - Response.body is async-iterable in Node
  for await (const piece of res.body) {
    buf += decoder.decode(piece, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

function failed(/** @type {any} */ error) {
  const message = String(error?.message ?? "The model call failed.");
  const code = `${error?.code ?? ""} ${message}`;
  const kind = /insufficient_quota|quota|credit|billing/i.test(code) ? "billing_error" : /rate_limit/i.test(code) ? "rate_limit" : "server_error";
  return new ProviderError(kind, 500, message);
}

async function readResponses(/** @type {Response} */ res) {
  for await (const e of events(res)) {
    if (e.type === "response.completed" || e.type === "response.incomplete") return fromResponses(e.response);
    if (e.type === "response.failed") throw failed(e.response?.error);
    if (e.type === "error") throw failed(e.error ?? e);
  }
  throw new ProviderError("server_error", 500, "The reply stopped before it finished.");
}

async function readStream(/** @type {Response} */ res) {
  const chunks = [];
  for await (const chunk of events(res)) {
    if (chunk.error) throw failed(chunk.error);
    chunks.push(chunk);
  }
  const { message, finish, usage } = foldChunks(chunks);
  return fromChat(message, finish, usage);
}
