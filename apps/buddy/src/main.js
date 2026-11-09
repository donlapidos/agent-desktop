// Desktop Buddy: tray app, island, global hotkeys, pointer overlay, speech bubble and explainers around the Brain.
import {
  app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, screen,
  session, shell, systemPreferences, Tray, webContents,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Brain, SESSION_PREFIX, setAgentPolicy, setBrainDefaults, takeTurn } from "./brain.js";
import { dictationPaste, returnFocus } from "./approvals.js";
import { elementAt, elementsAt, foregroundWindow, listWindows, perform, resolveBinary, windowAt, windowsAt } from "./desktop.js";
import { renderExplainer } from "./explainer.js";
import { createTasks } from "./tasks.js";
import { asDipPoint, asDipRect, asPhysicalPoint, asPhysicalRect } from "./geometry.js";
import { BUSY, canMove } from "./modes.js";
import {
  ACCENTS, DEFAULTS, EFFORTS, HOTKEY_NAMES, MODELS, SPEED, VOICES, load as loadSettings, normalize as normalizeSettings,
  save as saveSettings, update as updateSettings,
} from "./settings.js";
import { createSettingsWindow } from "./settings-window.js";
import { describe as describeSchedule, nextRun, verdict as routineVerdict } from "./routines.js";
import os from "node:os";
import { createVoice } from "./voice.js";

/** @typedef {import("./geometry.js").DipPoint} DipPoint */
/** @typedef {import("./geometry.js").DipRect} DipRect */
/** @typedef {import("./geometry.js").PhysicalPoint} PhysicalPoint */
/** @typedef {import("./geometry.js").PhysicalRect} PhysicalRect */

const here = path.dirname(fileURLToPath(import.meta.url));
// Global shortcuts come from Settings (the defaults in settings.js avoid Ctrl+Alt+Space, the Claude desktop app's
// Quick Entry, and Ctrl+Alt+V, Paste Special in Office). BUDDY_*_HOTKEY environment variables override them.
/** @type {Record<import("./settings.js").HotkeyName, string | undefined>} */
const ENV_HOTKEYS = { ask: process.env.BUDDY_HOTKEY, talk: process.env.BUDDY_TALK_HOTKEY, mark: process.env.BUDDY_MARK_HOTKEY, explain: process.env.BUDDY_EXPLAIN_HOTKEY, dictate: process.env.BUDDY_DICTATE_HOTKEY };
const IDLE_RESET_MS = 15 * 60_000;
// The window starts at the top of the island so the card can slide out from under the pill; the card itself
// sits 46px down (see bubble.html).
const BUBBLE = { width: 400, height: 306 };
const BUBBLE_FOLD_MS = 300; // matches the close transition in bubble.html
// Tall enough for a task preview to drop out of the pill; everything below the pill is transparent and
// click-through unless a preview is showing.
const ISLAND = { width: 460, height: 440 };
const PEEK_EVERY_MS = 800;
const EXPLAINER = { width: 640, height: 760 };
const CROP = { width: 1200, height: 800 }; // physical px around the pointer sent with an explain request

const APP_ID = "Desktop Buddy";

// One Buddy at a time: launching it again (shortcut, Start menu) opens the Ask bubble in the running one.
if (!app.requestSingleInstanceLock()) app.quit();
// Chromium stops painting windows it thinks are covered, and it counts Buddy's full-screen transparent
// overlay as cover. That left the island blank, so always paint Buddy's windows.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// On this dual-GPU laptop the GPU compositor stopped putting Buddy's transparent windows on screen: the island
// rendered (its own capture showed it) and sat topmost, yet the screen stayed empty. Software compositing draws
// them reliably and is plenty for Buddy's small surfaces. BUDDY_GPU=1 turns acceleration back on.
if (!process.env.BUDDY_GPU) app.disableHardwareAcceleration();
app.on("second-instance", () => summon());

let tray, bubble, island, brain, tasks, voice;
let spokenTurn = false; // the question being answered was said out loud
let spokenLang = "en"; // the language it was said in (detected when Settings asks for it)
let heardLang = "en"; // the language of the last thing heard, waiting for the bubble to send it
let islandState = "idle";
let islandText; // what the island says, so it can be re-sent when a shortcut label changes
/** @type {import("./settings.js").Settings} */
let settings = normalizeSettings({}); // loaded from disk once the app is ready
let saying = "Speaking"; // the island's label while Buddy reads a reply aloud
const overlays = new Map();
// What Buddy is doing (see modes.js). `approval` is set while a "working" answer waits for the user's OK.
/** @typedef {import("./modes.js").Mode} Mode */
/** @type {Mode} */
let mode = "idle";
/** @type {((decision: string) => void) | null} */
let approval = null;

// The mode as it is now. Code that awaited something re-checks with this, because a hotkey or the bubble may have
// moved Buddy on in the meantime (the checker otherwise assumes `mode` can't change across an await).
/** @returns {Mode} */
const currentMode = () => mode;

// Every change of mode goes through here. A move modes.js doesn't allow is refused and logged to timing.log: it's a
// bug, and better caught than half-done.
/** @param {Mode} next @returns {boolean} whether the move happened */
function enter(next) {
  if (!canMove(mode, next)) {
    trace({ kind: "refused-mode-change", from: mode, to: next });
    return false;
  }
  mode = next;
  return true;
}
/** @type {{ n: number, displayId: number, points: DipPoint[], bbox: DipRect }[]} */
let marks = [];
let pendingMarks = null; // what the user highlighted, waiting for their question
let markWin = null; // the freeze-frame of the screen the user draws on
let markDisplay = null;
let bubbleHideTimer = null;
let lastAskAt = 0;
let target = null;
/** @type {DipPoint | null} */
let focusPoint = null; // where the current question is about; explainers open beside it
let explainerShown = false;

const ownPids = () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)];

// Crossing between DIP and physical pixels (see geometry.js). These are the only crossings.
/** @param {DipPoint} p @returns {PhysicalPoint} */
const toPhysicalPoint = (p) => asPhysicalPoint(process.platform === "win32" ? screen.dipToScreenPoint(p) : p);
/** @param {DipRect} r @returns {PhysicalRect} */
const toPhysicalRect = (r) => asPhysicalRect(process.platform === "win32" ? screen.dipToScreenRect(null, r) : r);
/** @param {PhysicalRect} r @returns {DipRect} */
const toDipRect = (r) => asDipRect(process.platform === "win32" ? screen.screenToDipRect(null, r) : r);
const cursor = () => asDipPoint(screen.getCursorScreenPoint());

// ---------- API key (encrypted at rest with the OS keychain) ----------

const keyFile = () => path.join(app.getPath("userData"), "api-key.bin");

function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return null;
  }
}

function saveApiKey(key) {
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
}

// ---------- Overlay: one transparent, click-through window per display ----------

function createOverlays() {
  for (const win of overlays.values()) win.destroy();
  overlays.clear();
  for (const display of screen.getAllDisplays()) {
    const win = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload: path.join(here, "preload.cjs"), backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(here, "ui/overlay.html"));
    win.once("ready-to-show", () => {
      win.showInactive();
      win.setBounds(display.bounds); // Windows clamps oversized windows to the work area on create
    });
    overlays.set(display.id, win);
  }
  island?.moveTop();
}

/** @param {DipPoint} point */
function overlayFor(point) {
  const display = screen.getDisplayNearestPoint(point);
  return { win: overlays.get(display.id), origin: display.bounds };
}

