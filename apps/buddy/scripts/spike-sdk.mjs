// Spike: can the Claude Agent SDK be Buddy's engine? Runs inside Electron so it uses Buddy's real (safeStorage) key.
//   npx electron scripts/spike-sdk.mjs <out-dir> [model]
// Isolated from the user's own Claude Code: no setting sources, a private CLAUDE_CONFIG_DIR, an explicit API key,
// and the run aborts unless the agent reports apiKeySource ANTHROPIC_API_KEY.
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createSdkMcpServer, prewarm, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const outDir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("-") && !a.endsWith(".mjs")) ?? "spike-out");
const model = process.argv.find((a) => a.startsWith("claude-")) ?? "claude-haiku-5-5";
fs.mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(app.getPath("appData"), "desktop-buddy"));

const results = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  fs.appendFileSync(path.join(outDir, "spike.log"), `${line}\n`);
};

const SYSTEM = "You are Buddy, a friendly assistant on the user's Windows desktop. Be brief: one or two short sentences.";

// The built-in tools an everyday Buddy offers; the developer ones (cron, worktrees, workflows...) stay off.
const EVERYDAY_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "PowerShell", "WebFetch", "WebSearch", "AskUserQuestion", "TodoWrite", "Task"];

function baseOptions(apiKey, { env, ...extra } = {}) {
  const configDir = path.join(outDir, "agent-config");
  fs.mkdirSync(configDir, { recursive: true });
  return {
    model,
    systemPrompt: SYSTEM,
    settingSources: [],
    persistSession: false,
    permissionMode: "default",
    stderr: (s) => fs.appendFileSync(path.join(outDir, "stderr.log"), s),
    ...extra,
    env: { ...process.env, ...(env ?? {}), ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: configDir },
  };
}

// Runs one query and records timings, tools offered, permission traffic and the result.
async function run(name, prompt, options, start = (p, o) => query({ prompt: p, options: o })) {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const rec = { name, hooks: [], asks: [], toolsUsed: [] };
  const q = start(prompt, { ...options, includePartialMessages: true });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        rec.initMs = ms();
        rec.apiKeySource = m.apiKeySource;
        rec.version = m.claude_code_version;
        rec.tools = m.tools;
        rec.mcp = m.mcp_servers;
        if (m.apiKeySource !== "ANTHROPIC_API_KEY") {
          log(`ABORT ${name}: apiKeySource=${m.apiKeySource}`);
          q.close();
          break;
        }
      } else if (m.type === "stream_event" && rec.firstTokenMs == null && m.event?.type === "content_block_delta") {
        rec.firstTokenMs = ms();
      } else if (m.type === "assistant") {
        for (const b of m.message.content) if (b.type === "tool_use") rec.toolsUsed.push({ name: b.name, input: b.input });
      } else if (m.type === "result") {
        rec.totalMs = ms();
        rec.subtype = m.subtype;
        rec.result = m.result;
        rec.cost = m.total_cost_usd;
        rec.usage = m.usage;
        rec.apiMs = m.duration_api_ms;
        rec.turns = m.num_turns;
      }
    }
  } catch (err) {
    rec.error = String(err?.stack ?? err);
  }
  results.push(rec);
  log(`== ${name}`, { initMs: rec.initMs, firstTokenMs: rec.firstTokenMs, totalMs: rec.totalMs, cost: rec.cost, error: rec.error });
  return rec;
}

const gate = (rec, verdictFor) => ({
  hooks: {
    PreToolUse: [{
      onFailure: "block",
      hooks: [async (input) => {
        const decision = verdictFor(input.tool_name, input.tool_input);
        rec.hooks.push({ tool: input.tool_name, input: input.tool_input, decision, mcp: input.mcp_server });
        return decision ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: "Buddy policy" } } : {};
      }],
    }],
  },
  canUseTool: async (toolName, input, opts) => {
    rec.asks.push({ tool: toolName, input, reason: opts.decisionReason, blockedPath: opts.blockedPath, mcp: opts.mcpServer });
    return { behavior: "allow", updatedInput: input };
  },
});

