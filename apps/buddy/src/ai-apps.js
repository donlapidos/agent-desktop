// Use with your AI app: adds buddy-mcp (src/mcp-server.js) to the AI apps people already chat in, so they can use
// Buddy on their own plan (Claude, ChatGPT through Codex, Gemini, Copilot...) with no API key in Buddy. Every app here
// speaks MCP; they differ in where they keep the list of servers. Claude Code and Codex are changed only through
// their own commands. The rest keep a JSON file, which is edited in place: everything else in it is kept, a copy is
// saved beside it first, and a file Buddy can't read is left alone.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVER = "desktop-buddy";
// Names Buddy was added under before; adding or removing Buddy clears them too. ("buddy" clashed with a feature of
// the same name in the Claude app.)
const LEGACY = ["buddy"];
const OURS = [SERVER, ...LEGACY];

/** @typedef {{ command: string, args: string[], env: Record<string, string> }} LaunchSpec */
/** @typedef {"added" | "absent" | "missing"} SetupStatus  missing: that app isn't on this PC */
/** @typedef {"code" | "desktop" | "codex" | "gemini" | "cursor" | "vscode" | "windsurf" | "lmstudio"} AppId */
/** @typedef {{ home: string, appData: string, localAppData: string }} Places */

/** @type {Places} */
const HERE = { home: os.homedir(), appData: process.env.APPDATA ?? "", localAppData: process.env.LOCALAPPDATA ?? "" };

/**
 * The apps, and where each keeps its servers. `client` is the name Buddy shows on the island ("Codex: Looking…").
 * JSON apps name the file, the key that holds the servers, and how one entry is written.
 * @type {Readonly<Record<AppId, { label: string, client: string, via: "claude-cli" | "codex-cli" | "json", file: (p: Places) => string, key?: string, entry?: (s: LaunchSpec) => object, after?: string }>>}
 */
