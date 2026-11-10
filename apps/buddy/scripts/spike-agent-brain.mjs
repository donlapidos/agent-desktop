// Spike smoke test: AgentBrain answers, keeps context across turns, asks before changing anything (here: declines).
//   npx electron scripts/spike-agent-brain.mjs <out-dir>
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { AgentBrain } from "../src/agent-brain.js";
import { setBrainDefaults } from "../src/brain.js";

const outDir = path.resolve(process.argv.at(-1));
fs.mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(app.getPath("appData"), "desktop-buddy"));
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));

app.whenReady().then(async () => {
  const apiKey = safeStorage.decryptString(fs.readFileSync(path.join(app.getPath("userData"), "api-key.bin")));
  setBrainDefaults({ model: "claude-haiku-5-5", effort: "low" });
  const work = path.join(outDir, "work");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "Shopping List.txt"), "milk\neggs\n");
  const asked = [];
  const traces = [];
  const brain = new AgentBrain({
    apiKey,
    agentDir: path.join(outDir, "agent"),
    documentsDir: work,
    point: async () => {},
    confirm: async (summary, _bounds, note) => { asked.push({ summary, note }); return "deny"; },
    status: (s) => log("status:", s),
    trace: (t) => traces.push(t),
  });
  const t0 = Date.now();
  log("turn1:", await brain.ask("What files are in my Buddy folder? One sentence.", null), `${Date.now() - t0}ms`);
  const t1 = Date.now();
  log("turn2:", await brain.ask("Rename the shopping list to groceries.txt.", null), `${Date.now() - t1}ms`);
  const t2 = Date.now();
  log("turn3:", await brain.ask("What did I just ask you to do? One sentence.", null), `${Date.now() - t2}ms`);
  log("asked:", asked);
  log("files:", fs.readdirSync(work));
  log("turns:", traces.filter((t) => t.kind === "agent-turn"));
  log("tools:", traces.filter((t) => t.kind === "agent-tool").map((t) => t.name));
  brain.reset();
  brain.live?.close();
}).catch((e) => log("FATAL", String(e?.stack ?? e))).finally(() => app.quit());
