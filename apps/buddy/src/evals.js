// Model check: real Buddy tasks run against any provider and model, scored. Each case is a window (an accessibility
// tree shaped like the real app's, made up so no one's data is in it) and a request. The model runs through Buddy's
// own Brain, prompt and tools; only the desktop is stood in for: looking returns the case's window, pointing and
// guiding are recorded, and actions are approved and recorded. A case passes when the model shows the right controls
// in the right order (or does the right action), the way a person checking its answer would judge it.
import { Brain } from "./brain.js";
import { renderTree } from "./desktop.js";

// ---------- Windows ----------

/** Builds a tree with refs and made-up bounds, laid out top to bottom, the way agent-desktop returns one. */
function windowTree(spec) {
  let n = 0;
  let y = 0;
  const build = ([role, name, children = [], extra = {}]) => {
    /** @type {Record<string, any>} */
    const node = { role, ...(name ? { name } : {}), ...extra };
    if (!["window", "group", "toolbar", "tab list", "menu bar", "pane", "document", "table", "row", "list"].includes(role)) {
      node.ref_id = `@sEVAL:e${++n}`;
      node.bounds = { x: 20 + (n % 12) * 60, y: (y += 4), width: 56, height: 24 };
    }
    if (children.length) node.children = children.map(build);
    return node;
  };
  return build(spec);
}

const EXCEL = windowTree(["window", "Budget.xlsx - Excel", [
  ["tab list", "Ribbon Tabs", [["tab item", "File"], ["tab item", "Home", [], { states: ["selected"] }], ["tab item", "Insert"], ["tab item", "Page Layout"], ["tab item", "Formulas"], ["tab item", "Data"], ["tab item", "Review"], ["tab item", "View"]]],
  ["group", "Clipboard", [["split button", "Paste"], ["button", "Cut"], ["button", "Copy"]]],
  ["group", "Font", [["button", "Bold"], ["button", "Italic"], ["button", "Underline"], ["combo box", "Font Size", [], { value: "11" }]]],
  ["group", "Editing", [["split button", "AutoSum"], ["split button", "Sort & Filter"], ["split button", "Find & Select"]]],
  ["edit", "Name Box", [], { value: "A1" }],
  ["edit", "Formula Bar", [], { value: "Category" }],
  ["table", "Sheet1", [
    ["row", "", [["header item", "Category"], ["header item", "Budget"], ["header item", "Spent"], ["header item", "Left"]]],
    ["row", "", [["data item", "A2", [], { value: "Rent" }], ["data item", "B2", [], { value: "1200" }], ["data item", "C2", [], { value: "1200" }], ["data item", "D2", [], { value: "0" }]]],
    ["row", "", [["data item", "A3", [], { value: "Food" }], ["data item", "B3", [], { value: "400" }], ["data item", "C3", [], { value: "455" }], ["data item", "D3", [], { value: "-55" }]]],
    ["row", "", [["data item", "A4", [], { value: "Travel" }], ["data item", "B4", [], { value: "150" }], ["data item", "C4", [], { value: "90" }], ["data item", "D4", [], { value: "60" }]]],
  ]],
  ["tab item", "Sheet1", [], { states: ["selected"] }],
]]);

const EDGE = windowTree(["window", "New tab - Microsoft Edge", [
  ["tab list", "Tabs", [["tab item", "New tab", [], { states: ["selected"] }], ["button", "New Tab"]]],
  ["toolbar", "App bar", [["button", "Back"], ["button", "Refresh"], ["edit", "Address and search bar", [], { value: "" }], ["button", "Favorites"], ["button", "Collections"], ["button", "Settings and more (Alt+F)"]]],
  ["document", "New tab", [["link", "Outlook"], ["link", "Weather"], ["edit", "Search the web"]]],
]]);

const WORD = windowTree(["window", "Report.docx - Word", [
  ["tab list", "Ribbon Tabs", [["tab item", "File"], ["tab item", "Home", [], { states: ["selected"] }], ["tab item", "Insert"], ["tab item", "Design"], ["tab item", "Layout"], ["tab item", "References"], ["tab item", "Review"], ["tab item", "View"]]],
  ["group", "Font", [["button", "Bold"], ["button", "Italic"], ["button", "Underline"], ["combo box", "Font", [], { value: "Aptos" }]]],
  ["group", "Paragraph", [["button", "Bullets"], ["button", "Numbering"], ["button", "Center"]]],
  ["document", "Page 1 content", [["text", "Quarterly report"], ["text", "Sales rose 12% on the quarter."]]],
]]);