function broadcast(channel, payload) {
  for (const win of overlays.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

// Buddy's pointer follows the cursor, checking it 60 times a second while the mouse moves; once the mouse has been
// still for a moment, 20 a second is plenty to notice it moving again, and costs a third as much.
const CURSOR_FAST_MS = 16;
const CURSOR_SLOW_MS = 50;
const CURSOR_SETTLE_MS = 500;

function trackCursor() {
  let last = "";
  let movedAt = 0;
  const inside = new Map(); // overlay display id -> whether the cursor was on that display last time
  const tick = () => {
    const p = cursor();
    const key = `${p.x},${p.y}`;
    if (key !== last) {
      last = key;
      movedAt = Date.now();
      const displays = screen.getAllDisplays();
      for (const [id, win] of overlays) {
        const d = displays.find((x) => x.id === id);
        if (!d || win.isDestroyed()) continue;
        const on = p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height;
        // A display the cursor isn't on hears so once, not on every move elsewhere.
        if (on || inside.get(id) !== false) win.webContents.send("cursor", on ? { x: p.x - d.bounds.x, y: p.y - d.bounds.y } : null);
        inside.set(id, on);
      }
    }
    setTimeout(tick, Date.now() - movedAt < CURSOR_SETTLE_MS ? CURSOR_FAST_MS : CURSOR_SLOW_MS);
  };
  tick();
}

/** @param {PhysicalRect} physical */
function toLocalRect(physical) {
  /** @type {DipRect} */
  const dip = toDipRect(physical);
  const center = asDipPoint({ x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 });
  const { win, origin } = overlayFor(center);
  return { win, rect: { x: dip.x - origin.x, y: dip.y - origin.y, width: dip.width, height: dip.height } };
}

// The pointer belongs to whoever pointed last: the bubble's conversation ("bubble") or a task (its id). `n` counts
// points, so a release scheduled when one answer ends can't pull the pointer off a newer step.
const pointer = { owner: null, n: 0 };

/** @param {PhysicalRect} bounds @param {string} caption @param {string} [owner] */
function point(bounds, caption, owner = "bubble") {
  pointer.owner = owner;
  pointer.n++;
  const { win, rect } = toLocalRect(bounds);
  for (const other of overlays.values()) if (other !== win) other.webContents.send("release");
  win?.webContents.send("point", { rect, caption });
  return new Promise((r) => setTimeout(r, 900));
}

// Lets go of the pointer after a moment, if `owner` still has it and hasn't pointed again.
/** @param {string} owner @param {number} [ms] */
function releaseLater(owner, ms = 6000) {
  const n = pointer.n;
  setTimeout(() => {
    if (pointer.owner !== owner || pointer.n !== n) return;
    pointer.owner = null;
    broadcast("release");
  }, ms);
}

// ---------- Island: a status pill at the top of the primary display ----------

function createIsland() {
  const { workArea } = screen.getPrimaryDisplay();
  island = new BrowserWindow({
    ...ISLAND,
    x: Math.round(workArea.x + (workArea.width - ISLAND.width) / 2),
    y: workArea.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), backgroundThrottling: false },
  });
  island.setAlwaysOnTop(true, "screen-saver");
  island.setIgnoreMouseEvents(true, { forward: true });
  island.loadFile(path.join(here, "ui/island.html"));
  island.once("ready-to-show", () => island.showInactive());
  island.webContents.on("did-finish-load", () => {
    const taken = takenHotkeys();
    if (taken.length) setIsland("done", `${taken.map((n) => keyLabel(hotkey(n))).join(", ")} is used by another app: change it in Settings`);
    else setIsland("idle");
    if (tasks) island.webContents.send("tasks", tasks.list());
  });
  island.webContents.on("render-process-gone", () => {
    clearInterval(peekTimer);
    island.destroy();
    createIsland();
  });
}

function islandSlot() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: Math.round(workArea.x + (workArea.width - ISLAND.width) / 2), y: workArea.y, ...ISLAND };
}

// The island is Buddy's "on" light: while Buddy runs it stays on screen. Windows can drop a topmost
// window behind the Start menu, a full-screen app or a display change, so keep putting it back.
function keepIsland() {
  if (!island || island.isDestroyed()) return createIsland();
  const slot = islandSlot();
  const b = island.getBounds();
  if (b.x !== slot.x || b.y !== slot.y || b.width !== slot.width) island.setBounds(slot);
  if (!island.isVisible()) island.showInactive();
  // Re-applying "always on top" is the expensive part of this check, so only when Windows actually dropped it.
  if (!island.isAlwaysOnTop()) island.setAlwaysOnTop(true, "screen-saver");
  island.moveTop();
  // The island only lets clicks through again when its page sees the mouse leave. If that was missed and the
  // cursor is now elsewhere, its transparent area would keep catching clicks meant for the apps beneath it.
  const p = cursor();
  const nb = island.getBounds();
  const inside = p.x >= nb.x && p.x < nb.x + nb.width && p.y >= nb.y && p.y < nb.y + nb.height;
  if (islandHovered && !inside) {
    islandHovered = false;
    island.setIgnoreMouseEvents(true, { forward: true });
    island.webContents.send("island-leave");
  }
}

const keyLabel = (accel) => accel.replace("Control", "Ctrl").replace("CommandOrControl", "Ctrl");

function setIsland(state, text) {
  islandState = state;
  islandText = text;
  if (island && !island.isDestroyed()) island.webContents.send("island", { state, text, hotkey: keyLabel(hotkey("ask")), talkKey: keyLabel(hotkey("talk")) });
}

// The island when nothing is running: speaking while Buddy still talks, active while the bubble is open, else idle.
function restIsland() {
  if (voice?.speaking) setIsland("speaking", saying);
  else if (bubble.isVisible()) setIsland("active", "Listening");
  else setIsland("idle");
}

const status = (text) => {
  bubble.webContents.send("status", text);
  setIsland("busy", text);
};

const oneLine = (text) => (text.length > 70 ? `${text.slice(0, 67)}…` : text);

// ---------- Bubble: the prompt + speech window ----------

function createBubble() {
  bubble = new BrowserWindow({
    ...BUBBLE,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), backgroundThrottling: false },
  });
  bubble.setAlwaysOnTop(true, "pop-up-menu");
  bubble.loadFile(path.join(here, "ui/bubble.html"));
  // The approval card reports presses on it, so a lost Allow click can be traced to the window or the page.
  bubble.webContents.on("console-message", (e) => {
    if (e.message.startsWith("TRACE ")) trace({ kind: "bubble", note: e.message.slice(6) });
  });
  bubble.on("blur", () => {
    if (mode === "idle") hideBubble();
  });
  // Closing the bubble ends the conversation about what was marked.
  bubble.on("hide", () => {
    if (mode !== "idle") return;
    clearMarks();
    restIsland();
  });
  bubble.on("show", () => {
    if (mode === "idle") restIsland();
  });
}

// The bubble always hangs from the island, so the chat reads as the island opening up.
function placeBubble() {
  const slot = islandSlot();
  bubble.setBounds({ x: Math.round(slot.x + slot.width / 2 - BUBBLE.width / 2), y: slot.y, ...BUBBLE });
}

function showBubble({ focus = true } = {}) {
  clearTimeout(bubbleHideTimer);
  if (!bubble.isVisible()) placeBubble();
  if (focus) {
    bubble.show();
    bubble.focus();
  } else {
    bubble.showInactive();
  }
  // All topmost windows share one band on Windows, so focusing the bubble lifts it over the island; the
  // folded card has to stay under the pill it slides out of.
  if (island && !island.isDestroyed()) island.moveTop();
  bubble.webContents.send("bubble-open");
  island?.webContents.send("island-attach", true);
}

// Closing plays the bubble back into the island first; `now` skips that when the screen is about to be captured.
function hideBubble({ now = false } = {}) {
  clearTimeout(bubbleHideTimer);
  if (!bubble.isVisible()) return;
  bubble.webContents.send("bubble-close");
  island?.webContents.send("island-attach", false);
  if (now) bubble.hide();
  else bubbleHideTimer = setTimeout(() => bubble.hide(), BUBBLE_FOLD_MS);
}


// The main hotkey switches Buddy between idle and active: it opens the bubble, or closes it if it's open.
function toggle() {
  if (bubble.isVisible() && (mode === "idle" || mode === "listening")) {
    voice?.cancelListening();
    return hideBubble();
  }
  summon();
}

// Hand focus back to the user's app while we work, so keyboard actions land there.
// It only steps back (blur): it never switches itself to "can't take focus". On Windows, setFocusable(false) on a
// bubble that has been hidden and shown again leaves it deaf to every click, so an approval card or Stop can't be
// pressed (reproduced with real clicks). Clicking the card activates the bubble, so answering it hands the keyboard
// back again (answerApproval).
function releaseFocus() {
  bubble.blur();
  // Stepping back doesn't give the keyboard to another app on Windows, so hand it to the window the user was in.
  if (target) takeTurn(() => perform(returnFocus(target))).catch(() => {});
}

async function summon() {
  if (mode === "working" || mode === "reading-marks") return showBubble({ focus: false });
  if (Date.now() - lastAskAt > IDLE_RESET_MS) brain?.reset();
  target = await foregroundWindow(ownPids());
  focusPoint = cursor();
  bubble.webContents.send("summon", {
    target: target ? `${target.app_name} — ${target.title}` : null,
    needsKey: !brain,
  });
  showBubble();
}

// ---------- Explain: capture around a point, ask the brain, show an infographic ----------

// The whole display as an image, with Buddy's own pointer hidden.
async function grabDisplay(display) {
  const sf = display.scaleFactor;
  const size = { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) };
  broadcast("hide-buddy", true);
  await new Promise((r) => setTimeout(r, 60));
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    return (sources.find((s) => s.display_id === String(display.id)) ?? sources[0]).thumbnail;
  } finally {
    broadcast("hide-buddy", false);
  }
}

/** @param {DipPoint} dipPoint */
async function captureAround(dipPoint) {
  const display = screen.getDisplayNearestPoint(dipPoint);
  const sf = display.scaleFactor;
  {
    const shot = await grabDisplay(display);
    const { width: W, height: H } = shot.getSize();
    const local = { x: Math.round((dipPoint.x - display.bounds.x) * sf), y: Math.round((dipPoint.y - display.bounds.y) * sf) };
    const cw = Math.min(CROP.width, W);
    const ch = Math.min(CROP.height, H);
    const rect = {
      x: Math.min(Math.max(local.x - cw / 2, 0), W - cw),
      y: Math.min(Math.max(local.y - ch / 2, 0), H - ch),
      width: cw,
      height: ch,
    };
    const crop = shot.crop(rect);
    return { image: crop.toPNG().toString("base64"), tip: { x: local.x - rect.x, y: local.y - rect.y } };
  }
}