export const APPS = Object.freeze({
  code: { label: "Claude Code", client: "Claude", via: "claude-cli", file: (p) => path.join(p.home, ".claude.json"), after: "New Claude Code sessions can use Buddy, and Claude won't stop to check before Buddy looks or points." },
  desktop: { label: "Claude app", client: "Claude", via: "json", file: (p) => path.join(p.appData, "Claude", "claude_desktop_config.json"), key: "mcpServers", after: "Quit and reopen the Claude app to pick it up." },
  codex: { label: "Codex", client: "Codex", via: "codex-cli", file: (p) => path.join(p.home, ".codex", "config.toml"), after: "New Codex chats can use Buddy, in the Codex app and in the terminal." },
  gemini: { label: "Gemini CLI", client: "Gemini", via: "json", file: (p) => path.join(p.home, ".gemini", "settings.json"), key: "mcpServers", after: "New Gemini CLI sessions can use Buddy." },
  cursor: { label: "Cursor", client: "Cursor", via: "json", file: (p) => path.join(p.home, ".cursor", "mcp.json"), key: "mcpServers", after: "Cursor picks it up in a moment; check Settings › MCP in Cursor that it's on." },
  vscode: { label: "VS Code (Copilot)", client: "Copilot", via: "json", file: (p) => path.join(p.appData, "Code", "User", "mcp.json"), key: "servers", entry: (s) => ({ type: "stdio", ...s }), after: "In Copilot Chat's agent mode, Buddy's tools are under the tools button. VS Code may ask you to start it the first time." },
  windsurf: { label: "Windsurf", client: "Windsurf", via: "json", file: (p) => path.join(p.home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", after: "Refresh the MCP list in Windsurf's Cascade panel to pick it up." },
  lmstudio: { label: "LM Studio", client: "LM Studio", via: "json", file: (p) => path.join(p.home, ".lmstudio", "mcp.json"), key: "mcpServers", after: "Buddy's tools appear under Integrations in LM Studio's chat, for models that can use tools." },
});
export const APP_IDS = /** @type {AppId[]} */ (Object.keys(APPS));

/** How an app starts buddy-mcp: Buddy's own executable running as Node (so no Node is needed), told which app it serves. */
export const launchSpec = (exe, script, /** @type {AppId} */ app = "code") => ({ command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: "1", BUDDY_CLIENT: APPS[app].client } });

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * An app's settings with Buddy added (spec) or removed (null) under `key`, under its current name only; every other
 * key and server stays as it was.
 * @param {Record<string, any>} config @param {object | null} entry
 */
export function withBuddy(config, entry, key = "mcpServers") {
  const next = { ...config };
  const servers = { ...(config[key] ?? {}) };
  for (const name of OURS) delete servers[name];
  if (entry) servers[SERVER] = entry;
  if (Object.keys(servers).length) next[key] = servers;
  else delete next[key];
  return next;
}

// ---------- What each app has ----------

/** The entry an app has for Buddy (under any of its names), as { name, command, args, env }, or null. */
function entryIn(/** @type {AppId} */ id, /** @type {Places} */ p) {
  const a = APPS[id];
  if (a.via === "codex-cli") return codexEntry(p);
  const servers = readJson(a.file(p))?.[a.key ?? "mcpServers"] ?? {};
  const name = OURS.find((n) => servers[n]);
  return name ? { name, command: servers[name].command, args: servers[name].args ?? [], env: servers[name].env ?? {} } : null;
}

// Codex keeps TOML. Buddy only reads its own [mcp_servers.<name>] table (and the .env table under it); Codex's own
// command writes it.
function codexEntry(/** @type {Places} */ p) {
  let text;
  try {
    text = fs.readFileSync(APPS.codex.file(p), "utf8");
  } catch {
    return null;
  }
  for (const name of OURS) {
    const table = (sub) => {
      const head = text.match(new RegExp(`^\\[mcp_servers\\.(?:"${name}"|${name})${sub}\\]\\s*$`, "m"));
      if (!head) return null;
      const rest = text.slice((head.index ?? 0) + head[0].length);
      return rest.slice(0, rest.search(/^\s*\[/m) < 0 ? undefined : rest.search(/^\s*\[/m));
    };
    const body = table("");
    if (body == null) continue;
    const strings = (s) => [...s.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? JSON.parse(`"${m[2]}"`)));
    const command = strings(body.match(/^\s*command\s*=\s*(.*)$/m)?.[1] ?? "")[0] ?? "";
    const args = strings(body.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "");
    /** @type {Record<string, string>} */
    const env = {};
    for (const m of (table(".env") ?? "").matchAll(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/gm)) env[m[1]] = strings(m[2])[0] ?? "";
    return { name, command, args, env };
  }
  return null;
}

/** Whether an app is on this PC: its settings folder exists. */
const installed = (/** @type {AppId} */ id, /** @type {Places} */ p) => {
  if (id === "code") return fs.existsSync(APPS.code.file(p));
  return fs.existsSync(path.dirname(APPS[id].file(p)));
};

/** @returns {Record<AppId, SetupStatus>} */
export function appStatus(p = HERE) {
  return /** @type {Record<AppId, SetupStatus>} */ (Object.fromEntries(APP_IDS.map((id) => [id, !installed(id, p) ? "missing" : entryIn(id, p) ? "added" : "absent"])));
}

/**
 * The apps that have Buddy but would start it some other way than `specFor(app)`: under an old name, from where Buddy
 * used to be (a dev copy, before installing), or without saying which app it is. Buddy re-adds itself to those.
 * @param {(id: AppId) => LaunchSpec} specFor @returns {AppId[]}
 */
export function staleApps(specFor, p = HERE) {
  return APP_IDS.filter((id) => {
    const have = entryIn(id, p);
    if (!have) return false;
    const want = specFor(id);
    return have.name !== SERVER || have.command !== want.command || JSON.stringify(have.args) !== JSON.stringify(want.args) || have.env?.BUDDY_CLIENT !== want.env.BUDDY_CLIENT;
  });
}

// ---------- Changing them ----------

// Changes one JSON settings file: a copy of the old file is kept beside it, the new one replaces it in a single step,
// and a file that doesn't parse is left exactly as it is (resolves `unreadable`).
function editJson(file, change, unreadable) {
  let config = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      config = text.trim() ? JSON.parse(text) : {};
    } catch {
      return unreadable;
    }
    fs.writeFileSync(`${file}.before-buddy`, text);
  }
  const tmp = `${file}.buddy-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(change(config), null, 2)}\n`);
  fs.renameSync(tmp, file);
  return null;
}

/** Runs an app's own command: the first of `exes` that exists. */
function command(/** @type {string[]} */ exes, /** @type {string[]} */ args) {
  return new Promise((resolve) => {
    const attempt = (i) =>
      execFile(exes[i], args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err?.code === "ENOENT" && i + 1 < exes.length) return attempt(i + 1);
        resolve(err ? { ok: false, missing: err.code === "ENOENT", text: `${stderr || stdout || err.message}`.trim() } : { ok: true, text: stdout });
      });
    attempt(0);
  });
}

