// Desktop Buddy: tray app, island, global hotkeys, pointer overlay, speech bubble and explainers around the Brain.
import {
  app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, screen,
  session, shell, systemPreferences, Tray, webContents,
} from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_TOOLS, startBridge } from "./bridge.js";
import { APPS, APP_IDS, allowRules, appStatus, claudeCodeExe, launchSpec, quickChatArgs, quickChatConfig, setApp, setCodeAllowed, staleApps } from "./ai-apps.js";
import { Brain, SESSION_PREFIX, failureFor, setAgentPolicy, setBrainDefaults, takeTurn } from "./brain.js";
import { PROVIDERS, ProviderError, addressProblem, capsOf, describeModels, keyFits, listModels, noteTested, providerForKey, testedOf, useCapsStore, verdict } from "./providers.js";
import { CASES, runEvals } from "./evals.js";
import { createActivity } from "./activity.js";
import { createApprovalQueue } from "./approval-queue.js";
import { islandView } from "./island-state.js";
import { dictationPaste, returnFocus } from "./approvals.js";
import { elementAt, elementsAt, foregroundWindow, listWindows, perform, resolveBinary, windowAt, windowsAt } from "./desktop.js";
import { renderExplainer } from "./explainer.js";
import { createTasks } from "./tasks.js";
import { asDipPoint, asDipRect, asPhysicalPoint, asPhysicalRect } from "./geometry.js";
import { BUSY, canMove } from "./modes.js";
import {
  ACCENTS, ADDRESS_PROVIDERS, DEFAULTS, EFFORTS, HOTKEY_NAMES, MODELS, SPEED, VOICES, load as loadSettings, normalize as normalizeSettings,
  save as saveSettings, update as updateSettings,
} from "./settings.js";
import { createSettingsWindow } from "./settings-window.js";
import { createUpdates } from "./updates.js";
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

// The installed app's shortcuts carry the installer's app ID (electron-builder's appId), so the taskbar groups Buddy's
// windows with them; a source checkout keeps the ID its own shortcuts were made with.
const APP_ID = app.isPackaged ? "io.github.donlapidos.desktopbuddy" : "Desktop Buddy";

// Settings, the API key and the voice models live in %APPDATA%\desktop-buddy for a source checkout and an installed
// Buddy alike, whatever the installer calls the app, so installing or updating never loses them. An explicit
// --user-data-dir (separate test copies) still wins.
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("appData"), "desktop-buddy"));

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

let tray, bubble, island, brain, tasks, voice, updates;
let spokenTurn = false; // the question being answered was said out loud
let spokenLang = "en"; // the language it was said in (detected when Settings asks for it)
let heardLang = "en"; // the language of the last thing heard, waiting for the bubble to send it
// What the island shows is worked out from what Buddy is doing (island-state.js). These are the facts that aren't
// held anywhere else: the running activity's latest line, an AI app's call, a download, and the last outcome.
const islandFacts = {
  /** @type {string | null} */ progress: null,
  transcribing: false,
  /** @type {string | null} */ appCall: null,
  /** @type {string | null} */ download: null,
  /** @type {string | null} */ notice: null,
};
let islandShown = ""; // what was last sent, so an unchanged island isn't re-sent
let islandState = "idle"; // for the CPU log
/** @type {import("./settings.js").Settings} */
let settings = normalizeSettings({}); // loaded from disk once the app is ready
let saying = "Speaking"; // the island's label while Buddy reads a reply aloud
const overlays = new Map();
// What Buddy is doing (see modes.js). Requests waiting for the user's OK are in `approvals` (approval-queue.js).
/** @typedef {import("./modes.js").Mode} Mode */
/** @type {Mode} */
let mode = "idle";

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
  if (next !== mode) {
    islandFacts.progress = null;
    islandFacts.transcribing = false;
    // A new activity replaces the last outcome; going back to idle leaves the outcome to be shown.
    if (next !== "idle") islandFacts.notice = null;
  }
  mode = next;
  showIsland();
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

// ---------- API keys (encrypted at rest with the OS keychain), one per provider ----------

// Anthropic's key keeps the file name it had before Buddy knew other providers.
const keyFile = (/** @type {ProviderId} */ provider = currentProvider()) => path.join(app.getPath("userData"), provider === "anthropic" ? "api-key.bin" : `api-key-${provider}.bin`);
const currentProvider = () => /** @type {ProviderId} */ (settings?.provider ?? "anthropic");
const envKey = (/** @type {ProviderId} */ provider = currentProvider()) => process.env[PROVIDERS[provider].keyEnv ?? ""] || null;

function loadApiKey(/** @type {ProviderId} */ provider = currentProvider()) {
  if (envKey(provider)) return envKey(provider);
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile(provider)));
  } catch {
    return null;
  }
}

function saveApiKey(/** @type {string} */ key, /** @type {ProviderId} */ provider) {
  fs.mkdirSync(path.dirname(keyFile(provider)), { recursive: true });
  fs.writeFileSync(keyFile(provider), safeStorage.encryptString(key));
}

// The chat models each provider offers for the saved key (providers.js listModels), fetched when a key is saved or
// the provider changes. Anthropic's are the fixed list in settings.js.
/** @type {Map<ProviderId, { models: string[], error: string | null, loading: boolean }>} */
const providerModelLists = new Map();

// What each model of the current provider can do (providers.js verdict), for Settings to show beside it.
function modelListState() {
  const provider = currentProvider();
  const list = providerModelLists.get(provider) ?? { models: [], error: null, loading: false };
  const chosen = settings.providerModels[provider];
  const shown = list.models.length ? list.models : chosen ? [chosen] : [];
  const at = providerURL(provider) ?? undefined;
  return { ...list, verdicts: Object.fromEntries(shown.map((m) => [m, verdict(capsOf(provider, at, m))])), tested: Object.fromEntries(shown.map((m) => [m, testedOf(at, m)])) };
}

