// Which AI provider Buddy thinks with. Anthropic is called through its own SDK (brain.js); every other provider here
// speaks OpenAI's Chat Completions API, so one adapter serves them all. Buddy's conversation stays in Anthropic's
// message format (text, image, tool_use and tool_result blocks); chatRequest() converts it on the way out and
// fromChat() converts the reply back, so history, trimming and tools work the same whichever provider answers.

/**
 * @typedef {"anthropic" | "openai" | "openrouter" | "gemini" | "deepseek"} ProviderId
 * @typedef {{ id: ProviderId, label: string, baseURL?: string, keyFrom: string, keyEnv?: string, placeholder: string, prefix?: RegExp, loose?: boolean }} Provider
 * prefix: how this provider's keys start (or, with loose, how some of them do: other sk- keys may be theirs too).
 */

/** @type {Readonly<Record<ProviderId, Provider>>} */
export const PROVIDERS = Object.freeze({
  anthropic: { id: "anthropic", label: "Anthropic", keyFrom: "console.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…", prefix: /^sk-ant-/ },
  openai: { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", keyFrom: "platform.openai.com", keyEnv: "OPENAI_API_KEY", placeholder: "sk-…", prefix: /^sk-(proj|svcacct|admin)-/, loose: true },
  openrouter: { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", keyFrom: "openrouter.ai/keys", keyEnv: "OPENROUTER_API_KEY", placeholder: "sk-or-…", prefix: /^sk-or-/ },
  gemini: { id: "gemini", label: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyFrom: "aistudio.google.com", keyEnv: "GEMINI_API_KEY", placeholder: "AIza…", prefix: /^AIza/ },
  deepseek: { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", keyFrom: "platform.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", placeholder: "sk-…", loose: true },
});
export const PROVIDER_IDS = /** @type {ProviderId[]} */ (Object.keys(PROVIDERS));

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

/** The provider's chat models for this key, best first. Throws a ProviderError if the key is refused. */
export async function listModels(/** @type {ProviderId} */ provider, /** @type {string} */ key, fetchImpl = fetch) {
  const res = await fetchImpl(`${PROVIDERS[provider].baseURL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
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

// ---------- One turn ----------

// Optional fields a provider or model may refuse ("Unsupported parameter: reasoning_effort"); a refused one is
// left out from then on for that model.
const OPTIONAL = ["reasoning_effort", "max_completion_tokens", "max_tokens", "stream_options"];
/** @type {Map<string, Set<string>>} */
const refused = new Map();

/**
 * One model turn on a Chat Completions provider, streamed. Resolves the Anthropic-shaped reply.
 * @param {{ provider: ProviderId, key: string, model: string, effort: string, system: string, tools: any[], messages: any[], maxTokens: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} o
 */
export async function chatTurn({ provider, key, model, signal, fetchImpl = fetch, ...rest }) {
  const memo = `${provider}|${model}`;
  const drop = refused.get(memo) ?? new Set();
  for (let attempt = 0; attempt <= OPTIONAL.length; attempt++) {
    const body = chatRequest({ provider, model, drop, ...rest });
    const res = await fetchImpl(`${PROVIDERS[provider].baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return readStream(res);
    const err = await providerError(res);
    const field = err.kind === "invalid_request" ? OPTIONAL.find((f) => f in body && err.message.includes(f)) : undefined;
    if (!field) throw err;
    drop.add(field);
    refused.set(memo, drop);
  }
  throw new ProviderError("invalid_request", 400, "The provider refused every form of the request.");
}

async function readStream(/** @type {Response} */ res) {
  const chunks = [];
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
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new ProviderError("server_error", 500, String(chunk.error.message ?? chunk.error));
      chunks.push(chunk);
    }
  }
  const { message, finish, usage } = foldChunks(chunks);
  return fromChat(message, finish, usage);
}