/** @param {DipPoint} dipPoint @param {string} [question] */
function explainAt(dipPoint, question) {
  if (mode !== "idle") return;
  if (!brain) return summon();
  enter("working");
  return runExplain(dipPoint, question);
}

// Expects mode "working", set by the caller.
/** @param {DipPoint} dipPoint @param {string} [question] */
async function runExplain(dipPoint, question) {
  spokenTurn = false;
  lastAskAt = Date.now();
  focusPoint = dipPoint;
  explainerShown = false;
  setIsland("busy", "Looking at that…");
  try {
    const physical = toPhysicalPoint(dipPoint);
    const [win, shot] = await Promise.all([windowAt(physical, ownPids()), captureAround(dipPoint)]);
    target = win;
    const element = await elementAt(win, physical);
    const reply = await brain.explain({ ...shot, element, target: win, question });
    if (explainerShown) {
      setIsland("done", oneLine(reply));
    } else {
      setIsland("done", "Answered");
      bubble.webContents.send("status", "");
      bubble.webContents.send("reply", reply);
      showBubble({ focus: false });
    }
  } catch (err) {
    setIsland("done", `Couldn't explain that: ${err.message}`);
  } finally {
    enter("idle");
    releaseLater("bubble");
  }
}

// ---------- Marker: highlight things on screen with a pen, then ask about them ----------

/** @param {DipPoint[]} points @returns {DipRect} */
function bboxOf(points, pad = 10) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return asDipRect({ x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y });
}

// Marking draws on a still of the screen in an opaque window (like the Snipping Tool). Drawing straight on the
// transparent overlay meant Windows repainted the whole screen for every stroke segment, which lagged.
async function startMarking() {
  if (mode !== "idle") return;
  if (!brain) return summon();
  clearMarks();
  enter("marking");
  hideBubble({ now: true });
  setIsland("picking", "Getting the screen ready…");
  markDisplay = screen.getDisplayNearestPoint(cursor());
  try {
    const shot = await grabDisplay(markDisplay);
    if (currentMode() !== "marking") return;
    const win = new BrowserWindow({
      ...markDisplay.bounds,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: "#000000",
      webPreferences: { preload: path.join(here, "preload.cjs"), backgroundThrottling: false },
    });
    markWin = win;
    win.setAlwaysOnTop(true, "screen-saver");
    win.on("closed", () => {
      if (markWin === win) markWin = null;
      cancelMarking();
    });
    win.webContents.once("did-finish-load", () => win.webContents.send("mark-start", { png: shot.toPNG() }));
    win.loadFile(path.join(here, "ui/marker.html"));
  } catch (err) {
    stopMarkMode();
    enter("idle");
    setIsland("done", `Couldn't start marking: ${err.message}`);
  }
}

// Takes the still down; the caller decides what mode comes next.
// `delay` keeps the still up a moment so the overlay can paint the finished marks underneath first.
function stopMarkMode(delay = 0) {
  globalShortcut.unregister("Return");
  globalShortcut.unregister("Escape");
  const win = markWin;
  markWin = null;
  if (win && !win.isDestroyed()) setTimeout(() => win.isDestroyed() || win.destroy(), delay);
}

function clearMarks() {
  marks = [];
  pendingMarks = null;
  broadcast("marks-clear");
  brain?.marks?.clear();
}

function cancelMarking() {
  if (mode !== "marking") return;
  stopMarkMode();
  clearMarks();
  enter("idle");
  restIsland();
}

const dedupe = (els) => [...new Map(els.map((e) => [e.path, e])).values()];
const markLabel = (m) => {
  const e = m.elements.find((x) => x.name) ?? m.elements[0];
  const text = String(e?.name || e?.value || e?.role || "an area");
  return text.length > 28 ? text.slice(0, 26) + "…" : text;
};

/** @param {{ image?: unknown, strokes?: unknown }} [result] what marker.html sent: untrusted, checked below */
async function finishMarking({ image, strokes } = {}) {
  if (mode !== "marking" || !markDisplay) return;
  const display = markDisplay;
  const valid = (Array.isArray(strokes) ? strokes : []).filter((s) => Array.isArray(s?.points) && s.points.length).slice(0, 50);
  if (!valid.length || typeof image !== "string") return cancelMarking();

  // Hand the marks to the overlay so they stay on screen, then let the still go.
  const overlay = overlays.get(display.id);
  marks = valid.map((s, i) => {
    const local = s.points.slice(0, 4000).map((p) => ({ x: Number(p.x), y: Number(p.y) }));
    overlay?.webContents.send("mark-drawn", { points: local, n: i + 1 });
    const points = local.map((p) => asDipPoint({ x: display.bounds.x + p.x, y: display.bounds.y + p.y }));
    return { n: i + 1, displayId: display.id, points, bbox: bboxOf(points) };
  });
  stopMarkMode(90);
  enter("reading-marks");
  setIsland("busy", "Reading what you marked…");
  try {
    // Sample each stroke at its start, middle and end, and read the elements under those points.
    const samples = marks
      .flatMap((m) => [m.points[0], m.points[Math.floor(m.points.length / 2)], m.points.at(-1)])
      .map(toPhysicalPoint);
    const wins = await windowsAt(samples, ownPids());
    const groups = new Map();
    samples.forEach((p, i) => {
      if (!wins[i]) return;
      if (!groups.has(wins[i].id)) groups.set(wins[i].id, { win: wins[i], idx: [] });
      groups.get(wins[i].id).idx.push(i);
    });
    const found = new Array(samples.length).fill(null);
    await Promise.all(
      [...groups.values()].map(async ({ win, idx }) => {
        const els = await elementsAt(win, idx.map((i) => samples[i]));
        idx.forEach((i, j) => (found[i] = els[j]));
      }),
    );

    pendingMarks = {
      image,
      target: wins.find(Boolean) ?? null,
      marks: marks.map((m, i) => ({
        n: m.n,
        bounds: toPhysicalRect(m.bbox),
        elements: dedupe(found.slice(i * 3, i * 3 + 3).filter(Boolean)),
      })),
    };
    target = pendingMarks.target;
    const last = marks.at(-1).bbox;
    focusPoint = asDipPoint({ x: last.x + last.width, y: last.y + last.height });
    bubble.webContents.send("summon", { target: target ? target.app_name + " — " + target.title : null, needsKey: !brain });
    bubble.webContents.send("marks", pendingMarks.marks.map((m) => ({ n: m.n, label: markLabel(m) })));
    enter("idle");
    showBubble();
    restIsland();
  } catch (err) {
    enter("idle");
    clearMarks();
    setIsland("done", "Couldn't read the marks: " + err.message);
  }
}

const fromMarker = (e) => markWin && e.sender === markWin.webContents;
ipcMain.on("mark-ready", (e) => {
  if (!fromMarker(e)) return;
  markWin.show();
  markWin.setBounds(markDisplay.bounds); // Windows clamps oversized windows to the work area on create
  markWin.focus();
  keepIsland();
  setIsland("picking", "Click to explain · draw to ask");
  // Backups in case Windows refuses the still keyboard focus.
  globalShortcut.register("Return", () => markWin?.webContents.send("mark-command", "done"));
  globalShortcut.register("Escape", cancelMarking);
});
ipcMain.on("mark-count", (e, n) => {
  if (fromMarker(e)) setIsland("picking", n ? `${n} marked · Enter to ask` : "Click to explain · draw to ask");
});
ipcMain.on("mark-finish", (e, result) => {
  if (fromMarker(e)) finishMarking(result);
});
ipcMain.on("mark-cancel", () => cancelMarking());
// A single click in mark mode (before anything is drawn) explains the thing clicked.
ipcMain.on("mark-click", (e, local) => {
  if (!fromMarker(e) || !local) return;
  const dip = asDipPoint({ x: markDisplay.bounds.x + Number(local.x), y: markDisplay.bounds.y + Number(local.y) });
  stopMarkMode();
  enter("working");
  setIsland("busy", "Looking at that…");
  // Let the still close before the screen is captured for the explainer.
  setTimeout(() => runExplain(dip), 120);
});

// Model-written plates run with JavaScript off, a strict CSP, and a session that refuses every network request.
const EXPLAINER_PARTITION = "explainer";

function lockExplainerSession() {
  const plates = session.fromPartition(EXPLAINER_PARTITION);
  plates.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !/^(file|data):/.test(details.url) });
  });
  plates.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  // Only Buddy's voice page may open the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    done(permission !== "media" || wc.getURL().endsWith("/ui/voice.html"));
  });
}

const appLabel = (win) => win?.app_name?.replace(/\.exe$/i, "") || null;

