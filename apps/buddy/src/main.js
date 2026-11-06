// Desktop Buddy: tray app, island, global hotkeys, pointer overlay, speech bubble and explainers around the Brain.
import {
  app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, screen,
  session, shell, systemPreferences, Tray,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Brain } from "./brain.js";
import { elementAt, elementsAt, foregroundWindow, resolveBinary, windowAt, windowsAt } from "./desktop.js";
import { renderExplainer } from "./explainer.js";
import { createTasks } from "./tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Not Ctrl+Alt+Space: the Claude desktop app's Quick Entry already owns it.
const HOTKEY = process.env.BUDDY_HOTKEY ?? "Control+Alt+B";
const EXPLAIN_HOTKEY = process.env.BUDDY_EXPLAIN_HOTKEY ?? "Control+Alt+E";
const MARK_HOTKEY = process.env.BUDDY_MARK_HOTKEY ?? "Control+Alt+M";
const IDLE_RESET_MS = 15 * 60_000;
// The window starts at the top of the island so the card can slide out from under the pill; the card itself
// sits 46px down (see bubble.html).
const BUBBLE = { width: 400, height: 306 };
const BUBBLE_FOLD_MS = 300; // matches the close transition in bubble.html
const ISLAND = { width: 460, height: 48 };
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

let tray, bubble, island, brain, tasks;
const overlays = new Map();
let pendingConfirm = null;
let busy = false;
let marking = false;
let marks = []; // { n, displayId, points (screen DIP), bbox (DIP) }
let pendingMarks = null; // what the user highlighted, waiting for their question
let markWin = null; // the freeze-frame of the screen the user draws on
let markDisplay = null;
let bubbleHideTimer = null;
let lastAskAt = 0;
let target = null;
let focusPoint = null; // DIP point the current task is about; explainers open beside it
let explainerShown = false;

const ownPids = () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)];
const toPhysical = (p) => (process.platform === "win32" ? screen.dipToScreenPoint(p) : p);

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

function overlayFor(point) {
  const display = screen.getDisplayNearestPoint(point);
  return { win: overlays.get(display.id), origin: display.bounds };
}

function broadcast(channel, payload) {
  for (const win of overlays.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function trackCursor() {
  let last = "";
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const key = `${p.x},${p.y}`;
    if (key === last) return;
    last = key;
    for (const [id, win] of overlays) {
      const d = screen.getAllDisplays().find((x) => x.id === id);
      if (!d || win.isDestroyed()) continue;
      const inside = p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height;
      win.webContents.send("cursor", inside ? { x: p.x - d.bounds.x, y: p.y - d.bounds.y } : null);
    }
  }, 16);
}

function toLocalRect(physical) {
  const dip = process.platform === "win32" ? screen.screenToDipRect(null, physical) : physical;
  const center = { x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 };
  const { win, origin } = overlayFor(center);
  return { win, rect: { x: dip.x - origin.x, y: dip.y - origin.y, width: dip.width, height: dip.height } };
}

function point(bounds, caption) {
  const { win, rect } = toLocalRect(bounds);
  for (const other of overlays.values()) if (other !== win) other.webContents.send("release");
  win?.webContents.send("point", { rect, caption });
  return new Promise((r) => setTimeout(r, 900));
}