const EXPLORER = windowTree(["window", "Documents - File Explorer", [
  ["toolbar", "Command Bar", [["split button", "New"], ["button", "Cut"], ["button", "Copy"], ["button", "Paste"], ["button", "Rename"], ["button", "Share"], ["button", "Delete"], ["split button", "Sort"], ["split button", "View"], ["button", "See more"]]],
  ["edit", "Address: Documents", [], { value: "This PC > Documents" }],
  ["list", "Items View", [["list item", "Budget.xlsx"], ["list item", "Report.docx"], ["list item", "Photos"]]],
]]);

const NOTEPAD = windowTree(["window", "notes.txt - Notepad", [
  ["menu bar", "Menu bar", [["menu item", "File"], ["menu item", "Edit"], ["menu item", "View"]]],
  ["button", "Settings"],
  ["document", "Text editor", [], { value: "Groceries: eggs, milk, a very long line that runs off the edge of the window and keeps going" }],
]]);

// ---------- Cases ----------

/**
 * @typedef {{ kind: "point" | "guide" | "act" | "explainer" | "other", name: string, input?: any }} Call
 * @typedef {{ id: string, title: string, app: string, window: any, ask: string, check: (calls: Call[], reply: string) => string | null }} EvalCase
 * check returns null when the case passed, else what was wrong, in words.
 */

const shown = (calls) => calls.filter((c) => c.kind === "point" || c.kind === "guide").map((c) => c.name.toLowerCase());

/** Passes when the controls shown include one matching each pattern, in this order (other steps may come between). */
const inOrder = (...patterns) => (calls) => {
  const names = shown(calls);
  let at = 0;
  for (const p of patterns) {
    const i = names.findIndex((n, k) => k >= at && p.test(n));
    if (i < 0) return names.length ? `showed ${names.map((n) => `"${n}"`).join(", ")}; expected one matching ${p} after that` : "didn't show any control";
    at = i;
  }
  return calls.some((c) => c.kind === "act") ? "acted when the user only asked how" : null;
};
const orSays = (pattern, check) => (calls, reply) => (pattern.test(reply) && !calls.some((c) => c.kind === "act") ? null : check(calls, reply));

/** @type {EvalCase[]} */
export const CASES = [
  {
    id: "excel-sort",
    title: "Excel: sort a table, largest first",
    app: "EXCEL.EXE",
    window: EXCEL,
    ask: "How do I sort this table by Spent, largest first?",
    check: inOrder(/^(data|home|sort & filter|spent|c\d)$/, /sort|largest/),
  },
  {
    id: "edge-history",
    title: "Edge: clear browsing history",
    app: "msedge.exe",
    window: EDGE,
    ask: "How do I clear my browsing history?",
    check: orSays(/ctrl\s*\+\s*shift\s*\+\s*del/i, inOrder(/settings and more/, /history|privacy|delete browsing data|clear/)),
  },
  {
    id: "word-pdf",
    title: "Word: save as PDF",
    app: "WINWORD.EXE",
    window: WORD,
    ask: "How do I save this as a PDF?",
    check: inOrder(/^file$/, /save as|export|save a copy|pdf|print/),
  },
  {
    id: "explorer-folder",
    title: "File Explorer: new folder",
    app: "explorer.exe",
    window: EXPLORER,
    ask: "How do I make a new folder here?",
    check: orSays(/ctrl\s*\+\s*shift\s*\+\s*n/i, inOrder(/^new( folder)?$/)),
  },
  {
    id: "notepad-wrap",
    title: "Notepad: turn on word wrap",
    app: "Notepad.exe",
    window: NOTEPAD,
    ask: "The long lines run off the screen. How do I make them wrap?",
    check: inOrder(/^view$/, /word wrap/),
  },
  {
    id: "word-bold-do",
    title: "Word: make text bold, when asked to do it",
    app: "WINWORD.EXE",
    window: WORD,
    ask: "Make the selected text bold for me.",
    check: (calls) =>
      calls.some((c) => c.kind === "act" && ((c.input?.action === "click" && /^bold$/i.test(c.name)) || (c.input?.action === "press" && /ctrl\s*\+\s*b$/i.test(c.input?.keys ?? ""))))
        ? null
        : `didn't click Bold or press Ctrl+B (${calls.map((c) => `${c.kind} ${c.name}`).join(", ") || "no tool calls"})`,
  },
];