// `near` is where the plate opens beside; `observed` is the window the subject was seen in. Callers pass their own,
// so a task's plate doesn't borrow the bubble's place or app.
/** @param {any} explainer @param {{ near?: DipPoint, observed?: { app_name?: string } | null }} [where] */
function openExplainer(explainer, { near = cursor(), observed = null } = {}) {
  const dir = path.join(app.getPath("userData"), "explainers");
  fs.mkdirSync(dir, { recursive: true });
  const plateNo = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length + 1;
  const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const reducedMotion = process.platform === "win32" && systemPreferences.getAnimationSettings().prefersReducedMotion;
  const page = renderExplainer(explainer, { plateNo, observedIn: appLabel(observed), date, reducedMotion });
  const file = path.join(dir, `${Date.now()}.html`);
  fs.writeFileSync(file, page);
  const title = explainer.common_name ?? "Explainer";

  const anchor = near;
  const { workArea } = screen.getDisplayNearestPoint(anchor);
  const w = Math.min(EXPLAINER.width, workArea.width - 32);
  const h = Math.min(EXPLAINER.height, workArea.height - 32);
  const right = anchor.x + 40 + w <= workArea.x + workArea.width;
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(right ? anchor.x + 40 : Math.max(workArea.x + 16, anchor.x - 40 - w)),
    y: Math.round(Math.min(Math.max(anchor.y - h / 3, workArea.y + 16), workArea.y + workArea.height - h - 16)),
    title,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: dark ? "#131815" : "#f2f4f0", symbolColor: dark ? "#aab5ad" : "#4c5650", height: 40 },
    backgroundColor: dark ? "#131815" : "#f2f4f0",
    icon: ICON,
    // JavaScript is on only for the motion player: each plate's CSP admits that one script by hash, the model's
    // SVG is sanitized, and the partition still refuses every network request.
    webPreferences: { javascript: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: EXPLAINER_PARTITION, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(file);
  win.once("ready-to-show", () => win.showInactive());
}

// ---------- IPC ----------

ipcMain.handle("ask", async (_e, text, opts = {}) => {
  if (!brain) return { reply: "Add your Anthropic API key first." };
  // Typed while the mic was open: the typing wins.
  if (mode === "listening") voice.cancelListening();
  else if (mode !== "idle") return { reply: BUSY[mode] };
  enter("working");
  lastAskAt = Date.now();
  explainerShown = false;
  spokenTurn = !!opts?.spoken;
  spokenLang = spokenTurn ? heardLang : "en";
  voice?.hush();
  releaseFocus();
  setIsland("busy", "Thinking…");
  let reply;
  try {
    const withMarks = pendingMarks;
    pendingMarks = null;
    const how = { spoken: spokenTurn, lang: spokenLang };
    reply = withMarks ? await brain.askWithMarks(text, withMarks, how) : await brain.ask(text, target, how);
  } catch (err) {
    setIsland("done", "Something broke");
    return { reply: `Something broke: ${err.message}` };
  } finally {
    enter("idle");
    releaseLater("bubble");
  }
  setIsland("done", oneLine(reply));
  // After the mode is back to idle, so the island shows Buddy speaking (and a click stops it).
  if (talksBack(spokenTurn)) speak(reply);
  return { reply };
});

ipcMain.handle("set-key", (_e, key) => {
  saveApiKey(key.trim());
  startBrain();
  return { ok: !!brain };
});

ipcMain.on("cancel", () => {
  voice?.cancelListening();
  voice?.hush();
  brain?.cancel();
  answerApproval("deny");
});
ipcMain.on("reset", () => {
  brain?.reset();
  clearMarks();
});
ipcMain.on("hide", () => {
  voice?.hush();
  hideBubble();
});
ipcMain.on("confirm-reply", (_e, decision) => {
  trace({ kind: "confirm-reply", decision, waiting: !!approval });
  answerApproval(decision);
});
let islandHovered = false;
ipcMain.on("island-hover", (_e, inside) => {
  islandHovered = !!inside;
  island.setIgnoreMouseEvents(!inside, { forward: true });
});
ipcMain.on("island-action", (_e, action) => {
  const [verb, id] = String(action).split(":");
  if (verb === "ask") summon();
  else if (verb === "settings") settingsWindow.open();
  else if (verb === "mark") startMarking();
  else if (verb === "talk") talk();
  else if (verb === "hush") voice?.hush();
  else if (verb === "show") showBubble({ focus: false });
  else if (verb === "settle" && mode === "idle") restIsland();
  else if (verb === "task" && !id) newTask();
  else if (verb === "task") tasks.toggle(id);
  else if (verb === "task-open") tasks.open(id);
  else if (verb === "task-allow") tasks.answer(id, "allow");
  else if (verb === "task-deny") tasks.answer(id, "deny");
  else if (verb === "task-close") tasks.close(id);
});

// While the island previews a task, refresh the picture of its window.
let peekTimer = null;
ipcMain.on("task-peek", (_e, id) => {
  clearInterval(peekTimer);
  peekTimer = null;
  if (!id) return;
  const refresh = async () => {
    const src = await tasks.peek(id);
    if (island && !island.isDestroyed()) island.webContents.send("task-peek", { id, src });
  };
  refresh();
  peekTimer = setInterval(refresh, PEEK_EVERY_MS);
});

// `summary` says exactly what will happen; `note` is Claude's own description, shown smaller under it.
/** @param {string} summary @param {PhysicalRect | null} bounds @param {string} [note] @returns {Promise<string>} */
function confirm(summary, bounds, note) {
  trace({ kind: "confirm-shown", bubbleVisible: bubble.isVisible(), focusable: bubble.isFocusable(), bounds: bubble.getBounds() });
  if (bounds) point(bounds, summary);
  showBubble({ focus: false });
  bubble.webContents.send("confirm", { summary, note });
  setIsland("confirm", `Waiting for your OK: ${summary}`);
  return new Promise((resolve) => {
    approval = resolve;
  });
}

// The one way out of waiting for an OK, whether answered on the card or cancelled with Esc or Stop.
function answerApproval(decision) {
  const resolve = approval;
  approval = null;
  if (!resolve) return;
  resolve(decision);
  releaseFocus(); // the click on the card activated the bubble; the user's app gets the keyboard back
  setIsland("busy", "Working…");
}

// When the bubble's own conversation starts guiding, the bubble folds back into the island: the pointer and its
// caption carry the step, and the bubble would otherwise sit over the ribbon or dialog they need to click.
/** @param {PhysicalRect} bounds @param {string} caption */
function guidePoint(bounds, caption) {
  if (mode === "working" && bubble.isVisible() && !approval) hideBubble();
  // In a spoken conversation Buddy says each step as it points, the way a person beside you would.
  if (caption && talksBack(spokenTurn)) voice.say(caption);
  return point(bounds, caption);
}

// ---------- Voice: talk to Buddy, and hear it talk back ----------

// Talk back: "spoken" (answer aloud when you spoke), "always", or "never".
const talksBack = (spoken) => !!voice && (settings.talkBack === "always" || (settings.talkBack === "spoken" && spoken));

const HEARD_ERRORS = {
  silence: "Didn't hear anything",
  "mic-blocked": "Microphone blocked: Settings › Privacy › Microphone",
  "no-mic": "No microphone found",
};

// The talk hotkey: start listening; pressed again while listening, stop and use what was said. It also cuts
// Buddy off mid-sentence.
async function talk() {
  if (!voice) return;
  if (mode === "listening") return voice.finishListening();
  const wasSpeaking = voice.speaking;
  voice.hush();
  if (mode !== "idle") return wasSpeaking || setIsland(islandState, BUSY[mode]);
  if (!brain) return summon();
  enter("listening");
  if (bubble.isVisible()) showBubble();
  else await summon();
  bubble.webContents.send("listening", true);
  setIsland("listening", "Listening…");
  const { text, error, lang } = await voice.listen();
  heardLang = lang ?? "en";
  bubble.webContents.send("listening", false);
  // Something else took over meanwhile (they typed the question instead): leave it be.
  if (currentMode() !== "listening") return;
  enter("idle");
  if (text) return bubble.webContents.send("voice-text", text);
  if (error === "cancelled") return restIsland();
  setIsland("done", HEARD_ERRORS[error] ?? `Couldn't hear you: ${error}`);
}

// ---------- Dictation: say it, and it's typed where you are ----------

