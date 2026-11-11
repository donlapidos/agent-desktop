// Buddy's settings: one JSON file in userData. Every value is checked on the way in and on the way out, so a
// hand-edited, half-written or out-of-date file can never put Buddy in a state it can't handle: anything invalid
// falls back to its default. Writes go to a temporary file first and replace the old one in a single step.
import fs from "node:fs";
import { addressProblem } from "./providers.js";

/** Accent colours for the pointer, island, bubble and task windows. Each reads on both light and dark apps. */
export const ACCENTS = Object.freeze({
  blue: { label: "Blue", hex: "#2f7aff" },
  violet: { label: "Violet", hex: "#8b5cf6" },
  green: { label: "Green", hex: "#16a34a" },
  amber: { label: "Amber", hex: "#e8930c" },
  coral: { label: "Coral", hex: "#f2545b" },
  pink: { label: "Pink", hex: "#e04594" },
  graphite: { label: "Graphite", hex: "#7d8696" },
});

/** Claude models Buddy offers. All accept the effort levels below. */
export const MODELS = Object.freeze([
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable. The default." },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Nearly as capable, about half the price." },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "Fastest and cheapest; best for quick questions." },
]);

export const EFFORTS = Object.freeze(["low", "medium", "high"]);
// Who Buddy thinks with (providers.js). Each provider other than Anthropic has its own model, chosen from the list the
// provider gives for the user's key, so model ids there are only checked for shape.
export const PROVIDER_CHOICES = Object.freeze(["anthropic", "openai", "openrouter", "gemini", "deepseek", "ollama", "lmstudio", "custom"]);
// Where the providers that run at an address the user chooses are: Ollama and LM Studio (their usual address unless
// changed) and another server (no default). providers.js addressProblem() decides which addresses are allowed.
export const ADDRESS_PROVIDERS = Object.freeze(["ollama", "lmstudio", "custom"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,119}$/;
export const TALK_BACK = Object.freeze(["spoken", "always", "never"]);
export const APPEARANCES = Object.freeze(["system", "light", "dark"]);
export const VOICES = 10; // Supertonic voices 0-9
export const SPEED = Object.freeze({ min: 0.8, max: 1.3, step: 0.05 });

/** @typedef {"ask" | "talk" | "mark" | "explain" | "dictate"} HotkeyName */
export const HOTKEY_NAMES = /** @type {readonly HotkeyName[]} */ (Object.freeze(["ask", "talk", "mark", "explain", "dictate"]));

// Dictation: stop at the first pause, or keep going (typing each sentence as you pause) until the key is pressed again.
export const DICTATE_STOP = Object.freeze(["pause", "press"]);
// Listening language: English (Moonshine, fastest) or detected automatically (multilingual Whisper, ~99 languages).
export const LANGUAGES = Object.freeze(["en", "auto"]);
// How much agents may do without asking (see policy.js): ask every time, allow safe moves, or allow everything in
// trusted apps.
export const ROPES = Object.freeze(["ask", "safe", "trusted"]);
export const ROUTINE_EVERY = Object.freeze(["day", "weekday", "week", "hours"]);
export const LIMITS = Object.freeze({ apps: 30, appName: 80, routines: 20, routineName: 60, prompt: 2000 });

// Password managers: agents never act in these unless the user removes them from the list.
const DEFAULT_BLOCKED = Object.freeze(["1Password", "Bitwarden", "Dashlane", "KeePass", "KeePassXC", "LastPass", "Keeper"]);

export const DEFAULTS = Object.freeze({
  voice: 0,
  speed: 1.0,
  talkBack: "spoken",
  accent: "blue",
  appearance: "system",
  hotkeys: Object.freeze({ ask: "Control+Alt+B", talk: "Control+Alt+T", mark: "Control+Alt+M", explain: "Control+Alt+E", dictate: "Control+Alt+D" }),
  provider: "anthropic",
  model: "claude-opus-5-5",
  providerModels: Object.freeze({}),
  providerURLs: Object.freeze({}),
  effort: "medium",
  dictateStop: "pause",
  language: "en",
  rope: "ask",
  trustedApps: Object.freeze([]),
  blockedApps: DEFAULT_BLOCKED,
  routines: Object.freeze([]),
  autoUpdate: true,
  launchSetupDone: false,
});

/**
 * @typedef {{ every: "day" | "weekday" | "week" | "hours", time: string, days: number[], hours: number }} Schedule
 * @typedef {{ id: string, name: string, prompt: string, schedule: Schedule, enabled: boolean, lastRun: string | null }} Routine
 * @typedef {{
 *   voice: number, speed: number, talkBack: string, accent: string, appearance: string,
 *   hotkeys: Record<HotkeyName, string>, provider: string, model: string, providerModels: Record<string, string>, providerURLs: Record<string, string>, effort: string, dictateStop: string, language: string,
 *   rope: string, trustedApps: string[], blockedApps: string[], routines: Routine[], autoUpdate: boolean,
 *   launchSetupDone: boolean,
 * }} Settings
 */

// App names as the user types them ("Excel", "EXCEL.EXE"); compared without case or ".exe" (see policy.js).
function appList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const v of value) {
    const name = typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim() : "";
    if (!name || name.length > LIMITS.appName) continue;
    if (out.some((x) => x.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
    if (out.length === LIMITS.apps) break;
  }
  return out;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A routine as stored, or null when it can't be made valid (no id, no prompt). @returns {Routine | null} */
export function routine(r) {
  if (!r || typeof r !== "object") return null;
  const id = typeof r.id === "string" && /^[a-z0-9]{4,24}$/.test(r.id) ? r.id : null;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim().slice(0, LIMITS.prompt) : "";
  if (!id || !prompt) return null;
  const s = r.schedule && typeof r.schedule === "object" ? r.schedule : {};
  const days = Array.isArray(s.days) ? [...new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  const every = pick(s.every, ROUTINE_EVERY, "weekday");
  return {
    id,
    name: (typeof r.name === "string" && r.name.trim() ? r.name.trim() : prompt).slice(0, LIMITS.routineName),
    prompt,
    schedule: {
      every,
      time: typeof s.time === "string" && TIME.test(s.time) ? s.time : "09:00",
      days: every === "week" && !days.length ? [1] : days,
      hours: Number.isInteger(s.hours) && s.hours >= 1 && s.hours <= 24 ? s.hours : 4,
    },
    enabled: r.enabled !== false,
    lastRun: typeof r.lastRun === "string" && !Number.isNaN(Date.parse(r.lastRun)) ? r.lastRun : null,
  };
}

function routineList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const r of value) {
    const ok = routine(r);
    if (ok && !out.some((x) => x.id === ok.id)) out.push(ok);
    if (out.length === LIMITS.routines) break;
  }
  return out;
}

const MODIFIERS = ["Control", "Alt", "Shift", "Super"];
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|Minus|=|,|\.|\/|;|'|\[|\]|\\|`)$/;

/**
 * A global shortcut Buddy accepts: one or more modifiers in a fixed order, at least one of them Control, Alt or the
 * Windows key (Shift alone would take a key away from typing), then one key.
 * @param {unknown} accel
 */
export function isHotkey(accel) {
  if (typeof accel !== "string") return false;
  const parts = accel.split("+");
  const key = parts.pop();
  if (!key || !KEY.test(key) || !parts.length) return false;
  if (!parts.every((p) => MODIFIERS.includes(p))) return false;
  if (new Set(parts).size !== parts.length) return false;
  const ordered = [...parts].sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  if (ordered.join("+") !== parts.join("+")) return false;
  return parts.some((p) => p !== "Shift");
}

const round = (n, step) => Math.round(n / step) * step;
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** @returns {Record<string, string>} */
function providerModels(value) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of PROVIDER_CHOICES.filter((x) => x !== "anthropic")) if (MODEL_ID.test(value?.[id] ?? "")) out[id] = value[id];
  return out;
}

