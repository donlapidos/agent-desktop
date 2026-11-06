// Task agents: each task is its own Claude conversation in its own window. Minimizing a task tucks it into a chip
// on the island; closing it stops the agent. Tasks work side by side; anything that clicks or types takes turns
// (see takeTurn in brain.js), and each task asks for approval in its own window.
import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";

const TASK = { width: 420, height: 560 };
const MAX_TASKS = 6;

const shorten = (text, n = 34) => {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * @param {{
 *   here: string, icon: string,
 *   makeBrain: (ui: object) => any,      // a new Brain wired to this ui, or null without an API key
 *   currentTarget: () => Promise<any>,   // the user's foreground window, Buddy's own windows excluded
 *   point: Function, explain: Function,  // shared pointer and explainer, as the bubble uses them
 *   onChange: (tasks: object[]) => void, // the island's chips
 * }} deps
 */
export function createTasks({ here, icon, makeBrain, currentTarget, point, explain, onChange }) {
  const tasks = new Map();
  let seq = 0;

  const summary = () =>
    [...tasks.values()].map((t) => ({ id: t.id, n: t.n, title: t.title, state: t.state, open: t.win.isVisible() }));
  const changed = () => onChange(summary());
  const fromSender = (sender) => [...tasks.values()].find((t) => !t.win.isDestroyed() && t.win.webContents === sender);
  const send = (t, channel, payload) => {
    if (!t.win.isDestroyed()) t.win.webContents.send(channel, payload);
  };

  function setState(t, state, line) {
    t.state = state;
    send(t, "task-state", { state, line, title: t.title });
    changed();
  }

  // New windows cascade down from the top right, clear of the island.
  function place(n) {
    const { workArea } = screen.getPrimaryDisplay();
    const k = (n - 1) % 5;
    return { x: workArea.x + workArea.width - TASK.width - 24 - k * 28, y: workArea.y + 64 + k * 28 };
  }

  function uiFor(t) {
    return {
      point,
      explain,
      status: (text) => setState(t, "working", text),
      // Approvals belong to the task asking: its window comes forward (without stealing focus) and its chip turns amber.
      confirm: (summaryText, bounds) => {
        if (bounds) point(bounds, summaryText);
        if (!t.win.isVisible()) t.win.showInactive();
        setState(t, "confirm", `Waiting for your OK: ${summaryText}`);
        send(t, "task-confirm", { summary: summaryText });
        return new Promise((resolve) => (t.pendingConfirm = resolve));
      },
    };
  }

  /** Opens a task window. Pass `brain` to move an existing conversation (the bubble's) into it. */
  async function create({ brain = null, target = null } = {}) {
    if (tasks.size >= MAX_TASKS) return { error: `You can have ${MAX_TASKS} tasks open at once. Close one first.` };
    const n = ++seq;
    const t = { id: `t${n}`, n, title: `Task ${n}`, state: "idle", target: target ?? (await currentTarget()), pendingConfirm: null, busy: false };
    const ui = uiFor(t);
    if (brain) {
      brain.ui = { ...brain.ui, ...ui };
      t.brain = brain;
      const first = brain.transcript().find((m) => m.role === "user");
      if (first) t.title = shorten(first.text);
    } else {
      t.brain = makeBrain(ui);
      if (!t.brain) return { error: "Add your Anthropic API key first." };
    }

    t.win = new BrowserWindow({
      ...TASK,
      ...place(n),
      minWidth: 340,
      minHeight: 360,
      frame: false,
      show: false,
      skipTaskbar: true,
      backgroundColor: "#0c0d10",
      title: `Buddy · ${t.title}`,
      icon,
      webPreferences: { preload: path.join(here, "preload.cjs"), backgroundThrottling: false },
    });
    t.win.loadFile(path.join(here, "ui/task.html"));
    t.win.webContents.once("did-finish-load", () => {
      send(t, "task-init", { n, title: t.title, target: t.target ? `${t.target.app_name} — ${t.target.title}` : null, transcript: t.brain.transcript() });
      t.win.show();
      t.win.focus();
    });
    // Seeing a finished task's answer settles its chip.
    t.win.on("focus", () => {
      if (t.state === "done") setState(t, "idle");
    });
    t.win.on("show", changed);
    t.win.on("hide", changed);
    t.win.on("closed", () => stop(t));
    tasks.set(t.id, t);
    changed();
    return { id: t.id };
  }

  function stop(t) {
    if (!tasks.has(t.id)) return;
    tasks.delete(t.id);
    t.brain.cancel();
    t.pendingConfirm?.("deny");
    if (!t.win.isDestroyed()) t.win.destroy();
    changed();
  }

  // Island chip: open a tucked-away task, or tuck away an open one.
  function toggle(id) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.win.isVisible() && t.win.isFocused()) return t.win.hide();
    t.win.show();
    t.win.focus();
  }

  ipcMain.handle("task-ask", async (e, text) => {
    const t = fromSender(e.sender);
    if (!t || t.busy || !String(text).trim()) return { reply: null };
    t.busy = true;
    if (t.title === `Task ${t.n}`) {
      t.title = shorten(text);
      t.win.setTitle(`Buddy · ${t.title}`);
    }
    setState(t, "working", "Thinking…");
    try {
      const reply = await t.brain.ask(text, t.target);
      if (tasks.has(t.id)) setState(t, t.win.isFocused() ? "idle" : "done");
      return { reply, title: t.title };
    } catch (err) {
      if (tasks.has(t.id)) setState(t, "error", err.message);
      return { reply: `Something broke: ${err.message}`, title: t.title };
    } finally {
      t.busy = false;
    }
  });
  ipcMain.on("task-cancel", (e) => {
    const t = fromSender(e.sender);
    t?.brain.cancel();
    t?.pendingConfirm?.("deny");
  });
  ipcMain.on("task-confirm-reply", (e, decision) => {
    const t = fromSender(e.sender);
    if (!t?.pendingConfirm) return;
    t.pendingConfirm(decision);
    t.pendingConfirm = null;
    setState(t, "working", decision === "deny" ? "Okay, not doing that." : "Working…");
  });
  ipcMain.on("task-minimize", (e) => fromSender(e.sender)?.win.hide());
  ipcMain.on("task-close", (e) => {
    const t = fromSender(e.sender);
    if (t) stop(t);
  });

  return { create, toggle, list: summary, count: () => tasks.size };
}