// The dictation key: start; pressed again, stop (and type what's left). It needs no API key: nothing leaves the PC.
async function dictate() {
  if (!voice) return;
  if (mode === "dictating") return voice.finishListening();
  const wasSpeaking = voice.speaking;
  voice.hush();
  if (mode !== "idle") return wasSpeaking || setIsland(islandState, BUSY[mode]);
  enter("dictating");
  const continuous = settings.dictateStop === "press";
  const key = keyLabel(hotkey("dictate"));
  setIsland("listening", continuous ? `Dictating… ${key} to stop` : "Dictating… pause when you're done");
  let words = 0;
  const result = await voice.dictate({
    continuous,
    onText: async (text) => {
      await typeText(words ? ` ${text}` : text);
      words += text.split(/\s+/).filter(Boolean).length;
      if (continuous && currentMode() === "dictating") setIsland("listening", `Dictating… ${words} words · ${key} to stop`);
    },
  });
  enter("idle");
  if (result.pieces) setIsland("done", `Typed ${words} word${words === 1 ? "" : "s"}`);
  else if (result.error === "cancelled") restIsland();
  else setIsland("done", HEARD_ERRORS[result.error] ?? `Couldn't hear you: ${result.error}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Types dictated text into whatever app has the keyboard: through the clipboard and one paste (Ctrl+V), the way
// dictation tools on Windows do, then puts back what the clipboard held. The paste is the user's own doing, so its
// slip comes from approvals.dictationPaste(), which can only ever paste. It takes its turn with agents' actions.
async function typeText(text) {
  // Electron 45's clipboard is asynchronous and W3C-shaped. Every format on it is copied out first (an item read from
  // the clipboard can still point at it, and the dictated text is about to replace what's there).
  const saved = [];
  for (const item of await clipboard.read().catch(() => [])) {
    const parts = {};
    for (const type of item.types) parts[type] = await item.getType(type).catch(() => null);
    const kept = Object.fromEntries(Object.entries(parts).filter(([, v]) => v != null));
    if (Object.keys(kept).length) saved.push(new ClipboardItem(kept));
  }
  await clipboard.writeText(text);
  const res = await takeTurn(() => perform(dictationPaste()));
  if ("error" in res) trace({ kind: "dictation-paste-failed", error: res.error.code });
  await wait(300); // the app reads the clipboard as it pastes; give it a moment before the old contents go back
  if ((await clipboard.readText()) !== text) return; // the user copied something meanwhile: keep theirs
  if (saved.length) await clipboard.write(saved);
  else clipboard.clear();
}

// Reads a reply aloud; the island shows it while Buddy speaks.
function speak(text) {
  saying = oneLine(text);
  voice.say(text);
}
ipcMain.on("talk", () => talk());

let downloadSettle = null; // returns the island to rest once download progress stops coming
function onVoiceState(state, info) {
  if (state === "listening" && mode === "listening") setIsland("listening", "Listening… pause when you're done");
  else if (state === "transcribing" && mode === "listening") setIsland("busy", "Got it…");
  // While a question runs, the island shows its progress; spoken guide steps don't take it over.
  else if (state === "speaking" && mode === "idle") setIsland("speaking", saying);
  else if (state === "quiet" && islandState === "speaking") restIsland();
  else if (state === "downloading" && mode === "idle") {
    setIsland("busy", `Getting Buddy's ${info.what === "speaking" ? "voice" : "ears"} ready… ${Math.round((100 * info.loaded) / info.total)}%`);
    clearTimeout(downloadSettle);
    downloadSettle = setTimeout(() => islandState === "busy" && mode === "idle" && restIsland(), 4000);
  }
}

function startVoice() {
  voice = createVoice({
    here,
    cacheDir: process.env.BUDDY_MODELS_DIR ?? path.join(app.getPath("userData"), "models"),
    // BUDDY_VOICE (0-9) overrides the voice chosen in Settings.
    // Spoken replies use the language the question was asked in.
    getVoice: () => ({ sid: process.env.BUDDY_VOICE ? Number(process.env.BUDDY_VOICE) : settings.voice, speed: settings.speed, lang: spokenTurn ? spokenLang : "en" }),
    getLanguage: () => settings.language,
    onState: onVoiceState,
    onLevel: (level) => island?.isDestroyed() || island?.webContents.send("voice-level", level),
    trace,
  });
  setTimeout(() => voice.prepare(), 4000);
}

// Timing log (userData/timing.log, JSON lines): how long each model call and tool took, to find slow steps.
function trace(entry) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "timing.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// Each Brain keeps its snapshots in its own agent-desktop session (brain.js). Those from earlier runs are dead
// weight under ~/.agent-desktop/sessions, so they go at startup; only Buddy's own (buddy-*) are touched.
function clearOldSessions() {
  const root = path.join(process.env.AGENT_DESKTOP_HOME ?? path.join(app.getPath("home"), ".agent-desktop"), "sessions");
  try {
    for (const dir of fs.readdirSync(root)) {
      if (dir.startsWith(SESSION_PREFIX) && !dir.startsWith(`${SESSION_PREFIX}${process.pid}-`)) {
        fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      }
    }
  } catch {}
}

// Where create_document saves, and how it opens the result (Word, or whatever opens .docx here).
const documentsDir = () => path.join(app.getPath("documents"), "Buddy");
const openFile = (file) => shell.openPath(file);

// The bubble's plates open beside what the user pointed at and say which app it was in.
function bubbleExplain(plate) {
  explainerShown = true;
  openExplainer(plate, { near: focusPoint ?? cursor(), observed: target });
}

function startBrain() {
  const apiKey = loadApiKey();
  brain = apiKey
    ? new Brain({ apiKey, point: guidePoint, confirm, status, explain: bubbleExplain, trace, documentsDir: documentsDir(), openFile })
    : null;
}

// ---------- Tasks: agents with their own windows, tucked into island chips ----------

function startTasks() {
  tasks = createTasks({
    here,
    icon: ICON,
    makeBrain: (ui) => {
      const apiKey = loadApiKey();
      return apiKey ? new Brain({ apiKey, trace, documentsDir: documentsDir(), openFile, ...ui }) : null;
    },
    currentTarget: () => foregroundWindow(ownPids()),
    point,
    release: releaseLater,
    explain: (plate, observed) => openExplainer(plate, { observed }),
    onChange: (list) => {
      if (island && !island.isDestroyed()) island.webContents.send("tasks", list);
    },
  });
}

// A fresh task, or (from the bubble) the current conversation moved into its own window so it can keep going
// while the bubble is free for something else.
async function newTask({ fromBubble = false } = {}) {
  if (!brain) return summon();
  if (fromBubble && mode !== "idle") return setIsland("done", "Let Buddy finish this answer, then make it a task");
  let result;
  if (fromBubble && brain.transcript().length) {
    result = await tasks.create({ brain, target });
    if (!result.error) {
      startBrain();
      clearMarks();
      bubble.webContents.send("reply", "");
    }
  } else {
    result = await tasks.create();
  }
  if (result.error) setIsland("done", result.error);
  else hideBubble({ now: true });
}
ipcMain.on("new-task", () => newTask({ fromBubble: true }));

// ---------- Tray ----------

// Icons are generated by scripts/make-icon.js from the same pointer shape the overlay draws.
const ICON = path.join(here, "../assets/buddy.ico");
const trayIcon = () => nativeImage.createFromPath(path.join(here, "../assets/tray.png")).resize({ width: 16, height: 16, quality: "best" });

const pretty = (accel) => accel.replaceAll("+", " + ");

// ---------- Launching without a terminal: shortcuts and start-with-Windows ----------

// Run as `electron <app dir>`, so every launcher passes the app directory to the Electron binary.
const LAUNCH = { path: process.execPath, args: [app.getAppPath()] };

const startsWithWindows = () => app.getLoginItemSettings(LAUNCH).openAtLogin;
const setStartsWithWindows = (on) => app.setLoginItemSettings({ openAtLogin: on, ...LAUNCH });

function writeShortcuts() {
  const link = {
    target: LAUNCH.path,
    args: `"${LAUNCH.args[0]}"`,
    icon: ICON,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: `Desktop Buddy: ask about anything on your screen (${keyLabel(hotkey("ask"))})`,
  };
  const startMenu = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Desktop Buddy.lnk");
  const desktop = path.join(app.getPath("desktop"), "Desktop Buddy.lnk");
  // "create" writes or overwrites; "replace" only overwrites an existing link, so it silently made nothing.
  return [startMenu, desktop].map((file) => {
    const ok = shell.writeShortcutLink(file, "create", link);
    if (!ok) console.error(`Could not write ${file}`);
    return ok;
  });
}

// Once per install: put Buddy in Start and on the desktop, and start it at sign-in. Later Settings owns both.
function firstRunSetup() {
  if (process.platform !== "win32" || settings.launchSetupDone) return;
  writeShortcuts();
  setStartsWithWindows(true);
  changeSettings({ launchSetupDone: true });
}

// ---------- Settings: stored in settings.js, applied here the moment they change ----------

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Applies a change from the Settings window (or the tray). Shortcuts are tried before they're kept: one another app
 * already owns is refused and reported, and the old one stays. Returns the reason each refused field was refused.
 * @param {any} patch
 * @returns {Record<string, string>}
 */