// One long-lived session fed by a message queue: how fast is turn 2 when the process is already up?
async function liveSession(apiKey) {
  const queue = [];
  let wake;
  const push = (text) => { queue.push(text); wake?.(); };
  async function* input() {
    for (;;) {
      while (!queue.length) await new Promise((r) => { wake = r; });
      const text = queue.shift();
      if (text === null) return;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
  }
  const q = query({ prompt: input(), options: { ...baseOptions(apiKey, { tools: [] }), includePartialMessages: true } });
  const turns = [];
  let t0 = performance.now();
  let first = null;
  push("Say hi in five words.");
  for await (const m of q) {
    if (m.type === "stream_event" && first == null && m.event?.type === "content_block_delta") first = Math.round(performance.now() - t0);
    if (m.type === "result") {
      turns.push({ firstTokenMs: first, totalMs: Math.round(performance.now() - t0), result: m.result });
      if (turns.length === 3) { push(null); break; }
      first = null;
      t0 = performance.now();
      push(turns.length === 1 ? "Now say bye in five words." : "One more: say thanks in three words.");
    }
  }
  q.close();
  results.push({ name: "live-session", turns });
  log("== live-session", turns.map((t) => ({ firstTokenMs: t.firstTokenMs, totalMs: t.totalMs })));
}

async function directApi(apiKey) {
  const client = new Anthropic({ apiKey });
  const t0 = performance.now();
  let first;
  const stream = client.messages.stream({ model, max_tokens: 200, system: SYSTEM, messages: [{ role: "user", content: "Say hi in five words." }] });
  stream.on("text", () => { first ??= Math.round(performance.now() - t0); });
  const msg = await stream.finalMessage();
  const rec = { name: "direct-api", firstTokenMs: first, totalMs: Math.round(performance.now() - t0), usage: msg.usage };
  results.push(rec);
  log("== direct-api", rec);
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? safeStorage.decryptString(fs.readFileSync(path.join(app.getPath("userData"), "api-key.bin")));
  log(`model ${model}, electron ${process.versions.electron}, node ${process.versions.node}`);

  // 1. Latency: direct API vs a cold agent vs a prewarmed spare vs the next turn of a live session.
  await directApi(apiKey);
  await run("cold-hello", "Say hi in five words.", baseOptions(apiKey, { tools: [] }));
  const spareOptions = baseOptions(apiKey, { tools: [] });
  const spare = await prewarm({ options: spareOptions });
  await new Promise((r) => setTimeout(r, 500));
  await run("prewarmed-hello", "Say hi in five words.", spareOptions, (p) => spare.claim({ prompt: p, options: { cwd: process.cwd(), model } }));
  await liveSession(apiKey);

  // 1b. Read-only commands: let Claude Code's own read-only check pass them (hook gives no decision for the shell).
  const ro = path.join(outDir, "readonly");
  fs.mkdirSync(ro, { recursive: true });
  fs.writeFileSync(path.join(ro, "notes.txt"), "hello");
  const rec1b = { hooks: [], asks: [] };
  const readonly = await run(
    "readonly-pass",
    "Use PowerShell to list the files in this folder with their sizes, then delete notes.txt.",
    baseOptions(apiKey, { cwd: ro, tools: EVERYDAY_TOOLS, ...gate(rec1b, () => null) }),
  );
  Object.assign(readonly, { hooks: rec1b.hooks, asks: rec1b.asks, after: fs.readdirSync(ro) });
  log("readonly hooks:", rec1b.hooks.map((h) => `${h.tool}:${String(h.input?.command ?? "").slice(0, 60)}`), "asked:", rec1b.asks.map((a) => `${a.tool}:${String(a.input?.command ?? "").slice(0, 60)} (${a.reason})`));

  // 2. Everyday file task in a scratch folder, with every call gated: shell and writes go to the card (ask).
  const work = path.join(outDir, "photos");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  for (const f of ["IMG_0001.JPG", "IMG_0002.JPG", "Holiday Photo.JPG"]) fs.writeFileSync(path.join(work, f), "x");
  const rec2 = { hooks: [], asks: [] };
  const everyday = await run(
    "everyday-rename",
    "In this folder, rename every .JPG file so the name is lowercase with dashes instead of spaces. Then list the folder.",
    baseOptions(apiKey, { cwd: work, tools: EVERYDAY_TOOLS, ...gate(rec2, (t) => (/^(Read|Glob|Grep|LS)$/.test(t) ? null : "ask")) }),
  );
  Object.assign(everyday, { hooks: rec2.hooks, asks: rec2.asks, after: fs.readdirSync(work) });
  log("everyday after:", everyday.after, "hooks:", rec2.hooks.map((h) => `${h.tool}:${h.decision ?? "pass"}`), "asks:", rec2.asks.map((a) => a.tool));

  // 3. Same task with Git Bash hidden from PATH: what an everyday PC without Git looks like.
  const noGitPath = (process.env.PATH ?? "").split(";").filter((p) => !/\\Git\\/i.test(p)).join(";");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  for (const f of ["IMG_0001.JPG", "Holiday Photo.JPG"]) fs.writeFileSync(path.join(work, f), "x");
  const rec3 = { hooks: [], asks: [] };
  const noGit = await run(
    "everyday-no-git",
    "In this folder, rename every .JPG file so the name is lowercase with dashes instead of spaces. Then list the folder.",
    baseOptions(apiKey, { cwd: work, tools: EVERYDAY_TOOLS, env: { PATH: noGitPath, CLAUDE_CODE_GIT_BASH_PATH: "" }, ...gate(rec3, (t) => (/^(Read|Glob|Grep|LS)$/.test(t) ? null : "ask")) }),
  );
  Object.assign(noGit, { hooks: rec3.hooks, asks: rec3.asks, after: fs.readdirSync(work) });
  log("no-git after:", noGit.after, "tools offered:", noGit.tools?.filter((t) => /bash|powershell|shell/i.test(t)));

  // 4. An in-process Buddy tool, and a policy block on it.
  const pointed = [];
  const buddy = createSdkMcpServer({
    name: "buddy",
    tools: [
      tool("point_at", "Fly Buddy's pointer to something on screen and show a caption.", { target: z.string(), caption: z.string() }, async (args) => {
        pointed.push(args);
        return { content: [{ type: "text", text: "Pointed." }] };
      }),
      tool("act", "Click something for the user.", { target: z.string(), summary: z.string() }, async () => ({ content: [{ type: "text", text: "Clicked." }] })),
    ],
  });
  const rec4 = { hooks: [], asks: [] };
  const mcp = await run(
    "buddy-tools",
    "Use point_at to point at the Start button with the caption 'Click Start'. Then use act to click it with summary 'Click Start'.",
    baseOptions(apiKey, { tools: [], mcpServers: { buddy }, ...gate(rec4, (t) => (t === "mcp__buddy__act" ? "deny" : t === "mcp__buddy__point_at" ? "allow" : "ask")) }),
  );
  Object.assign(mcp, { hooks: rec4.hooks, asks: rec4.asks, pointed });
  log("buddy-tools hooks:", rec4.hooks.map((h) => `${h.tool}:${h.decision}:${h.mcp?.source ?? ""}`), "pointed:", pointed);

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}

app.whenReady().then(main).catch((e) => log("FATAL", String(e?.stack ?? e))).finally(() => app.quit());