// ---------- Activity: what Buddy changed, and undoing it (activity.js), shown in Settings › Activity ----------

/** @type {ReturnType<typeof createActivity> | null} */
let activity = null;
function startActivity() {
  activity = createActivity({
    file: path.join(app.getPath("userData"), "activity.json"),
    undoDir: path.join(app.getPath("userData"), "undo"),
    // End-to-end checks put "trashed" files in a bin of their own, not the user's Recycle Bin.
    trash: process.env.BUDDY_E2E
      ? async (file) => {
          const bin = path.join(app.getPath("userData"), "e2e-bin");
          fs.mkdirSync(bin, { recursive: true });
          fs.renameSync(file, path.join(bin, path.basename(file)));
        }
      : (file) => shell.trashItem(file),
    onChange: () => settingsWindow?.refresh(),
  });
}
// Shows the user what an answer made: one file opens in its usual app, several open their folder with one selected.
async function revealMade(/** @type {string[]} */ files) {
  const there = files.filter((f) => fs.existsSync(f));
  if (!there.length) return;
  // End-to-end checks (BUDDY_E2E) say what would open instead of opening windows over the user's work.
  if (process.env.BUDDY_E2E) return console.log("REVEALED", JSON.stringify(there));
  if (there.length > 1) return shell.showItemInFolder(there.at(-1) ?? there[0]);
  const error = await shell.openPath(there[0]);
  if (error) shell.showItemInFolder(there[0]);
  trace({ kind: "revealed", files: there.length, error: error || null });
}

const recordChange = (/** @type {Omit<import("./activity.js").Change, "id" | "at">} */ change) => {
  activity?.add(change);
  trace({ kind: "activity", what: change.kind });
};

// ---------- Model check (evals.js), run from Settings on the chosen model with the saved key ----------

/** @type {{ provider: ProviderId, model: string, running: boolean, stopped?: boolean, done: number, total: number, passed: number, missed: string[], abort: AbortController } | null} */
let modelCheck = null;
const chosenModel = () => (currentProvider() === "anthropic" ? settings.model : settings.providerModels[currentProvider()]);

/** Starts a check of the chosen model, or stops the one running. Resolves an error message, or null. */
function checkModel() {
  if (modelCheck?.running) {
    modelCheck.abort.abort();
    return null;
  }
  const provider = currentProvider();
  const model = chosenModel();
  if (!providerReady() || !model) return "Choose a provider and a model first.";
  const baseURL = providerURL(provider) ?? undefined;
  const check = { provider, model, running: true, done: 0, total: CASES.length, passed: 0, missed: /** @type {string[]} */ ([]), abort: new AbortController() };
  modelCheck = check;
  runEvals({
    provider,
    apiKey: loadApiKey() ?? "",
    baseURL,
    signal: check.abort.signal,
    onCase: (r) => {
      trace({ kind: "model-check-case", model, id: r.id, passed: r.passed, problem: r.problem, ms: r.ms, turns: r.turns, shown: r.calls.map((c) => `${c.kind}:${c.name}`).slice(0, 12), reply: r.reply.slice(0, 300) });
      check.done++;
      if (r.passed) check.passed++;
      else check.missed.push(r.title);
      settingsWindow?.refresh();
    },
  })
    .then((run) => {
      trace({ kind: "model-check", provider, model, passed: run.passed, total: run.total, avgMs: run.avgMs, stopped: check.abort.signal.aborted });
      if (!check.abort.signal.aborted && run.total === CASES.length) noteTested(baseURL, model, { passed: run.passed, total: run.total, avgMs: run.avgMs, at: new Date().toISOString() });
    })
    .catch((err) => trace({ kind: "model-check", provider, model, error: String(err) }))
    .finally(() => {
      check.running = false;
      check.stopped = check.abort.signal.aborted;
      settingsWindow?.refresh();
    });
  settingsWindow?.refresh();
  return null;
}

// What Buddy has learned about models' abilities, kept between runs.
const capsFile = () => path.join(app.getPath("userData"), "model-caps.json");
function loadModelCaps() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(capsFile(), "utf8"));
  } catch {}
  useCapsStore(saved, (entries) => {
    try {
      fs.writeFileSync(capsFile(), JSON.stringify(entries, null, 1));
    } catch (err) {
      trace({ kind: "model-caps-save-failed", message: String(err) });
    }
    settingsWindow?.refresh();
  });
}

// Where a provider is: its fixed address, or the one the user gave (Ollama and LM Studio default to their usual one).
const providerURL = (/** @type {ProviderId} */ provider = currentProvider()) => settings.providerURLs[provider] ?? PROVIDERS[provider].baseURL ?? null;

// Whether Buddy can think with this provider: it has a key, or needs none and has an address.
function providerReady(/** @type {ProviderId} */ provider = currentProvider()) {
  if (PROVIDERS[provider].key === "required") return !!loadApiKey(provider);
  return !!providerURL(provider);
}