// ---------- Running ----------

/** A Brain whose desktop is the case's window: looking reads it, pointing and acting are recorded. */
class EvalBrain extends Brain {
  /** @param {import("./brain.js").BrainUI} ui @param {EvalCase} c @param {Call[]} calls */
  constructor(ui, c, calls) {
    super(ui);
    this.case = c;
    this.calls = calls;
    /** @type {Map<string, string>} */
    this.names = new Map();
    const walk = (n) => {
      if (n.ref_id) this.names.set(n.ref_id, n.name ?? n.role);
      for (const k of n.children ?? []) walk(k);
    };
    walk(c.window);
  }

  async look() {
    const { text } = renderTree(this.case.window, this.bounds, undefined, this.labels);
    this.noteApp(this.case.window, this.case.app);
    return `window: ${this.case.window.name} · ${this.names.size} refs\n${text}`;
  }

  async runTool(name, input) {
    const named = (ref) => this.names.get(ref) ?? String(ref);
    switch (name) {
      case "look":
      case "read_page":
        return this.look();
      case "screenshot":
        return "(No screenshot in this check; use look.)";
      case "list_windows":
        return `w-1 · ${this.case.app} · "${this.case.window.name}" (focused)`;
      case "point_at":
        if (!this.names.has(input.ref)) return `No position known for ${input.ref}. Look again and point at a fresh ref.`;
        this.calls.push({ kind: "point", name: named(input.ref), input });
        return "Pointed.";
      case "guide_steps":
        for (const s of input.steps ?? []) this.calls.push({ kind: "guide", name: String(s.target ?? ""), input: s });
        return "The user followed every step; the last one is done.";
      case "wait_for_user":
        return "They did it: the next step's text appeared.";
      case "act":
        this.calls.push({ kind: "act", name: input.ref ? named(input.ref) : String(input.keys ?? input.action), input });
        return "Done.";
      case "show_explainer":
        this.calls.push({ kind: "explainer", name: String(input.common_name ?? ""), input });
        return "Shown.";
      default:
        this.calls.push({ kind: "other", name, input });
        return "Done.";
    }
  }
}

/**
 * @typedef {{ id: string, title: string, passed: boolean, problem: string | null, reply: string, ms: number, turns: number, tokensIn: number, tokensOut: number, calls: Call[] }} EvalResult
 */

/**
 * Runs the cases on one provider and model. `onCase` hears each result as it lands.
 * @param {{ provider: import("./providers.js").ProviderId, apiKey: string, baseURL?: string, cases?: EvalCase[], timeoutMs?: number, onCase?: (r: EvalResult, i: number, n: number) => void, signal?: AbortSignal }} o
 * @returns {Promise<{ results: EvalResult[], passed: number, total: number, avgMs: number }>}
 */
export async function runEvals({ provider, apiKey, baseURL, cases = CASES, timeoutMs = 120_000, onCase, signal }) {
  const results = [];
  for (const [i, c] of cases.entries()) {
    if (signal?.aborted) break;
    /** @type {Call[]} */
    const calls = [];
    let turns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const ui = {
      apiKey,
      provider,
      baseURL,
      point: async () => {},
      confirm: async () => "allow",
      status: () => {},
      trace: (e) => {
        if (e.kind !== "model") return;
        turns++;
        tokensIn += e.in ?? 0;
        tokensOut += e.out ?? 0;
      },
    };
    const brain = new EvalBrain(ui, c, calls);
    const target = { id: "w-1", app_name: c.app, title: c.window.name };
    const start = Date.now();
    const stop = () => brain.cancel();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    brain.glance(target);
    let reply = "";
    try {
      reply = await brain.ask(c.ask, target);
    } catch (err) {
      reply = `(failed: ${err?.message ?? err})`;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
    const problem = reply === "Okay, stopped." ? "took too long" : c.check(calls, reply);
    const r = { id: c.id, title: c.title, passed: !problem, problem, reply, ms: Date.now() - start, turns, tokensIn, tokensOut, calls };
    results.push(r);
    onCase?.(r, i, cases.length);
  }
  const passed = results.filter((r) => r.passed).length;
  return { results, passed, total: results.length, avgMs: results.length ? Math.round(results.reduce((n, r) => n + r.ms, 0) / results.length) : 0 };
}