/** @returns {Record<string, string>} */
function providerURLs(value) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of ADDRESS_PROVIDERS) if (typeof value?.[id] === "string" && value[id].length <= 300 && !addressProblem(value[id])) out[id] = value[id].replace(/\/+$/, "");
  return out;
}

/**
 * A complete, valid settings object from anything: unknown keys are dropped, invalid values take their default.
 * @param {any} raw
 * @returns {Settings}
 */
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const voice = Number.isInteger(r.voice) && r.voice >= 0 && r.voice < VOICES ? r.voice : DEFAULTS.voice;
  const speed = typeof r.speed === "number" && Number.isFinite(r.speed)
    ? +Math.min(SPEED.max, Math.max(SPEED.min, round(r.speed, SPEED.step))).toFixed(2)
    : DEFAULTS.speed;
  /** @type {Record<HotkeyName, string>} */
  let hotkeys = { ...DEFAULTS.hotkeys };
  const given = r.hotkeys && typeof r.hotkeys === "object" ? r.hotkeys : {};
  for (const name of HOTKEY_NAMES) if (isHotkey(given[name])) hotkeys[name] = given[name];
  // Two actions can't share a shortcut. update() refuses a change that would; a file that has one anyway (edited by
  // hand) goes back to the defaults, which are known to be distinct.
  if (new Set(Object.values(hotkeys)).size !== HOTKEY_NAMES.length) hotkeys = { ...DEFAULTS.hotkeys };
  return {
    voice,
    speed,
    talkBack: pick(r.talkBack, TALK_BACK, DEFAULTS.talkBack),
    accent: Object.hasOwn(ACCENTS, r.accent) ? r.accent : DEFAULTS.accent,
    appearance: pick(r.appearance, APPEARANCES, DEFAULTS.appearance),
    hotkeys,
    provider: pick(r.provider, PROVIDER_CHOICES, DEFAULTS.provider),
    model: pick(r.model, MODELS.map((m) => m.id), DEFAULTS.model),
    providerModels: providerModels(r.providerModels),
    providerURLs: providerURLs(r.providerURLs),
    effort: pick(r.effort, EFFORTS, DEFAULTS.effort),
    dictateStop: pick(r.dictateStop, DICTATE_STOP, DEFAULTS.dictateStop),
    language: pick(r.language, LANGUAGES, DEFAULTS.language),
    rope: pick(r.rope, ROPES, DEFAULTS.rope),
    trustedApps: appList(r.trustedApps, DEFAULTS.trustedApps),
    blockedApps: appList(r.blockedApps, DEFAULTS.blockedApps),
    routines: routineList(r.routines),
    autoUpdate: r.autoUpdate !== false,
    launchSetupDone: r.launchSetupDone === true,
  };
}