// Each app's command: on PATH, or where its Windows installer puts it.
const CLAUDE_CODE = (/** @type {Places} */ p) => ["claude", path.join(p.home, ".local", "bin", "claude.exe")];
const CODEX = (/** @type {Places} */ p) => ["codex", path.join(p.localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe")];

/**
 * Adds Buddy to an app (spec) or takes it out (null). Resolves an error message, or null.
 * @param {AppId} id @param {LaunchSpec | null} spec
 */
export async function setApp(id, spec, p = HERE) {
  const a = APPS[id];
  if (!installed(id, p)) return `${a.label} isn't on this PC.`;
  if (a.via === "json") {
    const entry = spec ? (a.entry ?? ((s) => s))(spec) : null;
    return editJson(a.file(p), (config) => withBuddy(config, entry, a.key), `Buddy couldn't read ${a.label}'s settings file, so it left it alone.`);
  }
  const exes = a.via === "claude-cli" ? CLAUDE_CODE(p) : CODEX(p);
  const have = entryIn(id, p);
  if (have) await command(exes, a.via === "claude-cli" ? ["mcp", "remove", have.name, "-s", "user"] : ["mcp", "remove", have.name]);
  if (!spec) return null;
  const env = Object.entries(spec.env).flatMap(([k, v]) => [a.via === "claude-cli" ? "-e" : "--env", `${k}=${v}`]);
  const add = a.via === "claude-cli" ? ["mcp", "add", "--scope", "user", SERVER, ...env, "--", spec.command, ...spec.args] : ["mcp", "add", SERVER, ...env, "--", spec.command, ...spec.args];
  const res = await command(exes, add);
  if (res.missing) return `Couldn't find ${a.label}'s command on this PC.`;
  return res.ok ? null : `${a.label} said: ${res.text.slice(0, 200)}`;
}

// ---------- A quick Claude Code chat with only Buddy ----------
// Claude Code as most people have it set up loads their plugins, hooks and other MCP servers on every turn. Measured
// on one Buddy call: 30 s and 112k tokens of context as set up, 7.5 s and 69k with only Buddy (user settings left
// out, so their plugins and hooks don't load; their Claude login still does, so it runs on their plan).

const QUICK_PROMPT = "The user opened this chat from Desktop Buddy to get help with what's on their Windows screen. They are not a developer: use Buddy's tools (desktop-buddy) to look and to point the way, keep replies short and plain, and don't show commands or code unless they ask.";

/** Claude Code's command, as a full path when its Windows installer put it in the usual place. */
export function claudeCodeExe(p = HERE) {
  const local = path.join(p.home, ".local", "bin", "claude.exe");
  return fs.existsSync(local) ? local : "claude";
}

/**
 * The arguments for a quick chat: only Buddy's server (from `mcpFile`), no user settings, Buddy's look-and-point
 * tools allowed without a check.
 * @param {string} mcpFile @param {string[]} safeTools
 */
export const quickChatArgs = (mcpFile, safeTools) => [
  "--setting-sources", "project",
  "--strict-mcp-config", "--mcp-config", mcpFile,
  "--allowedTools", ...allowRules(safeTools),
  "--append-system-prompt", QUICK_PROMPT,
];

/** The --mcp-config file for a quick chat. @param {LaunchSpec} spec */
export const quickChatConfig = (spec) => JSON.stringify({ mcpServers: { [SERVER]: spec } }, null, 2);

// ---------- Claude Code's allow rules ----------

/** Claude Code's permission rules for Buddy's tools that only look, read, point or show (bridge.js SAFE_TOOLS). */
export const allowRules = (names) => names.map((n) => `mcp__${SERVER}__${n}`);
const legacyRule = (rule) => LEGACY.some((name) => rule.startsWith(`mcp__${name}__`));

/**
 * Claude Code's settings with Buddy's allow rules added (on) or taken out; every other rule and key stays.
 * @param {Record<string, any>} settings @param {string[]} rules @param {boolean} on
 */
export function withAllowRules(settings, rules, on) {
  const allow = (settings.permissions?.allow ?? []).filter((r) => !rules.includes(r) && !legacyRule(r));
  const next = { ...settings, permissions: { ...(settings.permissions ?? {}), allow: on ? [...allow, ...rules] : allow } };
  if (!next.permissions.allow.length) delete next.permissions.allow;
  if (!Object.keys(next.permissions).length) delete next.permissions;
  return next;
}

/** Lets Claude Code run Buddy's safe tools without a check each time (on), or takes that back. */
export function setCodeAllowed(rules, on, file = path.join(HERE.home, ".claude", "settings.json")) {
  if (!fs.existsSync(path.dirname(file))) return null;
  return editJson(file, (settings) => withAllowRules(settings, rules, on), "Buddy couldn't read Claude Code's settings file, so it left it alone.");
}
