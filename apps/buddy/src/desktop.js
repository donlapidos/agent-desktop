// Thin bridge to the agent-desktop CLI. Every call returns the parsed JSON envelope
// ({ ok, data } or { ok: false, error }), never throws for a structured tool error.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redeem } from "./approvals.js";

/** @typedef {import("./geometry.js").PhysicalPoint} PhysicalPoint */
/** @typedef {import("./geometry.js").PhysicalRect} PhysicalRect */
/**
 * A window as agent-desktop lists it. Its bounds are physical pixels.
 * @typedef {{ id: string, pid: number, app_name: string, title: string, is_focused?: boolean, minimized?: boolean, bounds?: PhysicalRect }} DesktopWindow
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop";

// The installed app carries agent-desktop in its resources folder (electron-builder's extraResources); a source checkout
// uses the repo's own build.
export function resolveBinary() {
  const resources = /** @type {any} */ (process).resourcesPath;
  const candidates = [
    process.env.AGENT_DESKTOP_BIN,
    resources && path.join(resources, "bin", exe),
    path.resolve(here, "../../../target/release", exe),
    path.resolve(here, "../../../target/debug", exe),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? "agent-desktop";
}

const BIN = resolveBinary();

/**
 * @typedef {{ ok: true, data?: any } | { ok: false, error: { code: string, message?: string, details?: any } }} Envelope
 * @typedef {{ timeoutMs?: number, signal?: AbortSignal, session?: string }} RunOptions
 */

// Commands that only look. observe() runs these and nothing else; everything that operates the computer goes
// through perform(), which needs a slip from approvals.js.
const READ_ONLY = new Set(["version", "list-windows", "snapshot", "screenshot"]);

/**
 * Runs a read-only agent-desktop command.
 * @param {string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<Envelope>}
 */
export function observe(args, opts = {}) {
  if (!READ_ONLY.has(args[0])) {
    return Promise.resolve({ ok: false, error: { code: "NOT_READ_ONLY", message: `${args[0]} operates the computer; it needs an approval (perform).` } });
  }
  return run(args, opts);
}

/**
 * Runs an approved input action, once.
 * @param {import("./approvals.js").Approved} slip
 * @param {RunOptions} [opts]
 * @returns {Promise<Envelope>}
 */
export function perform(slip, opts = {}) {
  if (!redeem(slip)) return Promise.resolve({ ok: false, error: { code: "NOT_APPROVED", message: "This action was not approved." } });
  return run(slip.args, { ...opts, headed: slip.headed });
}

// `session` keeps an agent's snapshots in their own namespace: agent-desktop keeps only the newest 128 snapshots
// per namespace, so agents sharing one would push each other's refs out.
/**
 * @param {string[]} args
 * @param {RunOptions & { headed?: boolean }} opts
 * @returns {Promise<Envelope>}
 */
function run(args, { timeoutMs = 30_000, headed = false, signal, session } = {}) {
  const argv = headed ? ["--headed", ...args] : args;
  const env = session ? { ...process.env, AGENT_DESKTOP_SESSION: session } : undefined;
  return new Promise((resolve) => {
    execFile(
      BIN,
      argv,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal, env },
      (err, stdout, stderr) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({
            ok: false,
            error: {
              code: "BRIDGE_ERROR",
              message: (stderr || err?.message || "no output").toString().slice(0, 500),
            },
          });
        }
      },
    );
  });
}

// The window the user was looking at, ignoring our own process.
/** @param {number[]} [ownPids] @returns {Promise<DesktopWindow | null>} */
export async function foregroundWindow(ownPids = []) {
  const res = await observe(["list-windows"], { timeoutMs: 8_000 });
  if (!res.ok) return null;
  const windows = Array.isArray(res.data) ? res.data : res.data?.windows ?? [];
  return windows.find((w) => w.is_focused && !ownPids.includes(w.pid)) ?? null;
}

/** @returns {Promise<DesktopWindow[]>} */
export async function listWindows() {
  const res = await observe(["list-windows"], { timeoutMs: 8_000 });
  if (!res.ok) return [];
  return Array.isArray(res.data) ? res.data : res.data?.windows ?? [];
}

/** @param {PhysicalRect | undefined} b @param {PhysicalPoint} p */
const contains = (b, p) => b && p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

// The window under a physical screen point: the focused one if it covers the point, else any visible one that does.
/** @param {PhysicalPoint} point @param {number[]} [ownPids] */
export async function windowAt(point, ownPids = []) {
  const candidates = (await listWindows()).filter((w) => !ownPids.includes(w.pid) && !w.minimized && contains(w.bounds, point));
  return candidates.find((w) => w.is_focused) ?? candidates[0] ?? null;
}

