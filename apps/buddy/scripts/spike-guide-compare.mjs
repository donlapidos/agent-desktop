// Spike: time to the first point in Guide mode, old Brain vs AgentBrain, same model, same window. Read-only: every
// approval is declined and each run stops at its first point.
//   npx electron scripts/spike-guide-compare.mjs <window-id> <app> <out-dir> [rounds]
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { AgentBrain } from "../src/agent-brain.js";
import { Brain, setBrainDefaults } from "../src/brain.js";

const [winId, appName, out, rounds = "2"] = process.argv.slice(-4);
const outDir = path.resolve(out);
fs.mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(app.getPath("appData"), "desktop-buddy"));
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  fs.appendFileSync(path.join(outDir, "guide.log"), `${line}\n`);
};
const QUESTION = "How do I turn this data into a table?";

async function once(Engine, apiKey, target) {
  const traces = [];
  let firstPoint = null;
  let t0 = 0;
  /** @type {any} */
  let brain;
  brain = new Engine({
    apiKey,
    agentDir: path.join(outDir, "agent"),
    documentsDir: path.join(outDir, "docs"),
    point: async (_bounds, caption) => {
      firstPoint ??= { ms: Date.now() - t0, caption };
      brain.cancel();
    },
    confirm: async () => "deny",
    status: () => {},
    trace: (t) => traces.push({ at: Date.now() - t0, ...t }),
  });
  brain.glance(target);
  await new Promise((r) => setTimeout(r, 5000));
  t0 = Date.now();
  const reply = await brain.ask(QUESTION, target);
  const rec = { engine: Engine.name, firstPoint, totalMs: Date.now() - t0, reply: reply.slice(0, 80), steps: traces.filter((t) => t.kind === "model" || t.kind === "tool").map((t) => `${t.kind === "model" ? `model ${t.ms}ms in=${t.in ?? "?"}+${t.cached ?? 0}c out=${t.out} ${(t.blocks ?? t.tools ?? []).join(",")}` : `  ${t.name} ${t.ms}ms`}`) };
  log(JSON.stringify({ engine: rec.engine, firstPoint: rec.firstPoint, totalMs: rec.totalMs }));
  for (const s of rec.steps) log("   ", s);
  brain.live?.close();
  return rec;
}

app.whenReady().then(async () => {
  const apiKey = safeStorage.decryptString(fs.readFileSync(path.join(app.getPath("userData"), "api-key.bin")));
  setBrainDefaults({ model: "claude-opus-5-5", effort: "medium" });
  const target = { id: winId, app_name: appName, title: "" };
  for (let i = 0; i < Number(rounds); i++) {
    await once(Brain, apiKey, target);
    await once(AgentBrain, apiKey, target);
  }
}).catch((e) => log("FATAL", String(e?.stack ?? e))).finally(() => app.quit());