function changeSettings(patch) {
  const before = settings;
  const { settings: next, rejected } = updateSettings(settings, patch);
  /** @type {Record<string, string>} */
  const problems = {};
  for (const field of rejected) {
    const name = field.startsWith("hotkeys.") ? field.slice(8) : null;
    const clash = name && HOTKEY_NAMES.find((other) => other !== name && next.hotkeys[other] === patch.hotkeys?.[name]);
    problems[field] = clash ? `Already used for ${HOTKEY_LABELS[clash]}` : "That value isn't allowed";
  }
  for (const name of HOTKEY_NAMES) {
    const accel = next.hotkeys[name];
    if (accel === before.hotkeys[name] || ENV_HOTKEYS[name]) continue;
    if (!hotkeyIsFree(accel)) {
      next.hotkeys[name] = before.hotkeys[name];
      problems[`hotkeys.${name}`] = "Another app already uses this shortcut";
    }
  }
  settings = next;
  saveSettings(settingsFile(), settings);
  if (!hotkeysSuspended && JSON.stringify(next.hotkeys) !== JSON.stringify(before.hotkeys)) registerHotkeys();
  if (next.accent !== before.accent) paintAccentEverywhere();
  if (next.appearance !== before.appearance) applyAppearance();
  if (next.model !== before.model || next.effort !== before.effort) setBrainDefaults(settings);
  setAgentPolicy(settings);
  if (next.language !== before.language) voice?.prepare();
  if (next.talkBack === "never" && before.talkBack !== "never") voice?.hush();
  buildTrayMenu();
  setIsland(islandState, islandText);
  settingsWindow?.refresh();
  return problems;
}

function applyAppearance() {
  nativeTheme.themeSource = /** @type {"system" | "light" | "dark"} */ (process.env.BUDDY_THEME ?? settings.appearance);
}

// The accent colour reaches every Buddy window as one CSS variable (--buddy) that each page draws its accents from.
// Explainer plates keep their own palette: they live in a separate session and are never painted.
const accentCss = new WeakMap(); // webContents -> key of the CSS inserted into it
async function paintAccent(wc) {
  if (wc.isDestroyed() || wc.session !== session.defaultSession) return;
  const old = accentCss.get(wc);
  const key = await wc.insertCSS(`:root { --buddy: ${ACCENTS[settings.accent].hex} !important; }`);
  accentCss.set(wc, key);
  if (old) wc.removeInsertedCSS(old).catch(() => {});
}
const paintAccentEverywhere = () => {
  for (const wc of webContents.getAllWebContents()) paintAccent(wc).catch(() => {});
};
app.on("web-contents-created", (_e, wc) => wc.on("did-finish-load", () => paintAccent(wc).catch(() => {})));

// ---------- Global shortcuts ----------

const HOTKEY_LABELS = { ask: "Ask", talk: "Talk", mark: "Mark", explain: "Explain", dictate: "Dictate" };
const HOTKEY_ACTIONS = { ask: () => toggle(), talk: () => talk(), mark: () => startMarking(), explain: () => explainAt(cursor()), dictate: () => dictate() };
/** @param {import("./settings.js").HotkeyName} name */
const hotkey = (name) => ENV_HOTKEYS[name] ?? settings.hotkeys[name];
const held = new Map(); // shortcut name -> the accelerator Buddy holds for it
let hotkeysSuspended = false;

// Another app may already own a shortcut; Windows gives it to whoever registered first.
function hotkeyIsFree(accel) {
  if ([...held.values()].includes(accel)) return true;
  if (!globalShortcut.register(accel, () => {})) return false;
  globalShortcut.unregister(accel);
  return true;
}

function registerHotkeys() {
  for (const accel of held.values()) globalShortcut.unregister(accel);
  held.clear();
  for (const name of HOTKEY_NAMES) {
    const accel = hotkey(name);
    if (globalShortcut.register(accel, HOTKEY_ACTIONS[name])) held.set(name, accel);
    else console.error(`Could not register ${accel}`);
  }
}

// While the Settings window records a new shortcut, Buddy lets go of its own, so pressing one of them is recorded
// instead of opening the bubble or the mic.
function suspendHotkeys(on) {
  hotkeysSuspended = on;
  if (on) {
    for (const accel of held.values()) globalShortcut.unregister(accel);
    held.clear();
  } else registerHotkeys();
}

/** Shortcuts Buddy couldn't take because another app owns them. */
const takenHotkeys = () => (hotkeysSuspended ? [] : HOTKEY_NAMES.filter((n) => !held.has(n)));

// ---------- Tray ----------

function createTray() {
  tray = new Tray(trayIcon());
  tray.on("click", () => summon());
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`Desktop Buddy — ask: ${pretty(keyLabel(hotkey("ask")))} · talk: ${pretty(keyLabel(hotkey("talk")))}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Ask Buddy  (${keyLabel(hotkey("ask"))})`, click: () => summon() },
      { label: `Talk to Buddy  (${keyLabel(hotkey("talk"))})`, click: () => talk() },
      { label: `Mark or explain something  (${keyLabel(hotkey("mark"))})`, click: () => startMarking() },
      { label: "New conversation", click: () => brain?.reset() },
      { label: "New task window", click: () => newTask() },
      { type: "separator" },
      { label: "Settings…", click: () => settingsWindow.open() },
      { label: "Recreate shortcuts", visible: process.platform === "win32", click: writeShortcuts },
      { type: "separator" },
      { label: `agent-desktop: ${path.basename(resolveBinary())}`, enabled: false },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

// ---------- The Settings window ----------

const PREVIEW_LINE = "Hi, I'm Buddy. Click the Formulas tab, and I'll show you the next step.";
const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const explainersDir = () => path.join(app.getPath("userData"), "explainers");
const timingLog = () => path.join(app.getPath("userData"), "timing.log");

// What the Settings page shows. The API key itself never leaves this process: the page only learns whether one is saved.
function settingsState() {
  let explainers = 0;
  let logBytes = 0;
  try {
    explainers = fs.readdirSync(explainersDir()).filter((f) => f.endsWith(".html")).length;
  } catch {}
  try {
    logBytes = fs.statSync(timingLog()).size;
  } catch {}
  return {
    settings,
    accents: ACCENTS,
    models: MODELS,
    efforts: EFFORTS,
    voices: VOICES,
    speed: SPEED,
    defaultHotkeys: DEFAULTS.hotkeys,
    labels: HOTKEY_LABELS,
    // Set by environment variables, which win over Settings; the page shows these as fixed.
    fixed: {
      hotkeys: HOTKEY_NAMES.filter((n) => ENV_HOTKEYS[n]),
      voice: !!process.env.BUDDY_VOICE,
      model: !!process.env.BUDDY_MODEL,
      effort: !!process.env.BUDDY_EFFORT,
      appearance: !!process.env.BUDDY_THEME,
    },
    taken: takenHotkeys(),
    key: { saved: fs.existsSync(keyFile()), fromEnv: !!process.env.ANTHROPIC_API_KEY },
    startsWithWindows: process.platform === "win32" && startsWithWindows(),
    data: { explainers, logBytes },
    routineInfo: Object.fromEntries(
      settings.routines.map((r) => [
        r.id,
        { schedule: describeSchedule(r.schedule), next: r.enabled ? nextRun(r.schedule, new Date()).toISOString() : null, status: routineStatus.get(r.id) ?? null },
      ]),
    ),
  };
}

// ---------- Routines: tasks Buddy starts on a schedule (routines.js says when) ----------

const ROUTINE_CHECK_MS = 30_000;
const routineWatched = new Map(); // routine id -> when Buddy started watching it (switched on, or Buddy started)
const routineStatus = new Map(); // routine id -> what happened last, for Settings