const releasePointer = () => broadcast("release");

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
    if (takenKeys.length) setIsland("done", `${takenKeys.map(keyLabel).join(", ")} is used by another app`);
    else setIsland("idle");
    if (tasks) island.webContents.send("tasks", tasks.list());
  });
  island.webContents.on("render-process-gone", () => {
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
  island.setAlwaysOnTop(true, "screen-saver");
  island.moveTop();
}

const keyLabel = (accel) => accel.replace("Control", "Ctrl").replace("CommandOrControl", "Ctrl");

function setIsland(state, text) {
  if (island && !island.isDestroyed()) island.webContents.send("island", { state, text, hotkey: keyLabel(HOTKEY) });
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
    if (!busy && !pendingConfirm) hideBubble();
  });
  // Closing the bubble ends the conversation about what was marked.
  bubble.on("hide", () => {
    if (!marking && !busy) clearMarks();
    if (!marking && !busy && !pendingConfirm) setIsland("idle");
  });
  bubble.on("show", () => {
    if (!busy && !pendingConfirm && !marking) setIsland("active", "Listening");
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
    bubble.setFocusable(true);
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
  if (bubble.isVisible() && !busy && !pendingConfirm && !marking) return hideBubble();
  summon();
}

// Hand focus back to the user's app while we work, so keyboard actions land there.
function releaseFocus() {
  bubble.setFocusable(false);
  bubble.blur();
}

async function summon() {
  if (busy) return showBubble({ focus: false });
  if (Date.now() - lastAskAt > IDLE_RESET_MS) brain?.reset();
  target = await foregroundWindow(ownPids());
  focusPoint = screen.getCursorScreenPoint();
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

async function explainAt(dipPoint, question) {
  if (busy) return;
  if (!brain) return summon();
  busy = true;
  lastAskAt = Date.now();
  focusPoint = dipPoint;
  explainerShown = false;
  setIsland("busy", "Looking at that…");
  try {
    const physical = toPhysical(dipPoint);
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
    busy = false;
  }
}

// ---------- Marker: highlight things on screen with a pen, then ask about them ----------

function bboxOf(points, pad = 10) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

// Marking draws on a still of the screen in an opaque window (like the Snipping Tool). Drawing straight on the
// transparent overlay meant Windows repainted the whole screen for every stroke segment, which lagged.
async function startMarking() {
  if (busy || marking) return;
  if (!brain) return summon();
  clearMarks();
  marking = true;
  hideBubble({ now: true });
  setIsland("picking", "Getting the screen ready…");
  markDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  try {
    const shot = await grabDisplay(markDisplay);
    if (!marking) return;
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
      if (marking) cancelMarking();
    });
    win.webContents.once("did-finish-load", () => win.webContents.send("mark-start", { png: shot.toPNG() }));
    win.loadFile(path.join(here, "ui/marker.html"));
  } catch (err) {
    stopMarkMode();
    setIsland("done", `Couldn't start marking: ${err.message}`);
  }
}

// `delay` keeps the still up a moment so the overlay can paint the finished marks underneath first.
function stopMarkMode(delay = 0) {
  marking = false;
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
  stopMarkMode();
  clearMarks();
  setIsland("idle");
}

const dedupe = (els) => [...new Map(els.map((e) => [e.path, e])).values()];
const markLabel = (m) => {
  const e = m.elements.find((x) => x.name) ?? m.elements[0];
  const text = String(e?.name || e?.value || e?.role || "an area");
  return text.length > 28 ? text.slice(0, 26) + "…" : text;
};

async function finishMarking({ image, strokes } = {}) {
  if (!marking || !markDisplay) return;
  const display = markDisplay;
  const valid = (Array.isArray(strokes) ? strokes : []).filter((s) => Array.isArray(s?.points) && s.points.length).slice(0, 50);
  if (!valid.length || typeof image !== "string") return cancelMarking();

  // Hand the marks to the overlay so they stay on screen, then let the still go.
  const overlay = overlays.get(display.id);
  marks = valid.map((s, i) => {
    const local = s.points.slice(0, 4000).map((p) => ({ x: Number(p.x), y: Number(p.y) }));
    overlay?.webContents.send("mark-drawn", { points: local, n: i + 1 });
    const points = local.map((p) => ({ x: display.bounds.x + p.x, y: display.bounds.y + p.y }));
    return { n: i + 1, displayId: display.id, points, bbox: bboxOf(points) };
  });
  stopMarkMode(90);
  setIsland("busy", "Reading what you marked…");
  try {
    // Sample each stroke at its start, middle and end, and read the elements under those points.
    const samples = marks
      .flatMap((m) => [m.points[0], m.points[Math.floor(m.points.length / 2)], m.points.at(-1)])
      .map(toPhysical);
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

    const toPhysRect = (r) => (process.platform === "win32" ? screen.dipToScreenRect(null, r) : r);
    pendingMarks = {
      image,
      target: wins.find(Boolean) ?? null,
      marks: marks.map((m, i) => ({
        n: m.n,
        bounds: toPhysRect(m.bbox),
        elements: dedupe(found.slice(i * 3, i * 3 + 3).filter(Boolean)),
      })),
    };
    target = pendingMarks.target;
    const last = marks.at(-1).bbox;
    focusPoint = { x: last.x + last.width, y: last.y + last.height };
    bubble.webContents.send("summon", { target: target ? target.app_name + " — " + target.title : null, needsKey: !brain });
    bubble.webContents.send("marks", pendingMarks.marks.map((m) => ({ n: m.n, label: markLabel(m) })));
    setIsland("idle");
    showBubble();
  } catch (err) {
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
  const dip = { x: markDisplay.bounds.x + Number(local.x), y: markDisplay.bounds.y + Number(local.y) };
  stopMarkMode();
  setIsland("busy", "Looking at that…");
  // Let the still close before the screen is captured for the explainer.
  setTimeout(() => explainAt(dip), 120);
});

