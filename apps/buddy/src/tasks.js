// Task agents: each task is its own Claude conversation in its own window. Minimizing a task tucks it into a chip
// on the island; closing it stops the agent. Tasks work side by side; anything that clicks or types takes turns
// (see takeTurn in brain.js), and each task asks for approval in its own window.
import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { canMoveTask, taskBusy } from "./modes.js";

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
 *   point: (bounds: import("./geometry.js").PhysicalRect, caption: string, owner: string) => Promise<void>, // the shared pointer; each task points as its own owner
 *   release: (owner: string, ms?: number) => void,     // lets go of the pointer if that owner still has it
 *   explain: (plate: object, observed: any) => void,  // opens a plate seen in `observed` (the task's window)
 *   onChange: (tasks: object[]) => void,               // the island's chips
 *   trace?: (entry: object) => void,                   // timing.log: a refused state change is a bug
 * }} deps
 */
export function createTasks({ here, icon, makeBrain, currentTarget, point, release, explain, onChange, trace }) {
  const tasks = new Map();
  let seq = 0;

  const summary = () =>
    [...tasks.values()].map((t) => ({ id: t.id, n: t.n, title: t.title, state: t.state, line: t.line, open: t.win.isVisible() }));
  const changed = () => onChange(summary());
  const fromSender = (sender) => [...tasks.values()].find((t) => !t.win.isDestroyed() && t.win.webContents === sender);
  const send = (t, channel, payload) => {
    if (!t.win.isDestroyed()) t.win.webContents.send(channel, payload);
  };

  // Every change of a task's state goes through here; a move modes.js TASK_NEXT doesn't allow is refused and logged.
  /** @param {any} t @param {import("./modes.js").TaskState} state @param {string} [line] */
  function setState(t, state, line) {
    if (!canMoveTask(t.state, state)) {
      trace?.({ kind: "refused-task-state", task: t.id, from: t.state, to: state });
      return false;
    }
    t.state = state;
    t.line = line ?? (state === "idle" || state === "done" ? t.brain?.transcript().filter((m) => m.role === "buddy").at(-1)?.text ?? "" : t.line);
    send(t, "task-state", { state, line, title: t.title });
    changed();
    return true;
  }

  // New windows cascade down from the top right, clear of the island.
  function place(n) {
    const { workArea } = screen.getPrimaryDisplay();
    const k = (n - 1) % 5;
    return { x: workArea.x + workArea.width - TASK.width - 24 - k * 28, y: workArea.y + 64 + k * 28 };
  }

  function uiFor(t) {
    return {
      point: (bounds, caption) => point(bounds, caption, t.id),
      explain: (plate) => explain(plate, t.target),
      status: (text) => setState(t, "working", text),
      // Who made a change, in Settings › Activity.
      source: t.title,
      // Approvals belong to the task asking: its window comes forward (without stealing focus) and its chip turns amber.
      confirm: (summaryText, bounds, note) => {
        if (bounds) point(bounds, summaryText, t.id);
        if (!t.win.isVisible()) t.win.showInactive();
        setState(t, "confirm", `Waiting for your OK: ${summaryText}`);
        send(t, "task-confirm", { summary: summaryText, note });
        return new Promise((resolve) => (t.pendingConfirm = resolve));
      },
    };
  }

  /**
   * Opens a task window. Pass `brain` to move an existing conversation (the bubble's) into it. A routine passes its
   * `title` and `prompt`, `target: null` (it isn't about the window in front) and `tucked`, so it starts in the island.
   * @param {{ brain?: any, target?: any, title?: string, prompt?: string, tucked?: boolean }} [opts]
   */
  async function create({ brain = null, target, title, prompt, tucked = false } = {}) {
    if (tasks.size >= MAX_TASKS) return { error: `You can have ${MAX_TASKS} tasks open at once. Close one first.` };
    const n = ++seq;
    const t = { id: `t${n}`, n, title: title ? shorten(title) : `Task ${n}`, state: "idle", target: target === undefined ? await currentTarget() : target, pendingConfirm: null };
    const ui = uiFor(t);
    if (brain) {
      brain.ui = { ...brain.ui, ...ui };
      t.brain = brain;
      const first = brain.transcript().find((m) => m.role === "user");
      if (first) t.title = shorten(first.text);
    } else {
      t.brain = makeBrain(ui);
      if (!t.brain) return { error: "Choose how Buddy thinks first, in Settings › AI & privacy." };
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
      if (!tucked) {
        t.win.show();
        t.win.focus();
      }
      if (prompt) send(t, "task-prompt", prompt);
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
    t.pendingConfirm = null;
    release(t.id, 0);
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

  function open(id) {
    const t = tasks.get(id);
    if (!t) return;
    t.win.show();
    t.win.focus();
  }

  function reply(t, decision) {
    if (!t?.pendingConfirm) return;
    t.pendingConfirm(decision);
    t.pendingConfirm = null;
    send(t, "task-confirm-done");
    setState(t, "working", decision === "deny" ? "Okay, not doing that." : "Working…");
  }

  // The island's preview of a task: a live picture of its window, taken even while the window is tucked away
  // (stayHidden keeps a hidden window rendering for the capture without showing it).
  async function peek(id, width = 480) {
    const t = tasks.get(id);
    if (!t || t.win.isDestroyed()) return null;
    try {
      const img = await t.win.webContents.capturePage(undefined, { stayHidden: true });
      if (img.isEmpty()) return null;
      return `data:image/jpeg;base64,${img.resize({ width, quality: "good" }).toJPEG(82).toString("base64")}`;
    } catch {
      return null;
    }
  }

  ipcMain.handle("task-ask", async (e, text) => {
    const t = fromSender(e.sender);
    if (!t || taskBusy(t.state) || !String(text).trim()) return { reply: null };
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
      release(t.id);
    }
  });
  ipcMain.on("task-cancel", (e) => {
    const t = fromSender(e.sender);
    if (!t) return;
    t.brain.cancel();
    reply(t, "deny");
  });
  ipcMain.on("task-confirm-reply", (e, decision) => reply(fromSender(e.sender), decision));
  ipcMain.on("task-minimize", (e) => fromSender(e.sender)?.win.hide());
  ipcMain.on("task-close", (e) => {
    const t = fromSender(e.sender);
    if (t) stop(t);
  });

  return {
    create,
    toggle,
    open,
    peek,
    // From the island's preview: approve or refuse without opening the window, or close the task.
    answer: (id, decision) => reply(tasks.get(id), decision),
    close: (id) => tasks.has(id) && stop(tasks.get(id)),
    list: summary,
    count: () => tasks.size,
  };
}