const markRoutine = (id, patch) => changeSettings({ routines: settings.routines.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

// Starts a routine as a task tucked into the island. It isn't about whatever window happens to be in front, and it
// acts under the Agents rules like any task: anything they don't allow waits on its approval card.
async function runRoutine(r, why) {
  markRoutine(r.id, { lastRun: new Date().toISOString() }); // first, so a slow start can't run it twice
  const result = await tasks.create({ title: r.name, prompt: r.prompt, target: null, tucked: true });
  routineStatus.set(r.id, result.error ? `Couldn't start: ${result.error}` : why === "now" ? "Started just now" : "Started on schedule");
  trace({ kind: "routine", id: r.id, why, error: result.error });
  return result;
}

function checkRoutines() {
  const now = new Date();
  for (const r of settings.routines) {
    if (!r.enabled) {
      routineWatched.delete(r.id);
      continue;
    }
    if (!routineWatched.has(r.id)) routineWatched.set(r.id, now);
    const since = r.lastRun ? new Date(r.lastRun) : routineWatched.get(r.id);
    const v = routineVerdict(r, since, now);
    if (v === "run") runRoutine(r, "schedule");
    else if (v === "skip") {
      routineStatus.set(r.id, "Skipped a run missed while Buddy wasn't running");
      markRoutine(r.id, { lastRun: now.toISOString() });
    }
  }
}

// ---------- Request a feature: a pre-filled GitHub issue, opened in the browser for the user to edit and send ----------

const ISSUES = "https://github.com/donlapidos/agent-desktop/issues/new";
function requestFeature() {
  const body = [
    "**What would you like Buddy to do?**",
    "",
    "",
    "**How would it help you?**",
    "",
    "",
    "---",
    `Desktop Buddy ${app.getVersion()} · Windows ${os.release()}`,
  ].join("\n");
  shell.openExternal(`${ISSUES}?${new URLSearchParams({ title: "Feature request: ", body, labels: "buddy" })}`);
}

const settingsWindow = createSettingsWindow({
  here,
  icon: ICON,
  state: settingsState,
  change: changeSettings,
  capture: suspendHotkeys,
  preview: (sid, speed) => voice?.say(PREVIEW_LINE, { sid: Math.min(VOICES - 1, Math.max(0, Math.trunc(sid) || 0)), speed: Math.min(SPEED.max, Math.max(SPEED.min, speed || 1)) }),
  setKey: (key) => {
    const k = key.trim();
    if (!ANTHROPIC_KEY.test(k)) return "That doesn't look like an Anthropic API key. They start with sk-ant-.";
    saveApiKey(k);
    startBrain();
    return null;
  },
  removeKey: () => {
    fs.rmSync(keyFile(), { force: true });
    if (!process.env.ANTHROPIC_API_KEY) brain = null;
  },
  setStartup: (on) => process.platform === "win32" && setStartsWithWindows(on),
  clear: (what) => {
    if (what === "log") return fs.rmSync(timingLog(), { force: true });
    for (const f of fs.readdirSync(explainersDir()).filter((x) => x.endsWith(".html"))) fs.rmSync(path.join(explainersDir(), f), { force: true });
  },
  openData: () => shell.openPath(app.getPath("userData")),
  runRoutine: (id) => {
    const r = settings.routines.find((x) => x.id === id);
    return r ? runRoutine(r, "now").then((res) => res.error ?? null) : Promise.resolve("That routine no longer exists.");
  },
  // Apps with a window open now, as suggestions for the Agents lists.
  apps: async () => [...new Set((await listWindows()).map((w) => w.app_name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  requestFeature,
});
ipcMain.on("open-settings", () => settingsWindow.open());

app.whenReady().then(() => {
  const loaded = loadSettings(settingsFile());
  settings = loaded.settings;
  if (loaded.recovered) trace({ kind: "settings-recovered", note: "settings.json couldn't be read; kept as settings.json.bad" });
  applyAppearance();
  setBrainDefaults(settings);
  setAgentPolicy(settings);
  app.setAppUserModelId(APP_ID);
  const devRun = process.env.BUDDY_POINT_TEST || process.env.BUDDY_EXPLAINER_TEST || process.env.BUDDY_MARK_TEST || process.env.BUDDY_TASK_TEST || process.env.BUDDY_VOICE_TEST || process.env.BUDDY_SETTINGS_TEST || process.env.BUDDY_APPROVAL_TEST || process.env.BUDDY_THEME;
  if (!devRun) firstRunSetup();
  lockExplainerSession();
  clearOldSessions();
  startBrain();
  createOverlays();
  createIsland();
  createBubble();
  createTray();
  startTasks();
  startVoice();
  setTimeout(checkRoutines, 10_000);
  setInterval(checkRoutines, ROUTINE_CHECK_MS);
  trackCursor();
  setInterval(keepIsland, 1500);
  const displaysChanged = () => {
    createOverlays();
    keepIsland();
  };
  screen.on("display-added", displaysChanged);
  screen.on("display-removed", displaysChanged);
  screen.on("display-metrics-changed", displaysChanged);
  registerHotkeys();
  if (process.env.BUDDY_POINT_TEST) {
    // Dev check for coordinate mapping: BUDDY_POINT_TEST='{"x":..,"y":..,"width":..,"height":..}' (physical px)
    setTimeout(() => point(JSON.parse(process.env.BUDDY_POINT_TEST), "Is this the right spot?"), 2500);
  } else if (process.env.BUDDY_MARK_TEST) {
    // Dev check for the marker without a mouse: BUDDY_MARK_TEST='[[{"x":..,"y":..},...],...]' (screen DIP strokes).
    // BUDDY_MARK_TEST_OUT=path saves the image the model would receive.
    setTimeout(async () => {
      await startMarking();
      const strokes = JSON.parse(process.env.BUDDY_MARK_TEST).map((s) =>
        s.map((p) => ({ x: p.x - markDisplay.bounds.x, y: p.y - markDisplay.bounds.y })),
      );
      const ready = setInterval(() => {
        if (!markWin?.isVisible()) return;
        clearInterval(ready);
        markWin.webContents.send("mark-inject", strokes);
      }, 100);
      const done = setInterval(() => {
        if (!pendingMarks) return;
        clearInterval(done);
        if (!process.env.BUDDY_MARK_TEST_OUT) return;
        fs.writeFileSync(process.env.BUDDY_MARK_TEST_OUT, Buffer.from(pendingMarks.image, "base64"));
        console.log("MARKS", JSON.stringify(pendingMarks.marks.map((x) => ({ n: x.n, elements: x.elements.map((e) => e.path) }))));
        setTimeout(async () => {
          const img = await bubble.webContents.capturePage();
          fs.writeFileSync(process.env.BUDDY_MARK_TEST_OUT.replace(/.png$/, "-bubble.png"), img.toPNG());
          console.log("BUBBLE_SHOT", JSON.stringify(bubble.getBounds()), JSON.stringify(island.getBounds()));
        }, 600);
      }, 100);
    }, 2500);
  } else if (process.env.BUDDY_TASK_TEST) {
    // Dev check for task windows without the model: two scripted agents, one of which asks for approval.
    // BUDDY_TASK_TEST=<dir> saves each task window and the island there.
    const out = process.env.BUDDY_TASK_TEST;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const scripted = (steps, reply, approval) => ({
      ui: {},
      log: [],
      transcript() {
        return this.log.slice();
      },
      cancel() {},
      async ask(text) {
        this.log.push({ role: "user", text });
        for (const s of steps) {
          await wait(700);
          this.ui.status(s);
        }
        if (approval) this.ui.status((await this.ui.confirm(approval)) === "deny" ? "Skipped that." : approval);
        await wait(600);
        this.log.push({ role: "buddy", text: reply });
        return reply;
      },
    });
    setTimeout(async () => {
      await tasks.create({ brain: scripted(["Looking…", "Reading the page…", "Comparing the three plans"], "The Pro plan is the only one with SSO. It costs $24 a seat, and the annual price saves 20%.") });
      await tasks.create({ brain: scripted(["Looking…"], "Saved the file as report-final.xlsx.", "Click Save") });
      const taskWins = () => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith("task.html"));
      for (let i = 0; i < 50 && taskWins().length < 2; i++) await wait(100);
      const wins = taskWins().sort((a, b) => a.id - b.id);
      const asks = ["Compare the pricing plans on this page", "Save this workbook"];
      await wait(800);
      wins.forEach((w, i) => w.webContents.executeJavaScript(`document.getElementById("input").value = ${JSON.stringify(asks[i])}; document.getElementById("form").requestSubmit();`));
      await wait(1800);
      wins[0].hide(); // tuck task 1 into the island while it works
      await wait(2600);
      const shot = async (name, win) => {
        win.webContents.invalidate(); // a transparent window can hand back its last frame otherwise
        await wait(150);
        fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
      };
      await shot("task-2-confirm.png", wins[1]);
      await shot("island.png", island);
      console.log("TASKS", JSON.stringify(tasks.list()));
      // Preview the tucked-away task from the island, then approve task 2 from its preview.
      await island.webContents.executeJavaScript(`showPeek("t1")`);
      await wait(1500);
      await shot("island-peek-hidden.png", island);
      await island.webContents.executeJavaScript(`showPeek("t2")`);
      await wait(1500);
      {
        // What's actually on screen, cropped to the island (a page capture of this transparent window can be stale).
        const d = screen.getPrimaryDisplay();
        const sf = d.scaleFactor;
        const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
        const b = island.getBounds();
        fs.writeFileSync(path.join(out, "island-peek-confirm.png"), src.thumbnail.crop({ x: Math.round(b.x * sf), y: Math.round(b.y * sf), width: Math.round(b.width * sf), height: Math.round(b.height * sf) }).toPNG());
      }
      await island.webContents.executeJavaScript(`document.getElementById("peek-allow").click(); showPeek(null);`);
      await wait(2500);
      wins[0].show();
      await wait(400);
      await shot("task-1-done.png", wins[0]);
      await shot("task-2-done.png", wins[1]);
      console.log("TASKS", JSON.stringify(tasks.list()));
      console.log("TASK_TEST_DONE");
    }, 2500);
  } else if (process.env.BUDDY_VOICE_TEST) {
    // Dev check for the speech engine, muted: the voice says a line, the recognizer hears it back, then a two-sentence reply
    // plays through the voice page. BUDDY_VOICE_TEST_MIC=1 also opens the microphone once.
    setTimeout(async () => {
      voice.mute();
      await voice.warm();
      const line = process.env.BUDDY_VOICE_TEST;
      let t0 = Date.now();
      const clip = await voice.synthesize(line);
      console.log("VOICE_SYNTH", Date.now() - t0, "ms", (clip.audio.length / clip.rate).toFixed(2), "s");
      const ratio = clip.rate / 16000;
      const pcm = Float32Array.from({ length: Math.floor(clip.audio.length / ratio) }, (_, i) => clip.audio[Math.floor(i * ratio)]);
      t0 = Date.now();
      const { text } = await voice.transcribe(pcm);
      console.log("VOICE_HEARD", Date.now() - t0, "ms", JSON.stringify(text));
      t0 = Date.now();
      await voice.say(`**${line}** It's under the *Formulas* tab → Insert Function.`);
      console.log("VOICE_SAID", Date.now() - t0, "ms");
      if (process.env.BUDDY_VOICE_TEST_MIC) console.log("VOICE_MIC", JSON.stringify(await voice.listen()));
      console.log("VOICE_TEST_DONE");
    }, 1500);
  } else if (process.env.BUDDY_APPROVAL_TEST) {
    // Dev check, with a REAL mouse click (the pointer moves; keep hands off the mouse): an approval card must take a
    // click, and the keyboard must go back to the user's app afterwards. Cases:
    //   plain    the card in a bubble opened once
    //   guide    the bubble folds away while Buddy points at a step, then the card comes
    //   cycle    the bubble is closed and opened again before asking (this left cards deaf to clicks)
    //   twoasks  one answer guides, the bubble is opened again, and the next answer needs approval
    // Run: BUDDY_APPROVAL_TEST=cycle npm start (it needs ANTHROPIC_API_KEY set to anything; Claude isn't called).
    const kind = process.env.BUDDY_APPROVAL_TEST;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = asPhysicalRect({ x: 200, y: 300, width: 120, height: 40 });
    setTimeout(async () => {
      await summon();
      await wait(800);
      let answered = null;
      const approve = async () => {
        if (kind === "guide") {
          await guidePoint(step, "Click here");
          await wait(1500);
        }
        answered = await confirm('Create "Report" in Documents\\Buddy and open it in Word', null);
        return "Done.";
      };
      brain = { reset() {}, cancel() {}, marks: new Map(), transcript: () => [], ask: approve };
      if (kind === "cycle") {
        toggle();
        await wait(800);
        toggle();
        await wait(1200);
      }
      if (kind === "twoasks") {
        brain.ask = async () => {
          await guidePoint(step, "Click here");
          await wait(1500);
          brain.ask = approve;
          return "Done guiding.";
        };
        await bubble.webContents.executeJavaScript(`window.buddy.ask("show me how", {})`);
        await wait(7500);
        toggle();
        await wait(1200);
      }
      bubble.webContents.executeJavaScript(`window.buddy.ask("make a report", {})`);
      await wait(4000);
      const box = await bubble.webContents.executeJavaScript(`(() => { const r = document.querySelector('#confirm [data-d="allow"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const b = bubble.getContentBounds();
      const at = screen.dipToScreenPoint({ x: Math.round(b.x + box.x), y: Math.round(b.y + box.y) });
      const { execFileSync } = await import("node:child_process");
      execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "../scripts/real-click.ps1"), String(at.x), String(at.y)]);
      await wait(1500);
      const front = (await listWindows()).find((w) => w.is_focused);
      console.log("APPROVAL_TEST", JSON.stringify({ kind, answered, keyboardBackInApp: !!front && !ownPids().includes(front.pid) }));
      app.quit();
    }, 2500);
  } else if (process.env.BUDDY_SETTINGS_TEST) {
    // Dev check for Settings: BUDDY_SETTINGS_TEST=<dir> captures each section of the window there, then checks that
    // changes reach the rest of Buddy (the island's colour, the registered shortcuts, the file) and that a clash is
    // refused.
    const out = process.env.BUDDY_SETTINGS_TEST;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    setTimeout(async () => {
      settingsWindow.open();
      await wait(1500);
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("settings.html"));
      const shoot = async (page, name) => {
        await win.webContents.executeJavaScript(`show(${JSON.stringify(page)})`);
        await wait(400);
        fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      };
      for (const page of ["voice", "look", "keys", "claude"]) await shoot(page, `settings-${page}`);
      await win.webContents.executeJavaScript(`document.querySelector("main").scrollTop = 9999`);
      await wait(300);
      fs.writeFileSync(path.join(out, "settings-claude-bottom.png"), (await win.webContents.capturePage()).toPNG());
      const problems = changeSettings({ accent: "coral", voice: 3, speed: 1.15, hotkeys: { ask: "Control+Alt+K" } });
      await wait(800);
      const accentOf = (wc) => wc.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue("--buddy").trim()`);
      console.log("SETTINGS_APPLIED", JSON.stringify({
        problems,
        island: await accentOf(island.webContents),
        bubble: await accentOf(bubble.webContents),
        settingsPage: await accentOf(win.webContents),
        newAskHeld: globalShortcut.isRegistered("Control+Alt+K"),
        oldAskReleased: !globalShortcut.isRegistered("Control+Alt+B"),
        file: JSON.parse(fs.readFileSync(settingsFile(), "utf8")),
      }));
      console.log("SETTINGS_CLASH", JSON.stringify(changeSettings({ hotkeys: { talk: "Control+Alt+K" } })));
      // Agents: the policy reaches every Brain.
      changeSettings({ rope: "trusted", trustedApps: ["Notepad"] });
      const { decide } = await import("./policy.js");
      console.log("SETTINGS_POLICY", JSON.stringify({
        notepadType: decide(settings, { kind: "type", app: "notepad.exe" }),
        wordType: decide(settings, { kind: "type", app: "WINWORD.EXE" }),
        keepass: decide(settings, { kind: "scroll_to", app: "KeePass.exe" }),
      }));
      // Routines: one saved, shown with its next run, and run now (no API key here, so it must say so, not call Claude).
      changeSettings({ routines: [{ id: "rtest1", name: "Inbox check", prompt: "Summarise my unread email.", schedule: { every: "weekday", time: "09:00", days: [], hours: 4 } }] });
      const started = await runRoutine(settings.routines[0], "now");
      console.log("SETTINGS_ROUTINE", JSON.stringify({ info: settingsState().routineInfo.rtest1, started }));
      // Dictation types through the clipboard into the focused app, then puts the clipboard back. The target is a window
      // of Buddy's own, and the paste is skipped unless it really has the keyboard, so nothing lands in another app.
      const pad = new BrowserWindow({ width: 420, height: 160, show: false, title: "Buddy dictation check", webPreferences: { sandbox: true } });
      await pad.loadURL("data:text/html,<title>Buddy dictation check</title><textarea id=t autofocus style='width:100%;height:120px'></textarea>");
      pad.show();
      pad.focus();
      await pad.webContents.executeJavaScript("document.getElementById('t').focus()");
      await wait(500);
      await clipboard.writeText("what the user had copied");
      // Electron's isFocused() can say yes while Windows gives the keyboard to another app (a background app may not
      // take focus), so ask Windows which window really has it, through agent-desktop.
      const front = (await listWindows()).find((w) => w.is_focused);
      if (front && ownPids().includes(front.pid) && front.title === "Buddy dictation check") {
        await typeText("Hello from dictation.");
        await wait(400);
        console.log("SETTINGS_DICTATION", JSON.stringify({
          typed: await pad.webContents.executeJavaScript("document.getElementById('t').value"),
          clipboardRestored: (await clipboard.readText()) === "what the user had copied",
        }));
      } else console.log("SETTINGS_DICTATION", JSON.stringify({ skipped: "the test window didn't get the keyboard" }));
      pad.destroy();
      // Language: Spanish spoken by the voice, heard through Buddy's own speech process with detection on.
      changeSettings({ language: "auto" });
      voice.mute();
      const clip = await voice.synthesize("Haz clic en la pestaña Fórmulas y luego elige Insertar función.", { lang: "es" });
      const ratio = clip.rate / 16000;
      const pcm = Float32Array.from({ length: Math.floor(clip.audio.length / ratio) }, (_, i) => clip.audio[Math.floor(i * ratio)]);
      const t0 = Date.now();
      console.log("SETTINGS_LANGUAGE", JSON.stringify({ ...(await voice.transcribe(pcm)), ms: Date.now() - t0 }));
      for (const page of ["dictation", "agents", "routines"]) await shoot(page, `settings-${page}`);
      await win.webContents.executeJavaScript(`render(${JSON.stringify(settingsState())})`);
      await shoot("look", "settings-look-coral");
      await shoot("keys", "settings-keys-changed");
      console.log("SETTINGS_TEST_DONE");
    }, 2500);
  } else if (process.env.BUDDY_EXPLAINER_TEST) {
    // Dev check for the explainer renderer: BUDDY_EXPLAINER_TEST=path/to/explainer.json (show_explainer input)
    openExplainer(JSON.parse(fs.readFileSync(process.env.BUDDY_EXPLAINER_TEST, "utf8")));
  } else if (!brain) summon();
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("will-quit", () => globalShortcut.unregisterAll());