/**
 * Applies a change. Returns the new settings and the names of fields whose new value was refused.
 * @param {Settings} current
 * @param {any} patch
 */
export function update(current, patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const hotkeys = { ...current.hotkeys };
  // A new shortcut already used by another action is refused; the action keeps its current one.
  for (const [name, accel] of Object.entries(p.hotkeys && typeof p.hotkeys === "object" ? p.hotkeys : {})) {
    if (!HOTKEY_NAMES.includes(/** @type {HotkeyName} */ (name))) continue;
    const clash = HOTKEY_NAMES.some((other) => other !== name && hotkeys[other] === accel);
    if (!clash) hotkeys[name] = accel;
  }
  // A provider's model is changed one provider at a time; the others keep theirs.
  const models = p.providerModels && typeof p.providerModels === "object" ? { ...current.providerModels, ...p.providerModels } : current.providerModels;
  const urls = p.providerURLs && typeof p.providerURLs === "object" ? { ...current.providerURLs, ...p.providerURLs } : current.providerURLs;
  const merged = { ...current, ...p, hotkeys, providerModels: models, providerURLs: urls };
  const next = normalize(merged);
  const rejected = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === "providerModels" || k === "providerURLs") {
      for (const [id, value] of Object.entries(v ?? {})) if (next[k][id] !== String(value).replace(/\/+$/, "")) rejected.push(`${k}.${id}`);
    } else if (k === "hotkeys") {
      for (const [name, accel] of Object.entries(v ?? {})) if (next.hotkeys[name] !== accel) rejected.push(`hotkeys.${name}`);
    } else if (Array.isArray(next[k])) {
      // Lists are tidied on the way in (names trimmed, defaults filled); only a dropped entry counts as refused.
      if (!Array.isArray(v) || next[k].length < v.length) rejected.push(k);
    } else if (JSON.stringify(next[k]) !== JSON.stringify(v)) rejected.push(k);
  }
  return { settings: next, rejected };
}

/**
 * Reads the settings file. A file that exists but can't be read is set aside as settings.json.bad, and Buddy
 * carries on with defaults, without re-running first-run setup: the file existing means setup already happened.
 * @param {string} file
 * @returns {{ settings: Settings, recovered: boolean }}
 */
export function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { settings: normalize({}), recovered: false };
  }
  try {
    return { settings: normalize(JSON.parse(text)), recovered: false };
  } catch {
    try {
      fs.renameSync(file, `${file}.bad`);
    } catch {}
    return { settings: { ...normalize({}), launchSetupDone: true }, recovered: true };
  }
}

/** Writes the settings beside the file first, then swaps it in, so a crash mid-write never leaves half a file. */
export function save(file, /** @type {Settings} */ settings) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalize(settings), null, 2));
  fs.renameSync(tmp, file);
}