/** Fetches the provider's models; picks the best one if none is chosen yet. Resolves an error message, or null. */
async function refreshModels(/** @type {ProviderId} */ provider = currentProvider(), key = loadApiKey(provider) ?? "") {
  const baseURL = providerURL(provider);
  if (provider === "anthropic" || !baseURL || (PROVIDERS[provider].key === "required" && !key)) return null;
  providerModelLists.set(provider, { models: providerModelLists.get(provider)?.models ?? [], error: null, loading: true });
  settingsWindow?.refresh();
  let error = null;
  let models = [];
  try {
    models = await listModels(provider, key, { baseURL });
    await describeModels(provider, key, models, { baseURL });
    if (!models.length) error = PROVIDERS[provider].local ? `${PROVIDERS[provider].label} has no models yet. Download one in ${PROVIDERS[provider].label}, then come back.` : `${PROVIDERS[provider].label} didn't list any chat models for this key.`;
  } catch (err) {
    error = err instanceof ProviderError ? (failureFor(err.kind, provider) ?? err.message) : `Couldn't reach ${PROVIDERS[provider].label}: ${err?.message ?? err}`;
  }
  providerModelLists.set(provider, { models, error, loading: false });
  const chosen = settings.providerModels[provider];
  // The default is the best-placed model known to work well, else the first that isn't known to lack tools.
  const fit = (want) => models.find((m) => want.includes(verdict(capsOf(provider, baseURL, m))));
  const pick = fit(["good"]) ?? fit(["unknown", "no_images"]) ?? models[0];
  if (models.length && (!chosen || !models.includes(chosen))) changeSettings({ providerModels: { [provider]: pick } });
  else settingsWindow?.refresh();
  return error;
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
    if (taken.length) notice(`${taken.map((n) => keyLabel(hotkey(n))).join(", ")} is used by another app: change it in Settings`);
    showIsland({ force: true });
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

// Redraws the island from the facts. Changes made in the same moment (an answer ending, then its outcome) are drawn
// once, on the next tick, so the island doesn't flicker through the state in between.
let islandPending = false;
function showIsland({ force = false } = {}) {
  if (force) islandShown = "";
  if (islandPending) return;
  islandPending = true;
  setImmediate(() => {
    islandPending = false;
    if (!island || island.isDestroyed()) return;
    const view = islandView({
      mode,
      approval: approvals.current()?.summary ?? null,
      ...islandFacts,
      speaking: !!voice?.speaking,
      saying,
      bubbleOpen: !!bubble && !bubble.isDestroyed() && bubble.isVisible(),
    });
    const message = { ...view, hotkey: keyLabel(hotkey("ask")), talkKey: keyLabel(hotkey("talk")) };
    const key = JSON.stringify(message);
    if (key === islandShown) return;
    islandShown = key;
    islandState = view.state;
    island.webContents.send("island", message);
  });
}

/** The running activity's latest line ("Reading the page…"). */
function progress(/** @type {string} */ text) {
  islandFacts.progress = text;
  showIsland();
}

/** An outcome to show once the activity is over: the answer, an error, "Typed 12 words". The island fades it. */
function notice(/** @type {string} */ text) {
  islandFacts.notice = text;
  showIsland();
}

const status = (text) => {
  bubble.webContents.send("status", text);
  progress(text);
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
    showIsland();
  });
  bubble.on("show", () => {
    if (mode === "idle") showIsland();
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
  brain?.glance(target);
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
  progress("Looking at that…");
  try {
    const physical = toPhysicalPoint(dipPoint);
    const [win, shot] = await Promise.all([windowAt(physical, ownPids()), captureAround(dipPoint)]);
    target = win;
    const element = await elementAt(win, physical);
    const reply = await brain.explain({ ...shot, element, target: win, question });
    if (explainerShown) {
      notice(oneLine(reply));
    } else {
      notice("Answered");
      bubble.webContents.send("status", "");
      bubble.webContents.send("reply", reply);
      showBubble({ focus: false });
    }
  } catch (err) {
    notice(`Couldn't explain that: ${err.message}`);
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
  progress("Getting the screen ready…");
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
    notice(`Couldn't start marking: ${err.message}`);
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
  showIsland();
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
  progress("Reading what you marked…");
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
    showIsland();
  } catch (err) {
    enter("idle");
    clearMarks();
    notice("Couldn't read the marks: " + err.message);
  }
}

const fromMarker = (e) => markWin && e.sender === markWin.webContents;
ipcMain.on("mark-ready", (e) => {
  if (!fromMarker(e)) return;
  markWin.show();
  markWin.setBounds(markDisplay.bounds); // Windows clamps oversized windows to the work area on create
  markWin.focus();
  keepIsland();
  progress("Click to explain · draw to ask");
  // Backups in case Windows refuses the still keyboard focus.
  globalShortcut.register("Return", () => markWin?.webContents.send("mark-command", "done"));
  globalShortcut.register("Escape", cancelMarking);
});
ipcMain.on("mark-count", (e, n) => {
  if (fromMarker(e)) progress(n ? `${n} marked · Enter to ask` : "Click to explain · draw to ask");
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
  progress("Looking at that…");
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
  if (!brain) return { reply: "Choose how I think first, in Settings › AI & privacy: an API key (Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek), or a free model on this PC with Ollama or LM Studio. Or ask me from the AI app you already use (Claude, Codex, Gemini, Copilot): Use with your AI app, in the same place." };
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
  progress("Thinking…");
  let reply;
  try {
    const withMarks = pendingMarks;
    pendingMarks = null;
    const how = { spoken: spokenTurn, lang: spokenLang };
    reply = withMarks ? await brain.askWithMarks(text, withMarks, how) : await brain.ask(text, target, how);
  } catch (err) {
    notice("Something broke");
    return { reply: `Something broke: ${err.message}` };
  } finally {
    enter("idle");
    releaseLater("bubble");
  }
  notice(oneLine(reply));
  // After the mode is back to idle, so the island shows Buddy speaking (and a click stops it).
  if (talksBack(spokenTurn)) speak(reply);
  return { reply };
});

// A key that plainly belongs to another provider (sk-ant-, sk-or-, AIza) is saved for that one, which becomes the
// provider Buddy uses. Other providers' keys are tried on their model list before they're kept. Resolves an error
// message, or null.
async function setApiKey(/** @type {string} */ key) {
  const k = key.trim();
  if (PROVIDERS[currentProvider()].key === "none") return `${PROVIDERS[currentProvider()].label} doesn't use a key.`;
  const provider = providerForKey(k, currentProvider());
  if (!keyFits(provider, k)) return `That doesn't look like a key from ${PROVIDERS[provider].label}. Get one at ${PROVIDERS[provider].keyFrom}.`;
  if (provider !== "anthropic") {
    const error = await refreshModels(provider, k);
    if (error && !providerModelLists.get(provider)?.models.length) return error;
  }
  saveApiKey(k, provider);
  if (provider !== currentProvider()) changeSettings({ provider });
  else startBrain();
  return null;
}

/** Where Ollama, LM Studio or another server is. Models are listed from it right away. Resolves an error, or null. */
async function setAddress(/** @type {string} */ url) {
  const provider = currentProvider();
  if (!ADDRESS_PROVIDERS.includes(provider)) return `${PROVIDERS[provider].label}'s address is fixed.`;
  const address = url.trim().replace(/\/+$/, "");
  const problem = addressProblem(address);
  if (problem) return problem;
  changeSettings({ providerURLs: { [provider]: address } });
  return null;
}

ipcMain.handle("set-key", async (_e, key) => {
  const error = await setApiKey(String(key ?? ""));
  return { ok: !error && !!brain, error };
});

// Stop or Esc in the bubble. While the bubble's own answer runs, that answer stops (and withdraws its request on the
// card); otherwise the card on show is for an AI app using Buddy, and Stop says no to it.
ipcMain.on("cancel", () => {
  voice?.cancelListening();
  voice?.hush();
  if (mode === "working") brain?.cancel();
  else answerApproval("deny");
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
  trace({ kind: "confirm-reply", decision, waiting: approvals.size() });
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
  // The island faded an outcome: it has been seen.
  else if (verb === "settle") {
    islandFacts.notice = null;
    showIsland();
  }
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

// The approval card. Buddy's own chat and the AI apps using Buddy can each be waiting for an OK at once: the card shows
// the oldest; a request whose asker stops (its signal) is withdrawn, and the card moves on or comes down.
/** @type {ReturnType<typeof createApprovalQueue<PhysicalRect>>} */
const approvals = createApprovalQueue({
  show: ({ summary, bounds, note }) => {
    trace({ kind: "confirm-shown", bubbleVisible: bubble.isVisible(), focusable: bubble.isFocusable(), bounds: bubble.getBounds(), waiting: approvals?.size() ?? 1 });
    if (bounds) point(bounds, summary);
    showBubble({ focus: false });
    bubble.webContents.send("confirm", { summary, note });
    showIsland();
  },
  clear: () => {
    bubble.webContents.send("confirm-clear");
    if (mode === "working") islandFacts.progress = "Working…";
    showIsland();
  },
  trace,
});
const waitingForOk = () => approvals.size() > 0;

// `summary` says exactly what will happen; `note` is the model's own description, shown smaller under it. `signal` is
// the asker's: when it stops, its request is withdrawn as "deny".
/** @param {string} summary @param {PhysicalRect | null} bounds @param {string} [note] @param {AbortSignal} [signal] @returns {Promise<string>} */
function confirm(summary, bounds, note, signal) {
  return approvals.ask(summary, bounds, note, signal);
}

// The user answered the card (or pressed Esc on it): settles the request it shows.
function answerApproval(decision) {
  if (!approvals.answer(decision)) return;
  releaseFocus(); // the click on the card activated the bubble; the user's app gets the keyboard back
}

// When the bubble's own conversation starts guiding, the bubble folds back into the island: the pointer and its
// caption carry the step, and the bubble would otherwise sit over the ribbon or dialog they need to click.
/** @param {PhysicalRect} bounds @param {string} caption */
function guidePoint(bounds, caption) {
  if (mode === "working" && bubble.isVisible() && !waitingForOk()) hideBubble();
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
  if (mode !== "idle") return wasSpeaking || progress(BUSY[mode]);
  if (!brain) return summon();
  enter("listening");
  if (bubble.isVisible()) showBubble();
  else await summon();
  bubble.webContents.send("listening", true);
  progress("Listening…");
  const { text, error, lang } = await voice.listen();
  heardLang = lang ?? "en";
  bubble.webContents.send("listening", false);
  // Something else took over meanwhile (they typed the question instead): leave it be.
  if (currentMode() !== "listening") return;
  enter("idle");
  if (text) return bubble.webContents.send("voice-text", text);
  if (error === "cancelled") return showIsland();
  notice(HEARD_ERRORS[error] ?? `Couldn't hear you: ${error}`);
}

// ---------- Dictation: say it, and it's typed where you are ----------

// The dictation key: start; pressed again, stop (and type what's left). It needs no API key: nothing leaves the PC.
async function dictate() {
  if (!voice) return;
  if (mode === "dictating") return voice.finishListening();
  const wasSpeaking = voice.speaking;
  voice.hush();
  if (mode !== "idle") return wasSpeaking || progress(BUSY[mode]);
  enter("dictating");
  const continuous = settings.dictateStop === "press";
  const key = keyLabel(hotkey("dictate"));
  progress(continuous ? `Dictating… ${key} to stop` : "Dictating… pause when you're done");
  let words = 0;
  const result = await voice.dictate({
    continuous,
    onText: async (text) => {
      await typeText(words ? ` ${text}` : text);
      words += text.split(/\s+/).filter(Boolean).length;
      if (continuous && currentMode() === "dictating") progress(`Dictating… ${words} words · ${key} to stop`);
    },
  });
  enter("idle");
  if (result.pieces) notice(`Typed ${words} word${words === 1 ? "" : "s"}`);
  else if (result.error === "cancelled") showIsland();
  else notice(HEARD_ERRORS[result.error] ?? `Couldn't hear you: ${result.error}`);
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
  if (state === "listening" && mode === "listening") progress("Listening… pause when you're done");
  else if (state === "transcribing" && mode === "listening") {
    islandFacts.transcribing = true;
    showIsland();
  } else if (state === "downloading") {
    islandFacts.download = `Getting Buddy's ${info.what === "speaking" ? "voice" : "ears"} ready… ${Math.round((100 * info.loaded) / info.total)}%`;
    showIsland();
    clearTimeout(downloadSettle);
    downloadSettle = setTimeout(() => {
      islandFacts.download = null;
      showIsland();
    }, 4000);
  } else showIsland(); // speaking or quiet: the island reads voice.speaking
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

// Buddy keeps an eye on its own CPU. Normal use measures at 2-3% of one core (an approval waiting, the pointer
// following the mouse, a step being pointed at), yet one stuck session showed its GPU process at 38% and couldn't be
// reproduced. So when a whole minute averages over CPU_HIGH percent, timing.log records which processes used it and
// what Buddy was doing, and the next heavy moment can be found afterwards.
const CPU_WATCH_MS = 60_000;
const CPU_HIGH = Number(process.env.BUDDY_CPU_HIGH ?? 15); // percent of one core, all processes together; env for checks
function watchCpu() {
  app.getAppMetrics(); // starts the first minute's measurement
  setInterval(() => {
    const byType = {};
    for (const m of app.getAppMetrics()) byType[m.type] = +((byType[m.type] ?? 0) + m.cpu.percentCPUUsage).toFixed(1);
    const total = +Object.values(byType).reduce((a, b) => a + b, 0).toFixed(1);
    if (total > CPU_HIGH) trace({ kind: "cpu-high", total, byType, mode, island: islandState, bubbleOpen: bubble.isVisible(), pointing: !!pointer.owner, tasks: tasks?.count() ?? 0 });
  }, CPU_WATCH_MS);
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
// BUDDY_DOCUMENTS_DIR moves it (end-to-end checks keep their files out of the user's Documents).
const documentsDir = () => process.env.BUDDY_DOCUMENTS_DIR ?? path.join(app.getPath("documents"), "Buddy");
// Spike: BUDDY_ENGINE=sdk runs conversations on the Claude Agent SDK (src/agent-brain.js).
/** @typedef {import("./providers.js").ProviderId} ProviderId */
// The Agent SDK engine runs Claude Code, so it only works with an Anthropic key.
// Loaded only when asked for: Buddy's own engine does everything for every provider, so installers leave the Agent SDK
// (and the Claude Code program it runs, 346 MB) out.
const AgentBrain = process.env.BUDDY_ENGINE === "sdk" ? (await import("./agent-brain.js")).AgentBrain : null;
const makeEngine = (ui) => (AgentBrain && currentProvider() === "anthropic" ? new AgentBrain({ ...ui, agentDir: path.join(app.getPath("userData"), "agent") }) : new Brain(ui));
const openFile = (file) => shell.openPath(file);

// The bubble's plates open beside what the user pointed at and say which app it was in.
function bubbleExplain(plate) {
  explainerShown = true;
  openExplainer(plate, { near: focusPoint ?? cursor(), observed: target });
}

// What every Brain is made with for the current provider: its key (empty if it needs none) and where it is.
const providerUI = () => ({ apiKey: loadApiKey() ?? "", provider: currentProvider(), baseURL: providerURL() ?? undefined });

function startBrain() {
  brain = providerReady()
    ? makeEngine({ ...providerUI(), point: guidePoint, confirm, status, explain: bubbleExplain, trace, documentsDir: documentsDir(), dataDir: app.getPath("userData"), record: recordChange, reveal: revealMade, openFile })
    : null;
}

// ---------- Use with your AI app: Buddy's tools for the apps people chat in (bridge.js, ai-apps.js) ----------

// The chat apps the user talks to an AI in; the window they want help with is never one of these.
const CLIENT_APPS = /^(claude|codex|windowsterminal|code|cursor|windsurf|lm studio)\.exe$/i;
// After this long without a call from Claude, "Allow for this task" lapses: the next request is a new task.
const CLAUDE_TASK_GAP_MS = 120_000;
const LOOKS_AT_WINDOW = new Set(["look", "read_page", "screenshot"]);
let bridge = null;
let claudeBrain = null;
let claudeLastCall = 0;
let claudeSessions = 0;

// The window the user works in while they chat with Claude: the frontmost one that isn't Buddy or the chat itself.
async function userWindow() {
  const own = ownPids();
  return (await listWindows()).find((w) => !own.includes(w.pid) && !CLIENT_APPS.test(w.app_name ?? "")) ?? null;
}

function marksForClaude() {
  if (!pendingMarks) return "The user hasn't marked anything yet. They can press Ctrl+Alt+M and draw over what they mean.";
  claudeBrain.marks = new Map(pendingMarks.marks.map((m) => [m.n, m.bounds]));
  claudeBrain.target = pendingMarks.target ?? claudeBrain.target;
  const lines = pendingMarks.marks.map((m) => {
    const under = m.elements.length
      ? m.elements.map((e) => `${e.path}${e.value ? ` (text: ${JSON.stringify(e.value.slice(0, 200))})` : ""}`).join("; ")
      : "no accessibility info; rely on the image";
    return `Mark ${m.n}: under the stroke: ${under}`;
  });
  return [
    { type: "image", source: { type: "base64", media_type: "image/png", data: pendingMarks.image } },
    { type: "text", text: `The image shows the area the user marked, with their translucent blue strokes numbered at their start.\n${lines.join("\n")}` },
  ];
}

// The app the latest call came from, by the name buddy-mcp was given ("Claude", "Codex"…), for the island.
let clientName = "Claude";

/** @param {string} name @param {any} input @param {AbortSignal} signal @param {string} [client] */
async function runForClaude(name, input, signal, client) {
  if (client) clientName = client;
  claudeBrain ??= new Brain({
    point: (bounds, caption) => {
      const shown = point(bounds, caption, "claude");
      releaseLater("claude", 60_000);
      return shown;
    },
    confirm,
    status: (text) => {
      islandFacts.appCall = oneLine(`${clientName}: ${text}`);
      showIsland();
    },
    explain: (plate) => openExplainer(plate, { near: cursor(), observed: claudeBrain?.target ?? null }),
    trace,
    documentsDir: documentsDir(),
    openFile,
  });
  if (Date.now() - claudeLastCall > CLAUDE_TASK_GAP_MS) claudeBrain.standing = { allowed: false };
  claudeLastCall = Date.now();
  if ((LOOKS_AT_WINDOW.has(name) && !input.app && !input.root) || !claudeBrain.target) claudeBrain.target = await userWindow();
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  claudeBrain.abort = abort;
  try {
    return name === "get_marks" ? marksForClaude() : await claudeBrain.runTool(name, input);
  } finally {
    setTimeout(() => {
      if (Date.now() - claudeLastCall > 1000) {
        islandFacts.appCall = null;
        showIsland();
      }
    }, 1500);
  }
}

const appSpec = (/** @type {import("./ai-apps.js").AppId} */ id) => launchSpec(process.execPath, path.join(here, "mcp-server.js"), id);

/** Adds Buddy to one of the AI apps, or takes it out. Resolves an error message, or null. */
async function setClaude(/** @type {import("./ai-apps.js").AppId} */ which, /** @type {boolean} */ on, why = "settings") {
  const error = (await setApp(which, on ? appSpec(which) : null)) ?? (which === "code" ? setCodeAllowed(allowRules(SAFE_TOOLS), on) : null);
  // Claude Code also gets allow rules for Buddy's look-and-point tools, so it doesn't stop to check each one.
  trace({ kind: "claude-setup", which, on, why, error });
  return error;
}

/**
 * Opens a quick Claude Code chat in a terminal: only Buddy's tools, none of the user's plugins or hooks, so each turn
 * is several times faster. Runs on their Claude plan. Resolves an error message, or null.
 */
async function openQuickChat() {
  if (appStatus().code === "missing") return "Claude Code isn't on this PC.";
  const mcpFile = path.join(app.getPath("userData"), "quick-chat-mcp.json");
  fs.writeFileSync(mcpFile, quickChatConfig(appSpec("code")));
  fs.mkdirSync(documentsDir(), { recursive: true });
  const exe = claudeCodeExe();
  const args = quickChatArgs(mcpFile, [...SAFE_TOOLS]);
  const start = (/** @type {string} */ command, /** @type {string[]} */ argv) =>
    new Promise((resolve) => {
      const child = spawn(command, argv, { cwd: documentsDir(), detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => (child.unref(), resolve(true)));
    });
  // Windows Terminal when there is one, else a console window of its own.
  const ok = (await start("wt.exe", ["-d", documentsDir(), "--title", "Buddy · Claude", exe, ...args])) || (await start(exe, args));
  trace({ kind: "quick-chat", ok });
  return ok ? null : "Couldn't start Claude Code.";
}

// Apps that start Buddy under an old name, from where Buddy used to be, or without saying which app they are, are
// pointed at this Buddy.
async function repairClaude() {
  for (const which of staleApps(appSpec)) await setClaude(which, true, "repair");
}

function startClaudeBridge() {
  bridge = startBridge({
    dir: app.getPath("userData"),
    run: runForClaude,
    trace,
    onClients: (n) => {
      trace({ kind: "bridge-clients", n });
      // Say so once when a chat starts using Buddy; tool calls then show on the island as "Codex: …" and so on.
      if (n > claudeSessions) notice("Your AI app is using Buddy");
      claudeSessions = n;
    },
  });
}

// ---------- Tasks: agents with their own windows, tucked into island chips ----------

function startTasks() {
  tasks = createTasks({
    here,
    icon: ICON,
    makeBrain: (ui) => {
      return providerReady() ? makeEngine({ ...providerUI(), trace, documentsDir: documentsDir(), dataDir: app.getPath("userData"), record: recordChange, reveal: revealMade, openFile, ...ui }) : null;
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
  if (fromBubble && mode !== "idle") return progress("Let Buddy finish this answer, then make it a task");
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
  if (result.error) notice(result.error);
  else hideBubble({ now: true });
}
ipcMain.on("new-task", () => newTask({ fromBubble: true }));

// ---------- Tray ----------

// Icons are generated by scripts/make-icon.js from the same pointer shape the overlay draws.
const ICON = path.join(here, "../assets/buddy.ico");
const trayIcon = () => nativeImage.createFromPath(path.join(here, "../assets/tray.png")).resize({ width: 16, height: 16, quality: "best" });

const pretty = (accel) => accel.replaceAll("+", " + ");

// ---------- Launching without a terminal: shortcuts and start-with-Windows ----------

// Installed, Buddy is its own "Desktop Buddy.exe" and the installer makes its shortcuts. From a source checkout it runs
// as `electron <app dir>`, so every launcher passes the app directory to the Electron binary.
const LAUNCH = app.isPackaged ? { path: process.execPath, args: [] } : { path: process.execPath, args: [app.getAppPath()] };

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
  if (!app.isPackaged) writeShortcuts(); // the installer already made them
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
  if (next.model !== before.model || next.effort !== before.effort || JSON.stringify(next.providerModels) !== JSON.stringify(before.providerModels)) setBrainDefaults(settings);
  if (next.provider !== before.provider || JSON.stringify(next.providerURLs) !== JSON.stringify(before.providerURLs)) {
    startBrain();
    refreshModels();
  }
  setAgentPolicy(settings);
  if (next.language !== before.language) voice?.prepare();
  if (next.talkBack === "never" && before.talkBack !== "never") voice?.hush();
  buildTrayMenu();
  showIsland({ force: true });
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
      ...(updates?.state().status === "ready" ? [{ label: `Restart to update to ${updates.state().next}`, click: () => updates.install() }] : []),
      ...(appStatus().code !== "missing" ? [{ label: "Quick chat in Claude Code", click: () => openQuickChat() }] : []),
      { label: "Recent changes…", click: () => settingsWindow.open("activity") },
      { label: "Settings…", click: () => settingsWindow.open() },
      { label: "Recreate shortcuts", visible: process.platform === "win32" && !app.isPackaged, click: writeShortcuts },
      { type: "separator" },
      { label: `agent-desktop: ${path.basename(resolveBinary())}`, enabled: false },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

// ---------- The Settings window ----------

const PREVIEW_LINE = "Hi, I'm Buddy. Click the Formulas tab, and I'll show you the next step.";
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
    key: { saved: fs.existsSync(keyFile()), fromEnv: !!envKey(), env: PROVIDERS[currentProvider()].keyEnv },
    providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, note: p.note, key: p.key, local: !!p.local, keyFrom: p.keyFrom, placeholder: p.placeholder, saved: !!envKey(p.id) || fs.existsSync(keyFile(p.id)), address: providerURL(p.id), defaultAddress: PROVIDERS[p.id].baseURL ?? null, ready: providerReady(p.id) })),
    providerModels: modelListState(),
    modelCheck: modelCheck && { model: modelCheck.model, provider: modelCheck.provider, running: modelCheck.running, stopped: !!modelCheck.stopped, done: modelCheck.done, total: modelCheck.total, passed: modelCheck.passed, missed: modelCheck.missed },
    tested: testedOf(providerURL() ?? undefined, chosenModel() ?? ""),
    checkTasks: CASES.length,
    activity: (activity?.list() ?? []).slice(0, 200).map((e) => ({ id: e.id, at: e.at, from: e.from, kind: e.kind, summary: e.summary, undone: e.undone ?? null, canUndo: e.canUndo, file: e.file ?? null })),
    startsWithWindows: process.platform === "win32" && startsWithWindows(),
    data: { explainers, logBytes },
    claude: appStatus(),
    aiApps: APP_IDS.map((id) => ({ id, label: APPS[id].label, after: APPS[id].after })),
    updates: updates?.state() ?? null,
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
  setKey: setApiKey,
  setAddress,
  checkModel,
  undo: async (id, force) => {
    const res = (await activity?.undo(id, { force })) ?? { ok: false, message: "Nothing to undo." };
    trace({ kind: "undo", ok: res.ok, changed: !!res.changed });
    return res;
  },
  removeKey: () => {
    fs.rmSync(keyFile(), { force: true });
    if (!envKey() && !providerReady()) brain = null;
    else startBrain();
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
  checkUpdates: () => updates?.check(),
  installUpdate: () => updates?.install(),
  openReleases: () => shell.openExternal(RELEASES),
  openNotices: () => shell.openPath(app.isPackaged ? path.join(process.resourcesPath, "THIRD_PARTY_NOTICES.md") : path.join(here, "../THIRD_PARTY_NOTICES.md")),
  setClaude,
});

// ---------- App updates (updates.js) ----------

const RELEASES = "https://github.com/donlapidos/agent-desktop/releases";
let announcedUpdate = null;
function startUpdates() {
  updates = createUpdates({
    enabled: () => settings.autoUpdate,
    onChange: (state) => {
      buildTrayMenu();
      settingsWindow.refresh();
      // Say so once, on the island; the tray and Settings keep offering the restart.
      if (state.status === "ready" && announcedUpdate !== state.next) {
        announcedUpdate = state.next;
        notice(`Buddy ${state.next} is ready: restart from the tray to update`);
      }
    },
    trace,
  });
  updates.start();
}
ipcMain.on("open-settings", () => settingsWindow.open());

app.whenReady().then(() => {
  const loaded = loadSettings(settingsFile());
  settings = loaded.settings;
  if (loaded.recovered) trace({ kind: "settings-recovered", note: "settings.json couldn't be read; kept as settings.json.bad" });
  applyAppearance();
  setBrainDefaults(settings);
  loadModelCaps();
  startActivity();
  refreshModels().catch(() => {});
  setAgentPolicy(settings);
  app.setAppUserModelId(APP_ID);
  const devRun = process.env.BUDDY_POINT_TEST || process.env.BUDDY_EXPLAINER_TEST || process.env.BUDDY_MARK_TEST || process.env.BUDDY_TASK_TEST || process.env.BUDDY_VOICE_TEST || process.env.BUDDY_SETTINGS_TEST || process.env.BUDDY_APPROVAL_TEST || process.env.BUDDY_FILES_TEST || process.env.BUDDY_THEME;
  if (!devRun) firstRunSetup();
  lockExplainerSession();
  clearOldSessions();
  startBrain();
  createOverlays();
  createIsland();
  createBubble();
  createTray();
  startClaudeBridge();
  // Only the real Buddy points Claude's apps at itself, never a test copy with its own data folder.
  if (!app.commandLine.hasSwitch("user-data-dir")) repairClaude().catch((err) => trace({ kind: "claude-setup", why: "repair", error: String(err) }));
  startTasks();
  startVoice();
  startUpdates();
  setTimeout(checkRoutines, 10_000);
  setInterval(checkRoutines, ROUTINE_CHECK_MS);
  trackCursor();
  watchCpu();
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
          console.log("MARK_TEST_DONE");
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
      // It replaces what the user had copied, so it runs only when asked (BUDDY_SETTINGS_TEST_DICTATION=1).
      if (process.env.BUDDY_SETTINGS_TEST_DICTATION) {
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
      } else console.log("SETTINGS_DICTATION", JSON.stringify({ skipped: "not asked for (BUDDY_SETTINGS_TEST_DICTATION)" }));
      // Language: Spanish spoken by the voice, heard through Buddy's own speech process with detection on.
      changeSettings({ language: "auto" });
      voice.mute();
      const clip = await voice.synthesize("Haz clic en la pestaña Fórmulas y luego elige Insertar función.", { lang: "es" });
      const ratio = clip.rate / 16000;
      const pcm = Float32Array.from({ length: Math.floor(clip.audio.length / ratio) }, (_, i) => clip.audio[Math.floor(i * ratio)]);
      const t0 = Date.now();
      console.log("SETTINGS_LANGUAGE", JSON.stringify({ ...(await voice.transcribe(pcm)), ms: Date.now() - t0 }));
      for (const page of ["dictation", "agents", "routines"]) await shoot(page, `settings-${page}`);
      await updates.check();
      await wait(4000);
      await shoot("about", "settings-about");
      console.log("SETTINGS_INSTALLED", JSON.stringify({ packaged: app.isPackaged, agentDesktop: resolveBinary(), userData: app.getPath("userData"), updates: updates.state() }));
      await win.webContents.executeJavaScript(`render(${JSON.stringify(settingsState())})`);
      await shoot("look", "settings-look-coral");
      await shoot("keys", "settings-keys-changed");
      console.log("SETTINGS_TEST_DONE");
    }, 2500);
  } else if (process.env.BUDDY_EXPLAINER_TEST) {
    // Dev check for the explainer renderer: BUDDY_EXPLAINER_TEST=path/to/explainer.json (show_explainer input)
    openExplainer(JSON.parse(fs.readFileSync(process.env.BUDDY_EXPLAINER_TEST, "utf8")));
    setTimeout(async () => {
      const plates = BrowserWindow.getAllWindows().filter((w) => /explainer/i.test(w.webContents.getURL()));
      const out = process.env.BUDDY_EXPLAINER_TEST_OUT;
      if (out && plates[0]) fs.writeFileSync(out, (await plates[0].webContents.capturePage()).toPNG());
      const text = plates[0] ? await plates[0].webContents.executeJavaScript("document.body.innerText") : "";
      console.log("EXPLAINER_SHOWN", JSON.stringify({ windows: plates.length, visible: plates.some((w) => w.isVisible()), chars: text.length, title: text.split("\n").find((l) => l.trim()) ?? "" }));
      console.log("EXPLAINER_TEST_DONE");
    }, 4000);
  } else if (process.env.BUDDY_FILES_TEST) {
    // End-to-end check of Buddy working with files, through the real app: BUDDY_FILES_TEST=<address of a scripted
    // OpenAI-style server> (scripts/e2e.mjs runs one). The model asks to make a file; the approval card is clicked;
    // the file is made, shown, listed in Activity, and undone. Files go to BUDDY_DOCUMENTS_DIR.
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    setTimeout(async () => {
      changeSettings({ provider: "custom", providerURLs: { custom: process.env.BUDDY_FILES_TEST }, providerModels: { custom: "scripted" } });
      setBrainDefaults(settings);
      startBrain();
      await wait(500);
      const answer = bubble.webContents.executeJavaScript(`window.buddy.ask("Make me a shopping list file with eggs, milk and bread.", {})`);
      let carded = false;
      for (let i = 0; i < 100 && !carded; i++) {
        await wait(100);
        carded = await bubble.webContents.executeJavaScript(`document.getElementById("confirm").classList.contains("on")`);
      }
      const card = carded ? await bubble.webContents.executeJavaScript(`document.getElementById("what").textContent`) : null;
      await wait(700);
      if (carded) await bubble.webContents.executeJavaScript(`document.querySelector('#confirm [data-d="allow"]').click()`);
      const { reply } = await answer;
      const file = path.join(documentsDir(), "Shopping list.txt");
      const made = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const listed = activity?.list() ?? [];
      settingsWindow.open("activity");
      await wait(1800);
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("settings.html"));
      const page = win ? await win.webContents.executeJavaScript(`document.getElementById("page-activity").hidden ? null : document.getElementById("activity").innerText`) : null;
      if (win && process.env.BUDDY_FILES_TEST_OUT) fs.writeFileSync(process.env.BUDDY_FILES_TEST_OUT, (await win.webContents.capturePage()).toPNG());
      const undone = listed[0] ? await activity?.undo(listed[0].id) : null;
      console.log("FILES_TEST", JSON.stringify({ card, reply, made, listed: listed.map((e) => ({ kind: e.kind, summary: e.summary, canUndo: e.canUndo })), page, undone, goneAfterUndo: !fs.existsSync(file) }));
      console.log("FILES_TEST_DONE");
    }, 2500);
  } else if (!brain) summon();
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  bridge?.close();
});
