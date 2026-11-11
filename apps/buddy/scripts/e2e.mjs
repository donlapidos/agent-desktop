// End-to-end checks: the real app, run as separate test copies (each with its own data folder, so the user's Buddy,
// settings and files are left alone), each driven by one of main.js's BUDDY_*_TEST hooks. The runner reads what each
// copy prints, checks it, and keeps the screenshots.
//   npm run e2e                  files, tasks, settings, explainer, voice
//   npm run e2e -- tasks voice   only those
//   npm run e2e -- --interactive also the marker (a full-screen freeze frame) and approval clicks (moves the mouse)
// Windows appear briefly while it runs. Nothing touches the clipboard, real files or the mouse unless --interactive.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = path.join(app, "node_modules", "electron", "dist", "electron.exe");
const out = path.join(app, "e2e-out", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const realModels = path.join(process.env.APPDATA ?? "", "desktop-buddy", "models");

// ---------- A scripted OpenAI-style model, for the files check ----------

/** Asks to write the shopping list, then, once it's written, says so. */
function scriptedModel() {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "scripted", object: "model" }] }));
    const asked = JSON.parse(body || "{}");
    const done = (asked.messages ?? []).some((m) => m.role === "tool");
    const chunk = done
      ? { choices: [{ delta: { content: "Made your shopping list." }, finish_reason: "stop" }] }
      : { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "Shopping list.txt", content: "- Eggs\n- Milk\n- Bread\n" }) } }] }, finish_reason: "tool_calls" }] };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1`, close: () => server.close() })));
}

// ---------- Running one test copy ----------

/**
 * Runs Buddy with `env` until it prints `done` (or `timeoutMs` passes), and returns what it printed, by marker.
 * Every copy's own timing.log is read afterwards: a refused mode or task-state change is a bug, whichever check hit it.
 * @returns {Promise<{ markers: Record<string, any[]>, log: string, timedOut: boolean }>}
 */
function runCopy(name, env, done, timeoutMs = 90_000) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `buddy-e2e-${name}-`));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|DEEPSEEK)_|^BUDDY_/.test(k)));
  const child = spawn(electron, [".", `--user-data-dir=${data}`], {
    cwd: app,
    env: { ...clean, BUDDY_E2E: "1", ...(fs.existsSync(realModels) ? { BUDDY_MODELS_DIR: realModels } : {}), ...env },
    windowsHide: false,
  });
  let log = "";
  /** @type {Record<string, any[]>} */
  const markers = {};
  return new Promise((resolve) => {
    let finished = false;
    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      fs.writeFileSync(path.join(out, `${name}.log`), log);
      try {
        for (const line of fs.readFileSync(path.join(data, "timing.log"), "utf8").split(/\r?\n/)) {
          if (/"kind":"refused-(mode-change|task-state)"/.test(line)) refusals.push(`${name}: ${line}`);
        }
      } catch {}
      resolve({ markers, log, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const read = (chunk) => {
      log += chunk;
      for (const line of String(chunk).split(/\r?\n/)) {
        const m = line.match(/^([A-Z][A-Z_]+)\s*(.*)$/);
        if (!m) continue;
        let value = m[2];
        try {
          value = JSON.parse(m[2]);
        } catch {}
        (markers[m[1]] ??= []).push(value);
        if (m[1] === done) setTimeout(() => finish(false), 300);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", (d) => (log += d));
    child.on("exit", () => setTimeout(() => finish(false), 200));
  });
}

/** Refused state changes seen in any copy's log (see runCopy). */
const refusals = [];

// ---------- The checks ----------

// A key saved for "Other server" at one address is sent there, not to another, and is there again on the way back.
function keyProblems(k) {
  if (!k) return ["the key check printed nothing"];
  return [
    (!k.atA.key.saved || k.atA.sent !== "key-for-server-a-0123456789") && "the key wasn't used at its own address",
    k.atB.sent !== null && "the key was sent to another address",
    k.atB.key.elsewhere !== "https://a.example" && `Settings didn't say where the key belongs (${k.atB.key.elsewhere})`,
    k.backAtA.sent !== "key-for-server-a-0123456789" && "the key didn't come back at its own address",
  ].filter(Boolean);
}