// Model-written plates run with JavaScript off, a strict CSP, and a session that refuses every network request.
const EXPLAINER_PARTITION = "explainer";

function lockExplainerSession() {
  session.fromPartition(EXPLAINER_PARTITION).webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !/^(file|data):/.test(details.url) });
  });
}

const appLabel = (win) => win?.app_name?.replace(/\.exe$/i, "") || null;

function openExplainer(explainer) {
  explainerShown = true;
  const dir = path.join(app.getPath("userData"), "explainers");
  fs.mkdirSync(dir, { recursive: true });
  const plateNo = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length + 1;
  const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const reducedMotion = process.platform === "win32" && systemPreferences.getAnimationSettings().prefersReducedMotion;
  const page = renderExplainer(explainer, { plateNo, observedIn: appLabel(target), date, reducedMotion });
  const file = path.join(dir, `${Date.now()}.html`);
  fs.writeFileSync(file, page);
  const title = explainer.common_name ?? "Explainer";

  const anchor = focusPoint ?? screen.getCursorScreenPoint();
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

ipcMain.handle("ask", async (_e, text) => {
  if (!brain) return { reply: "Add your Anthropic API key first." };
  busy = true;
  lastAskAt = Date.now();
  explainerShown = false;
  releaseFocus();
  setIsland("busy", "Thinking…");
  try {
    const withMarks = pendingMarks;
    pendingMarks = null;
    const reply = withMarks ? await brain.askWithMarks(text, withMarks) : await brain.ask(text, target);
    setIsland("done", oneLine(reply));
    return { reply };
  } catch (err) {
    setIsland("done", "Something broke");
    return { reply: `Something broke: ${err.message}` };
  } finally {
    busy = false;
    bubble.setFocusable(true);
    setTimeout(releasePointer, 6000);
  }
});

ipcMain.handle("set-key", (_e, key) => {
  saveApiKey(key.trim());
  startBrain();
  return { ok: !!brain };
});

ipcMain.on("cancel", () => {
  brain?.cancel();
  pendingConfirm?.("deny");
});
ipcMain.on("reset", () => {
  brain?.reset();
  clearMarks();
});
ipcMain.on("hide", () => hideBubble());
ipcMain.on("confirm-reply", (_e, decision) => {
  trace({ kind: "confirm-reply", decision, waiting: !!pendingConfirm });
  pendingConfirm?.(decision);
  pendingConfirm = null;
  setIsland("busy", "Working…");
});
ipcMain.on("island-hover", (_e, inside) => island.setIgnoreMouseEvents(!inside, { forward: true }));
ipcMain.on("island-action", (_e, action) => {
  if (action === "ask") summon();
  else if (action === "mark") startMarking();
  else if (action === "show") showBubble({ focus: false });
  else if (action === "settle" && !busy) setIsland("idle");
  else if (action === "task") newTask();
  else if (action.startsWith("task:")) tasks.toggle(action.slice(5));
});

function confirm(summary, bounds) {
  trace({ kind: "confirm-shown", bubbleVisible: bubble.isVisible(), focusable: bubble.isFocusable(), bounds: bubble.getBounds() });
  if (bounds) point(bounds, summary);
  showBubble({ focus: false });
  bubble.webContents.send("confirm", { summary });
  setIsland("confirm", `Waiting for your OK: ${summary}`);
  return new Promise((resolve) => {
    pendingConfirm = resolve;
  });
}

// When the bubble's own conversation starts guiding, the bubble folds back into the island: the pointer and its
// caption carry the step, and the bubble would otherwise sit over the ribbon or dialog they need to click.
function guidePoint(bounds, caption) {
  if (busy && bubble.isVisible() && !pendingConfirm) hideBubble();
  return point(bounds, caption);
}

// Timing log (userData/timing.log, JSON lines): how long each model call and tool took, to find slow steps.
function trace(entry) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "timing.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// Where create_document saves, and how it opens the result (Word, or whatever opens .docx here).
const documentsDir = () => path.join(app.getPath("documents"), "Buddy");
const openFile = (file) => shell.openPath(file);

function startBrain() {
  const apiKey = loadApiKey();
  brain = apiKey
    ? new Brain({ apiKey, point: guidePoint, confirm, status, explain: openExplainer, trace, documentsDir: documentsDir(), openFile })
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
    explain: openExplainer,
    onChange: (list) => {
      if (island && !island.isDestroyed()) island.webContents.send("tasks", list);
    },
  });
}

