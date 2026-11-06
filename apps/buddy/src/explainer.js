// Renders a field-guide plate from the structured explainer the model writes.
// The model supplies facts and one SVG figure; this file owns every layout decision.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => path.join(here, "ui", f);

const FONTS = [
  ["Alegreya Sans", 500, "normal", "alegreya-sans-500.woff2"],
  ["Alegreya Sans", 500, "italic", "alegreya-sans-500-italic.woff2"],
  ["Alegreya Sans", 800, "normal", "alegreya-sans-800.woff2"],
  ["Patrick Hand", 400, "normal", "patrick-hand-400.woff2"],
];

let cachedHead;
function head() {
  if (cachedHead) return cachedHead;
  const faces = FONTS.map(([family, weight, style, file]) => {
    const data = fs.readFileSync(ui(`fonts/${file}`)).toString("base64");
    return `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
  }).join("\n");
  cachedHead = `${faces}\n${fs.readFileSync(ui("explainer.css"), "utf8")}`;
  return cachedHead;
}

const CONTRACT = `<!--
THESIS: Every explainer is a plate in a field guide to whatever is on your screen; it refuses the stock AI card stack (rounded cards, stat tiles, tinted callouts).
OWN-WORLD: Pale sage plate paper, ink, five naturalist pigments used only inside the figure; Alegreya Sans species names, Patrick Hand plate labels, Segoe body; Buddy-blue numbered Peterson arrows are the only accent.
STORY: The reader identifies the thing they pointed at, sees its anatomy, learns how it behaves and how to tell it from look-alikes, and keeps the plate.
FIRST VIEWPORT: Species name at 44px with italic taxonomy and a one-sentence summary; below, a full-bleed plate figure with leader-line labels and numbered arrows.
FORM: Field-guide plate (Peterson/Sibley), grounded candidate 1; seed key 2ca35e7b.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

// Peterson arrows: a numbered disc with a short arrow. r/l are 44x22 with the tip on the right/left edge;
// u/d are 22x44 with the tip on the top/bottom edge. The number always stays upright.
const ARROWS = {
  r: { id: "", box: "0 0 44 22", shaft: "M20 11 H33", tip: "M33 5 L44 11 L33 17 Z", c: [11, 11] },
  l: { id: "l", box: "0 0 44 22", shaft: "M24 11 H11", tip: "M11 5 L0 11 L11 17 Z", c: [33, 11] },
  u: { id: "u", box: "0 0 22 44", shaft: "M11 24 V11", tip: "M5 11 L11 0 L17 11 Z", c: [11, 33] },
  d: { id: "d", box: "0 0 22 44", shaft: "M11 20 V33", tip: "M5 33 L11 44 L17 33 Z", c: [11, 11] },
};

const arrow = (n, dir) => {
  const a = ARROWS[dir];
  const [cx, cy] = a.c;
  // Presentation attributes, not classes: Chromium does not style <use> clones from document class rules.
  return `<symbol id="m${n}${a.id}" viewBox="${a.box}"><path d="${a.shaft}" stroke="var(--mark)" stroke-width="3"/><path d="${a.tip}" fill="var(--mark)"/><circle cx="${cx}" cy="${cy}" r="9.5" fill="var(--mark-disc)"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="var(--mark-num)" font-family="Segoe UI Variable Text, Segoe UI, sans-serif" font-size="12" font-weight="700">${n}</text></symbol>`;
};

const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<marker id="dot" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6"><circle cx="3" cy="3" r="2.4" fill="var(--ink-2)"/></marker>
<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="var(--ink)"/></marker>
<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-3)" stroke-width="1"/></pattern>
<pattern id="stipple" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.9" fill="var(--ink-3)"/><circle cx="5.5" cy="5" r="0.7" fill="var(--ink-3)"/></pattern>
${[1, 2, 3, 4, 5, 6].map((n) => Object.keys(ARROWS).map((d) => arrow(n, d)).join("")).join("\n")}
</defs></svg>`;

const BUDDY_MARK = `<svg width="14" height="14" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 2 L19 10 L11.5 12 L8.5 19.5 Z" fill="var(--mark)"/></svg>`;

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Model SVG may draw anything, but may not run, load or navigate.
export function sanitizeSvg(svg) {
  const s = String(svg ?? "").trim();
  if (!/^<svg[\s>]/i.test(s)) return "";
  return s
    .replace(/<(script|style|foreignObject|iframe|object|embed|a)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|foreignObject|iframe|object|embed|a|image|link|meta)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(xlink:)?href\s*=\s*("|')(?!#)[^"']*\2/gi, "")
    // SMIL could otherwise animate an href to somewhere outside the page.
    .replace(/<(animate|set)\b[^>]*attributeName\s*=\s*("|')(xlink:)?href\2[^>]*\/?>/gi, "");
}

// Scenes share one page, so each scene's own ids get a prefix; the shared defs (#m1.., #dot, #head, #hatch,
// #stipple) are left alone because a scene only references them, never defines them.
function scopeIds(svg, prefix) {
  let s = svg;
  for (const id of new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))) {
    const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${prefix}${id}$2`)
      .replace(new RegExp(`(url\\(#)${e}(\\))`, "g"), `$1${prefix}${id}$2`)
      .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, "g"), `$1${prefix}${id}$2`)
      .replace(new RegExp(`((?:begin|end)="[^"]*?)\\b${e}\\.`, "g"), `$1${prefix}${id}.`);
  }
  return s;
}

// Normalize every ink line to length 1 so the stylesheet can draw it on with one dash rule, whatever its size.
// outline-soft keeps its real length: its dash pattern is measured in pixels.
const INK_CLASS = /\sclass="(?:[^"]*\s)?(?:outline|flow|leader)(?:\s[^"]*)?"/;
function prepareFigure(svg, { reducedMotion }) {
  let s = svg.replace(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*?)(\/?)>/gi, (tag, name, attrs, slash) =>
    INK_CLASS.test(attrs) && !/\spathLength=/.test(attrs) ? `<${name}${attrs} pathLength="1"${slash}>` : tag,
  );
  // SMIL ignores prefers-reduced-motion, so motion is removed at render time instead.
  if (reducedMotion) {
    s = s
      .replace(/<(animate|animateMotion|animateTransform|set)\b[^>]*\/>/gi, "")
      .replace(/<(animate|animateMotion|animateTransform|set)\b[\s\S]*?<\/\1\s*>/gi, "");
  }
  return s;
}

// The motion player. It is the only script a plate may run: the page's CSP admits exactly this text by hash,
// so nothing the model writes can execute. It steps through the scenes, restarting each scene's SMIL clock
// and CSS entrance, and keeps the narration and the scene rules in step.
const PLAYER = `(() => {
  const root = document.querySelector(".motion");
  if (!root) return;
  const scenes = [...root.querySelectorAll(".scene")];
  const svgOf = (k) => scenes[k].querySelector("svg");
  if (root.classList.contains("storyboard")) {
    scenes.forEach((s, k) => { const svg = svgOf(k); if (svg) { svg.pauseAnimations(); svg.setCurrentTime(Number(s.dataset.seconds)); } });
    return;
  }
  const lines = [...root.querySelectorAll(".narration p")];
  const ticks = [...root.querySelectorAll(".ticks button")];
  const count = root.querySelector(".count");
  const toggle = root.querySelector(".play");
  let i = 0, playing = false, ended = false, startedAt = 0, done = 0, raf = 0, started = false;
  const len = (k) => Number(scenes[k].dataset.seconds) * 1000;

  function show(k) {
    i = k; done = 0; startedAt = performance.now(); ended = false;
    root.classList.remove("ended");
    scenes.forEach((s, j) => { s.classList.remove("on"); svgOf(j)?.pauseAnimations(); });
    void root.offsetWidth;
    scenes[k].classList.add("on");
    const svg = svgOf(k);
    if (svg) { svg.setCurrentTime(0); if (playing) svg.unpauseAnimations(); }
    lines.forEach((p, j) => p.classList.toggle("on", j === k));
    ticks.forEach((t, j) => { t.style.setProperty("--p", j < k ? "1" : "0"); t.setAttribute("aria-current", j === k ? "step" : "false"); });
    count.textContent = (k + 1) + " / " + scenes.length;
  }
  function frame(now) {
    if (!playing) return;
    const t = done + now - startedAt;
    ticks[i].style.setProperty("--p", String(Math.min(1, t / len(i))));
    if (t >= len(i)) {
      if (i + 1 < scenes.length) show(i + 1);
      else { pause(); ended = true; root.classList.add("ended"); toggle.setAttribute("aria-label", "Replay"); return; }
    }
    raf = requestAnimationFrame(frame);
  }
  function play() {
    started = true;
    if (ended) show(0);
    playing = true; startedAt = performance.now();
    svgOf(i)?.unpauseAnimations();
    root.classList.add("playing");
    toggle.setAttribute("aria-label", "Pause");
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    if (!playing) return;
    done += performance.now() - startedAt; playing = false;
    cancelAnimationFrame(raf);
    svgOf(i)?.pauseAnimations();
    root.classList.remove("playing");
    toggle.setAttribute("aria-label", "Play");
  }
  const flip = () => (playing ? pause() : play());
  toggle.addEventListener("click", flip);
  root.querySelector(".stage").addEventListener("click", flip);
  ticks.forEach((t, j) => t.addEventListener("click", () => { show(j); if (!playing) play(); }));
  root.addEventListener("keydown", (e) => {
    if (e.key === " ") { e.preventDefault(); flip(); }
    else if (e.key === "ArrowRight" && i + 1 < scenes.length) { show(i + 1); if (!playing) play(); }
    else if (e.key === "ArrowLeft" && i > 0) { show(i - 1); if (!playing) play(); }
  });
  show(0);
  // Start once the stage is in view, and rest while it is scrolled away.
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !started) setTimeout(play, 450);
    else if (!entry.isIntersecting) pause();
  }, { threshold: 0.5 }).observe(root.querySelector(".stage"));
})();`;
const PLAYER_HASH = `'sha256-${crypto.createHash("sha256").update(PLAYER).digest("base64")}'`;

const ICONS = `<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8 L13 8 L4.5 13.2 Z"/></svg><svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.8" width="3" height="10.4" rx="1"/><rect x="9.5" y="2.8" width="3" height="10.4" rx="1"/></svg><svg class="i-replay" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" fill="none" stroke-width="1.8" stroke-linecap="round"/><path d="M2.4 2.2 L5.6 4.9 L2 6.4 Z"/></svg>`;

// A motion sequence: 1-6 scenes, each its own drawing with its own SMIL timeline and a line of narration.
// With reduced motion it becomes a storyboard: every scene shown at its final frame, in order.
function renderMotion(motion, { plateNo, reducedMotion }) {
  const scenes = (Array.isArray(motion?.scenes) ? motion.scenes : [])
    .map((s, k) => ({
      svg: scopeIds(prepareFigure(sanitizeSvg(s?.svg), { reducedMotion: false }), `s${k + 1}-`),
      narration: String(s?.narration ?? ""),
      seconds: Math.min(12, Math.max(2.5, Number(s?.seconds) || 5)),
    }))
    .filter((s) => s.svg)
    .slice(0, 6);
  if (!scenes.length) return "";
  const label = `Plate ${plateNo} · in motion`;
  if (reducedMotion) {
    return `<section class="motion storyboard" aria-label="${escapeHtml(label)}">${scenes
      .map(
        (s, k) =>
          `<figure class="stage"><span class="plate-no">${escapeHtml(label)} · ${k + 1}/${scenes.length}</span><div class="scene on" data-seconds="${s.seconds}">${s.svg}</div><figcaption>${escapeHtml(s.narration)}</figcaption></figure>`,
      )
      .join("")}</section>`;
  }
  return `<section class="motion" tabindex="0" aria-label="${escapeHtml(label)}. Space plays or pauses; arrow keys step through scenes.">
<div class="stage"><span class="plate-no">${escapeHtml(label)}</span>${scenes
    .map((s) => `<div class="scene" data-seconds="${s.seconds}">${s.svg}</div>`)
    .join("")}</div>
<div class="narration">${scenes.map((s) => `<p>${escapeHtml(s.narration)}</p>`).join("")}</div>
<div class="reel"><button class="play" type="button" aria-label="Play">${ICONS}</button><div class="ticks">${scenes
    .map((s, k) => `<button type="button" aria-label="Scene ${k + 1}" style="flex-grow:${s.seconds}"></button>`)
    .join("")}</div><span class="count">1 / ${scenes.length}</span></div>
</section>`;
}

const list = (items, tag) =>
  Array.isArray(items) && items.length ? `<${tag}>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</${tag}>` : "";

export function renderExplainer(x, { plateNo, observedIn, date, reducedMotion = false }) {
  const figure = prepareFigure(sanitizeSvg(x.figure?.svg), { reducedMotion });
  const marks = (x.field_marks ?? []).slice(0, 6);
  const similar = (x.similar ?? []).slice(0, 3);
  const habitat = list(x.habitat, "ul");
  const behavior = list(x.behavior, "ol");
  const motion = renderMotion(x.motion, { plateNo, reducedMotion });

  const body = [
    `<header class="species"><h1 class="common">${escapeHtml(x.common_name)}</h1>`,
    x.taxonomy ? `<p class="taxon">${escapeHtml(x.taxonomy)}</p>` : "",
    x.summary ? `<p class="summary">${escapeHtml(x.summary)}</p>` : "",
    `</header>`,
    // When the model chose motion, the sequence leads and the still plate follows as the reference to keep.
    motion,
    figure
      ? `<figure class="plate"><span class="plate-no">Plate ${plateNo}</span>${figure}${x.figure?.caption ? `<figcaption>${escapeHtml(x.figure.caption)}</figcaption>` : ""}</figure>`
      : "",
    marks.length
      ? `<section class="section"><h2>Field marks</h2><ol class="marks">${marks
          .map((m, i) => `<li><svg width="34" height="17" viewBox="0 0 44 22" aria-hidden="true"><use href="#m${i + 1}"/></svg><div><b>${escapeHtml(m.label)}</b><span>${escapeHtml(m.detail)}</span></div></li>`)
          .join("")}</ol></section>`
      : "",
    habitat || behavior
      ? `<div class="section pair">${habitat ? `<section><h2>Where you'll meet it</h2>${habitat}</section>` : ""}${behavior ? `<section><h2>How it behaves</h2>${behavior}</section>` : ""}</div>`
      : "",
    similar.length
      ? `<section class="section"><h2>Easily confused with</h2><div class="similar">${similar
          .map((s) => `<div>${prepareFigure(sanitizeSvg(s.svg), { reducedMotion: true })}<b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.tell_apart)}</span></div>`)
          .join("")}</div></section>`
      : "",
    x.field_note
      ? `<aside class="note"><p>${escapeHtml(x.field_note)}</p><div class="signed">— seen ${observedIn ? `in ${escapeHtml(observedIn)}` : "on your screen"}, ${escapeHtml(date)}</div></aside>`
      : "",
    `<footer class="colophon"><i>A Field Guide to Your Screen</i><span>Plate ${plateNo}${x.field_note ? "" : ` · ${escapeHtml(date)}`}</span></footer>`,
  ].join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:${motion ? `; script-src ${PLAYER_HASH}` : ""}">
<title>${escapeHtml(x.common_name)}</title><style>${head()}</style></head>
<body>${CONTRACT}
${DEFS}
<div class="chrome">${BUDDY_MARK}<span>Buddy's field guide</span></div>
<main class="page">${body}</main>${motion ? `<script>${PLAYER}</script>` : ""}</body></html>`;
}
