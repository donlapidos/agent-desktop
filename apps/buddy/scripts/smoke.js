// Exercise the agent-desktop bridge without the model: find a window, read it, render it.
// Usage: npm run smoke -- [app name]
import { renderTree, resolveBinary, runDesktop } from "../src/desktop.js";

const appName = process.argv[2];
console.log("binary:", resolveBinary());

const version = await runDesktop(["version"]);
console.log("version:", version.ok ? version.data : version.error);

const list = await runDesktop(["list-windows"]);
if (!list.ok) throw new Error(JSON.stringify(list.error));
const windows = Array.isArray(list.data) ? list.data : list.data?.windows ?? [];
console.log(`windows: ${windows.length}; first:`, JSON.stringify(windows[0]));

const target = appName ? windows.find((w) => w.app_name.toLowerCase().includes(appName.toLowerCase())) : windows.find((w) => w.is_focused) ?? windows[0];
if (!target) throw new Error(`no window matching ${appName}`);
console.log("target:", target.app_name, "|", target.title, "|", target.id);

const t0 = performance.now();
const snap = await runDesktop(["snapshot", "--app", target.app_name, "--window-id", target.id, "-i", "--compact", "--include-bounds"], { timeoutMs: 20_000 });
const ms = Math.round(performance.now() - t0);
if (!snap.ok) throw new Error(JSON.stringify(snap.error));
const { text, bounds } = renderTree(snap.data.tree);
console.log(`snapshot: ${ms} ms · ${snap.data.ref_count} refs · ${bounds.size} with bounds · ${text.length} chars · complete=${snap.data.complete}`);
console.log(text.split("\n").slice(0, 25).join("\n"));
const [ref, b] = [...bounds][0] ?? [];
console.log("sample bounds:", ref, JSON.stringify(b));