/** @type {Record<string, { interactive?: boolean, run: () => Promise<string[]> }>} each resolves its problems */
const CHECKS = {
  async files() {
    const model = await scriptedModel();
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-e2e-docs-"));
    try {
      const { markers, timedOut } = await runCopy("files", { BUDDY_FILES_TEST: model.url, BUDDY_DOCUMENTS_DIR: docs, BUDDY_FILES_TEST_OUT: path.join(out, "files-activity.png") }, "FILES_TEST_DONE");
      const r = markers.FILES_TEST?.[0];
      if (!r) return [timedOut ? "timed out before the check finished" : "the check printed nothing"];
      return [
        !/^Create Shopping list\.txt in /.test(r.card ?? "") && `approval card said ${JSON.stringify(r.card)}`,
        r.reply !== "Made your shopping list." && `reply was ${JSON.stringify(r.reply)}`,
        !/Eggs[\s\S]*Milk[\s\S]*Bread/.test(r.made ?? "") && "the file wasn't made with the list",
        !(markers.REVEALED?.[0] ?? []).some((f) => f.endsWith("Shopping list.txt")) && "the made file wasn't shown",
        r.listed?.[0]?.kind !== "created" && "Activity didn't list the new file",
        !/Created Shopping list\.txt/.test(r.page ?? "") && "the Activity page didn't show it",
        !r.undone?.ok && `undo failed: ${r.undone?.message}`,
        !r.goneAfterUndo && "the file was still there after undo",
      ].filter(Boolean);
    } finally {
      model.close();
    }
  },

  async tasks() {
    const { markers, timedOut } = await runCopy("tasks", { BUDDY_TASK_TEST: out }, "TASK_TEST_DONE");
    const last = markers.TASKS?.at(-1);
    if (!last) return [timedOut ? "timed out" : "no task list printed"];
    // A finished task reads "done" until its window is seen, then "idle"; the check shows both windows at the end.
    const want = { t1: /^The Pro plan is the only one with SSO/, t2: /^Saved the file as report-final\.xlsx/ };
    const first = markers.TASKS[0] ?? [];
    return [
      last.length !== 2 && `expected 2 tasks, got ${last.length}`,
      first.find((t) => t.id === "t2")?.state !== "confirm" && "task 2 didn't wait for approval",
      ...last.filter((t) => !["done", "idle"].includes(t.state) || !want[t.id]?.test(t.line ?? "")).map((t) => `${t.title} ended "${t.state}": ${t.line}`),
      ...["task-2-confirm.png", "island-peek-confirm.png", "task-1-done.png"].filter((f) => !fs.existsSync(path.join(out, f))).map((f) => `no ${f}`),
    ].filter(Boolean);
  },

  async settings() {
    const { markers, timedOut } = await runCopy("settings", { BUDDY_SETTINGS_TEST: out }, "SETTINGS_TEST_DONE", 180_000);
    const applied = markers.SETTINGS_APPLIED?.[0];
    if (!applied) return [timedOut ? "timed out" : "no settings result printed"];
    const coral = "#f2545b";
    const policy = markers.SETTINGS_POLICY?.[0] ?? {};
    const lang = markers.SETTINGS_LANGUAGE?.[0] ?? {};
    return [
      Object.keys(applied.problems ?? {}).length && `changes refused: ${JSON.stringify(applied.problems)}`,
      ...["island", "bubble", "settingsPage"].filter((w) => applied[w]?.toLowerCase() !== coral).map((w) => `${w} accent is ${applied[w]}, not coral`),
      !applied.newAskHeld && "the new Ask shortcut wasn't registered",
      applied.file?.accent !== "coral" && "the accent wasn't saved",
      !markers.SETTINGS_CLASH?.[0]?.["hotkeys.talk"] && "a clashing shortcut wasn't refused",
      policy.notepadType !== "allow" && `trusted Notepad typing: ${policy.notepadType}`,
      policy.wordType !== "ask" && `Word typing: ${policy.wordType}`,
      policy.keepass !== "block" && `KeePass: ${policy.keepass}`,
      !markers.SETTINGS_ROUTINE?.[0]?.started && "the routine didn't report anything",
      lang.lang && lang.lang !== "es" && `Spanish heard as ${lang.lang}`,
      !lang.text && "nothing heard in the language check (are the voice models downloaded?)",
      !fs.existsSync(path.join(out, "settings-claude.png")) && "no Settings screenshots",
      ...keyProblems(markers.SETTINGS_KEYS?.[0]),
    ].filter(Boolean);
  },

  async explainer() {
    const { markers, timedOut } = await runCopy("explainer", { BUDDY_EXPLAINER_TEST: path.join(app, "scripts", "samples", "vlookup.json"), BUDDY_EXPLAINER_TEST_OUT: path.join(out, "explainer.png") }, "EXPLAINER_TEST_DONE");
    const r = markers.EXPLAINER_SHOWN?.[0];
    if (!r) return [timedOut ? "timed out" : "nothing printed"];
    return [!r.windows && "no explainer window opened", !r.visible && "the explainer window isn't visible", r.chars < 100 && `only ${r.chars} characters on the plate`].filter(Boolean);
  },

  async voice() {
    const line = "Click the Formulas tab, then choose Insert Function.";
    const { markers, timedOut } = await runCopy("voice", { BUDDY_VOICE_TEST: line }, "VOICE_TEST_DONE", 120_000);
    const heard = String(markers.VOICE_HEARD?.[0] ?? "").toLowerCase();
    if (!markers.VOICE_SYNTH) return [timedOut ? "timed out (are the voice models downloaded?)" : "nothing spoken"];
    return [!heard.includes("formulas") && `heard ${heard || "nothing"}`, !markers.VOICE_SAID && "the reply wasn't played"].filter(Boolean);
  },

  mark: {
    interactive: true,
    async run() {
      const shot = path.join(out, "marks.png");
      const strokes = JSON.stringify([[{ x: 200, y: 200 }, { x: 320, y: 220 }, { x: 420, y: 210 }]]);
      const { markers, timedOut } = await runCopy("mark", { BUDDY_MARK_TEST: strokes, BUDDY_MARK_TEST_OUT: shot }, "MARK_TEST_DONE");
      if (!markers.MARKS) return [timedOut ? "timed out" : "no marks printed"];
      return [markers.MARKS[0].length !== 1 && `expected 1 mark, got ${markers.MARKS[0].length}`, !fs.existsSync(shot) && "no marks image"].filter(Boolean);
    },
  },

  approval: {
    interactive: true,
    async run() {
      const problems = [];
      for (const kind of ["plain", "guide", "cycle", "twoasks"]) {
        const { markers, timedOut } = await runCopy(`approval-${kind}`, { BUDDY_APPROVAL_TEST: kind, ANTHROPIC_API_KEY: "sk-ant-e2e-not-used-0000000000" }, "APPROVAL_TEST", 60_000);
        const r = markers.APPROVAL_TEST?.[0];
        if (!r) problems.push(`${kind}: ${timedOut ? "timed out" : "nothing printed"}`);
        else if (r.answered !== true) problems.push(`${kind}: the click on Allow didn't count`);
      }
      return problems;
    },
  },
};