// A fresh task, or (from the bubble) the current conversation moved into its own window so it can keep going
// while the bubble is free for something else.
async function newTask({ fromBubble = false } = {}) {
  if (!brain) return summon();
  if (fromBubble && busy) return setIsland("done", "Let Buddy finish this answer, then make it a task");
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
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const readSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
};
const writeSettings = (patch) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));

const startsWithWindows = () => app.getLoginItemSettings(LAUNCH).openAtLogin;
const setStartsWithWindows = (on) => app.setLoginItemSettings({ openAtLogin: on, ...LAUNCH });

function writeShortcuts() {
  const link = {
    target: LAUNCH.path,
    args: `"${LAUNCH.args[0]}"`,
    icon: ICON,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: `Desktop Buddy: ask about anything on your screen (${keyLabel(HOTKEY)})`,
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

// Once per install: put Buddy in Start and on the desktop, and start it at sign-in. Later the tray owns both.
function firstRunSetup() {
  if (process.platform !== "win32" || readSettings().launchSetupDone) return;
  writeShortcuts();
  setStartsWithWindows(true);
  writeSettings({ launchSetupDone: true });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(`Desktop Buddy — ask: ${pretty(HOTKEY)} · mark or explain: ${pretty(MARK_HOTKEY)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Ask Buddy  (${HOTKEY})`, click: () => summon() },
      { label: `Mark or explain something  (${MARK_HOTKEY})`, click: startMarking },
      { label: "New conversation", click: () => brain?.reset() },
      { label: "New task window", click: () => newTask() },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: process.platform === "win32" && startsWithWindows(),
        visible: process.platform === "win32",
        click: (item) => setStartsWithWindows(item.checked),
      },
      { label: "Recreate shortcuts", visible: process.platform === "win32", click: writeShortcuts },
      {
        label: "Change API key…",
        click: () => {
          brain = null;
          summon();
        },
      },
      { type: "separator" },
      { label: `agent-desktop: ${path.basename(resolveBinary())}`, enabled: false },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => summon());
}

// Another app may already own a shortcut; Windows gives it to whoever registered first. Say so on the island.
const takenKeys = [];
function registerKey(accel, fn) {
  if (globalShortcut.register(accel, fn)) return;
  console.error(`Could not register ${accel}`);
  takenKeys.push(accel);
}

app.whenReady().then(() => {
  if (process.env.BUDDY_THEME) nativeTheme.themeSource = process.env.BUDDY_THEME;
  app.setAppUserModelId(APP_ID);
  const devRun = process.env.BUDDY_POINT_TEST || process.env.BUDDY_EXPLAINER_TEST || process.env.BUDDY_MARK_TEST || process.env.BUDDY_TASK_TEST || process.env.BUDDY_THEME;
  if (!devRun) firstRunSetup();
  lockExplainerSession();
  startBrain();
  createOverlays();
  createIsland();
  createBubble();
  createTray();
  startTasks();
  trackCursor();
  setInterval(keepIsland, 1500);
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(event, () => {
      createOverlays();
      keepIsland();
    });
  }
  registerKey(HOTKEY, toggle);
  registerKey(MARK_HOTKEY, startMarking);
  registerKey(EXPLAIN_HOTKEY, () => explainAt(screen.getCursorScreenPoint()));
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
      const shot = async (name, win) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
      await shot("task-2-confirm.png", wins[1]);
      await shot("island.png", island);
      console.log("TASKS", JSON.stringify(tasks.list()));
      wins[1].webContents.executeJavaScript(`document.querySelector('#confirm [data-d="allow"]').click();`);
      await wait(2500);
      wins[0].show();
      await wait(400);
      await shot("task-1-done.png", wins[0]);
      await shot("task-2-done.png", wins[1]);
      console.log("TASKS", JSON.stringify(tasks.list()));
      console.log("TASK_TEST_DONE");
    }, 2500);
  } else if (process.env.BUDDY_EXPLAINER_TEST) {
    // Dev check for the explainer renderer: BUDDY_EXPLAINER_TEST=path/to/explainer.json (show_explainer input)
    openExplainer(JSON.parse(fs.readFileSync(process.env.BUDDY_EXPLAINER_TEST, "utf8")));
  } else if (!brain) summon();
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("will-quit", () => globalShortcut.unregisterAll());