// Describe the deepest accessible element under a physical screen point, with its ancestry,
// so the model knows what the user is pointing at even when pixels are ambiguous.
/** @param {DesktopWindow | null} win @param {PhysicalPoint} point */
export async function elementAt(win, point) {
  return (await elementsAt(win, [point]))[0] ?? null;
}

// Same, for many points in one window, from a single snapshot (marker strokes sample several points each).
/** @param {DesktopWindow | null} win @param {PhysicalPoint[]} points */
export async function elementsAt(win, points) {
  if (!win) return points.map(() => null);
  const res = await observe(
    ["snapshot", "--app", win.app_name, "--window-id", win.id, "--include-bounds", "--max-depth", "25"],
    { timeoutMs: 12_000 },
  );
  if (!res.ok) return points.map(() => null);
  return points.map((point) => deepestAt(res.data.tree, point));
}

/** @param {any} tree @param {PhysicalPoint} point */
function deepestAt(tree, point) {
  // Deepest containing node wins; among equals, the smallest (overlapping panes often share a point).
  /** @type {{ node: any, path: string[] } | null} */
  let best = null;
  const area = (b) => b.width * b.height;
  const walk = (node, path) => {
    if (!contains(node.bounds, point)) return;
    const label = [node.role, node.name && JSON.stringify(node.name)].filter(Boolean).join(" ");
    const here = [...path, label];
    if (!best || here.length > best.path.length || (here.length === best.path.length && area(node.bounds) < area(best.node.bounds))) {
      best = { node, path: here };
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  walk(tree, []);
  if (!best) return null;
  const { node, path } = best;
  const value = node.value != null ? String(node.value).slice(0, 600) : undefined;
  return { role: node.role, name: node.name, value, path: path.slice(-6).join(" › ") };
}

// Group points by the window under each, so marks that span apps still resolve.
/** @param {PhysicalPoint[]} points @param {number[]} [ownPids] @returns {Promise<(DesktopWindow | null)[]>} */
export async function windowsAt(points, ownPids = []) {
  const windows = (await listWindows()).filter((w) => !ownPids.includes(w.pid) && !w.minimized);
  return points.map((p) => {
    const hits = windows.filter((w) => contains(w.bounds, p));
    return hits.find((w) => w.is_focused) ?? hits[0] ?? null;
  });
}

const INTERESTING_STATES = new Set([
  "checked", "selected", "expanded", "collapsed", "disabled", "focused", "pressed", "offscreen",
]);

// Turn a snapshot tree into indented text for the model, and collect ref -> bounds
// for the pointer. Bounds stay out of the model's context.
// `labels`, when given, collects ref -> a plain name for the element ("Save" (button)) for approval cards.
/**
 * @param {any} tree
 * @param {Map<string, PhysicalRect>} [bounds] ref -> where the element is, for the pointer
 * @param {number} [maxChars]
 * @param {Map<string, string> | null} [labels]
 */
export function renderTree(tree, bounds = new Map(), maxChars = 24_000, labels = null) {
  const lines = [];
  let used = 0;
  let clipped = false;

  const walk = (node, depth) => {
    if (!node || clipped) return;
    if (node.ref_id && node.bounds) bounds.set(node.ref_id, node.bounds);
    if (node.ref_id && labels) labels.set(node.ref_id, node.name ? `${JSON.stringify(String(node.name).slice(0, 60))} (${node.role ?? "control"})` : `the ${node.role ?? "control"}`);
    const parts = [];
    if (node.ref_id) parts.push(node.ref_id);
    parts.push(node.role ?? "?");
    if (node.name) parts.push(JSON.stringify(node.name));
    if (node.value != null && node.value !== "" && node.value !== node.name) {
      parts.push(`value=${JSON.stringify(String(node.value).slice(0, 120))}`);
    }
    const states = (node.states ?? []).filter((s) => INTERESTING_STATES.has(s));
    if (states.length) parts.push(`[${states.join(",")}]`);
    if (node.children_count && !node.children?.length) parts.push(`(+${node.children_count} hidden; drill with root)`);
    if (node.subtree_truncated) parts.push("(truncated)");
    const line = "  ".repeat(depth) + parts.join(" ");
    used += line.length + 1;
    if (used > maxChars) {
      clipped = true;
      lines.push("… output clipped; use `look` with root=<ref> to drill into one region.");
      return;
    }
    lines.push(line);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };

  walk(tree, 0);
  return { text: lines.join("\n"), bounds };
}

// ---------- Reading view: a page or document as text, in reading order ----------

const READ_SKIP = new Set([
  "scrollbar", "separator", "slider", "toolbar", "menubar", "menu", "menuitem", "menubutton", "tablist", "tab",
  "combobox", "button", "spinbutton", "progressbar", "tooltip", "titlebar",
]);
const READ_INLINE = new Set(["statictext", "text", "link", "image"]);
const READ_HEADING = /heading/i;
const isHeading = (n) => READ_HEADING.test(n.role ?? "") || READ_HEADING.test(n.role_description ?? "");
// Chromium reports page list items as "option" (described "list item"); dropdown options never get here
// because their combobox is skipped whole.
const isListItem = (n) => n.role === "listitem" || n.role === "option" || /list item/i.test(n.role_description ?? "");
const area = (b) => (b ? Math.max(0, b.width) * Math.max(0, b.height) : 0);
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// The page itself, not the browser around it: the document with the largest on-screen area (the visible tab).
// Browsers wrap the page in a shell document of the same size, so ties go to the one with more content.
function documentRoot(tree) {
  const size = (n) => 1 + (n.children ?? []).reduce((s, c) => s + size(c), 0);
  let best = null;
  let bestKey = [0, 0];
  const walk = (n) => {
    if (!n) return;
    if (n.role === "document") {
      const key = [area(n.bounds), size(n)];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) [best, bestKey] = [n, key];
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return best;
}

// Headings, paragraphs (runs of text and links joined back together), list items, table rows and image
// descriptions, in document order. Lines the user can see right now sit between "▼ on screen" and "▲" markers,
// so the model knows what "this" refers to. Controls are left out: `look` is for those.
export function renderReading(tree, maxChars = 60_000) {
  const doc = documentRoot(tree);
  const root = doc ?? tree;
  const view = doc?.bounds ?? tree?.bounds;
  const blocks = []; // { text, visible }

  const visible = (n) => !(n.states ?? []).includes("offscreen") && overlaps(n.bounds, view);
  const inlineText = (n) => {
    if (n.role === "image") return n.name ? `[image: ${tidy(n.name)}]` : "";
    if (n.role === "link") return tidy(n.name) || (n.children ?? []).map(inlineText).join(" ");
    return tidy(n.name ?? n.value);
  };
  const push = (text, node) => {
    const t = tidy(text);
    if (!t || blocks.at(-1)?.text === t) return;
    blocks.push({ text: t, visible: visible(node) });
  };

  const walk = (node, listDepth) => {
    if (!node) return;
    const role = node.role ?? "";
    if (READ_SKIP.has(role)) return;
    if (isHeading(node)) {
      return push(`## ${tidy(node.name) || (node.children ?? []).map(inlineText).join(" ")}`, node);
    }
    // Editors like Notepad and Word expose the whole text as the value of a field described as a document.
    if (role === "textfield" && /document/i.test(node.role_description ?? "") && node.value) {
      for (const line of String(node.value).split(/\r?\n/)) push(line, node);
      return;
    }
    if (role === "textfield" || role === "searchfield") {
      const v = tidy(node.value);
      if (v) push(`[field ${tidy(node.name) || ""}: ${v}]`, node);
      return;
    }
    if (role === "row") {
      const cells = (node.children ?? []).map((c) => tidy(c.name) || (c.children ?? []).map(inlineText).join(" "));
      return push(`| ${cells.join(" | ")} |`, node);
    }
    if (READ_INLINE.has(role)) return push(inlineText(node), node);

    // A container: join consecutive inline children into one paragraph, recurse into the rest.
    const bullet = isListItem(node) ? "- " : "";
    let run = [];
    let runNode = null;
    const flush = () => {
      if (run.length) push(bullet + "  ".repeat(Math.max(0, listDepth - 1)) + run.join(" "), runNode);
      run = [];
      runNode = null;
    };
    for (const child of node.children ?? []) {
      if (READ_INLINE.has(child.role) && !isHeading(child)) {
        const t = inlineText(child);
        if (t) {
          run.push(t);
          runNode ??= child;
        }
      } else {
        flush();
        walk(child, role === "list" ? listDepth + 1 : listDepth);
      }
    }
    flush();
    if (!node.children?.length && tidy(node.name) && role !== "document" && role !== "group") push(bullet + tidy(node.name), node);
  };
  walk(root, 0);

  const lines = [];
  let used = 0;
  let inView = false;
  let shown = 0;
  for (const b of blocks) {
    if (b.visible !== inView) {
      lines.push(b.visible ? "▼ on screen now" : "▲ end of what's on screen");
      inView = b.visible;
    }
    used += b.text.length + 1;
    if (used > maxChars) break;
    lines.push(b.text);
    shown++;
  }
  if (inView) lines.push("▲ end of what's on screen");
  const rest = blocks.slice(shown).reduce((n, b) => n + b.text.length, 0);
  if (rest) lines.push(`… the page continues for about ${rest} more characters that didn't fit.`);
  return { title: tidy(doc?.name), text: lines.join("\n"), blocks: blocks.length };
}

// ---------- Waiting for the user: did they do the step Buddy pointed at? ----------

const hasText = (node, needle) =>
  !!node && ([node.name, node.value].some((v) => typeof v === "string" && v.toLowerCase().includes(needle)) ||
    (node.children ?? []).some((c) => hasText(c, needle)));

// Polls until `text` shows up: as the title of a window of the same app (a dialog they opened) or among the
// controls of the window they are working in (a ribbon tab, a menu, a pane). One check about every second.
// Resolves { status: "appeared" | "timeout" | "cancelled" }; when it appeared, also the snapshot it was seen in
// (and the window, which is a new one when the step opened a dialog), so the caller can go straight on.
const windowTarget = (w) => ["--app", w.app_name, "--window-id", w.id];
const WAIT_SNAPSHOT = ["-i", "--compact", "--include-bounds", "--max-depth", "25", "--timeout-ms", "3000"];
export async function waitForText({ win, text, timeoutMs = 45_000, signal, session }) {
  const needle = String(text).toLowerCase().trim();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal?.aborted) return { status: "cancelled" };
    const dialog = (await listWindows()).find((w) => w.pid === win.pid && w.title?.toLowerCase().includes(needle));
    if (dialog) {
      const res = await snapshotResilient(windowTarget(dialog), WAIT_SNAPSHOT, { timeoutMs: 8_000, signal, session });
      return { status: "appeared", window: dialog, snapshot: res.ok ? res.data : null };
    }
    const res = await snapshotResilient(windowTarget(win), WAIT_SNAPSHOT, { timeoutMs: 8_000, signal, session });
    if (res.ok && hasText(res.data.tree, needle)) return { status: "appeared", window: win, snapshot: res.data };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: signal?.aborted ? "cancelled" : "timeout" };
}

// ---------- Resilient snapshots ----------

// Some apps have a branch that refuses to list its children (Excel does, with a table on the sheet), and
// agent-desktop then fails the whole snapshot. This reads such a window region by region instead: the shallow
// skeleton first, then each region in parallel; a region that still fails is left out (marked subtree_truncated).
// Going deeper inside the failing region was measured on Excel and found nothing more, only added seconds. A window that failed once goes straight to
// regions for a minute, so a guided walk-through doesn't pay for the failing attempt on every step.
const faultyWindows = new Map(); // window args key -> time it last faulted
const FAULT_MEMORY_MS = 60_000;
const isWalkFault = (res) => !res.ok && res.error?.code === "ACTION_FAILED" && !!res.error?.details?.faults;

export async function snapshotResilient(target, extra, opts = {}) {
  const key = target.join(" ");
  const knownFaulty = Date.now() - (faultyWindows.get(key) ?? 0) < FAULT_MEMORY_MS;
  if (!knownFaulty) {
    const res = await observe(["snapshot", ...target, ...extra], opts);
    if (!isWalkFault(res)) return res;
    faultyWindows.set(key, Date.now());
  }
  const skeleton = await observe(["snapshot", ...target, "--skeleton", "--include-bounds"], opts);
  if (!skeleton.ok) return skeleton;
  // Regions run in parallel, which slows each one; a region read that runs out of time fails outright instead of
  // returning what it saw, so give them room. A caller's own depth and deadline win.
  const regionExtra = extra.filter((a) => a !== "--skeleton");
  if (!regionExtra.includes("--max-depth")) regionExtra.push("--max-depth", "25");
  if (!regionExtra.includes("--timeout-ms")) regionExtra.push("--timeout-ms", "9000");
  let unreadable = 0;
  const graft = async (node) => {
    if (node.ref_id && node.children_count && !node.children?.length) {
      const part = await observe(["snapshot", "--root", node.ref_id, ...regionExtra], opts);
      if (part.ok) {
        node.children = part.data.tree.children ?? [];
        delete node.children_count;
        return;
      }
      node.subtree_truncated = true;
      unreadable++;
      return;
    }
    await Promise.all((node.children ?? []).map(graft));
  };
  await graft(skeleton.data.tree);
  if (unreadable) faultyWindows.set(key, Date.now());
  const refs = (n) => (n.ref_id ? 1 : 0) + (n.children ?? []).reduce((s, ch) => s + refs(ch), 0);
  return { ...skeleton, data: { ...skeleton.data, ref_count: refs(skeleton.data.tree), complete: false, unreadable_regions: unreadable } };
}