// ---------- Run ----------

const args = process.argv.slice(2);
const interactive = args.includes("--interactive");
const named = args.filter((a) => !a.startsWith("--"));
const chosen = Object.entries(CHECKS).filter(([name, c]) => (named.length ? named.includes(name) : typeof c === "function" || (interactive && c.interactive)));
if (!chosen.length) {
  console.error(`No such check. Checks: ${Object.keys(CHECKS).join(", ")}`);
  process.exit(2);
}
console.log(`Buddy end-to-end · ${chosen.length} check(s) · screenshots and logs in ${path.relative(process.cwd(), out)}\n`);
let failed = 0;
for (const [name, c] of chosen) {
  const t0 = Date.now();
  let problems;
  try {
    problems = await (typeof c === "function" ? c() : c.run());
  } catch (err) {
    problems = [`crashed: ${err?.stack ?? err}`];
  }
  // A state change the tables refused during this check is a bug, even if what the check looked at came out right.
  problems.push(...refusals.splice(0).map((r) => `refused state change: ${r}`));
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "PASS"}  ${name.padEnd(10)} ${s.padStart(5)} s${problems.map((p) => `\n      ${p}`).join("")}`);
}
console.log(`\n${chosen.length - failed}/${chosen.length} passed`);
process.exit(failed ? 1 : 0);
