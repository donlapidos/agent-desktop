import assert from "node:assert/strict";
import { test } from "node:test";
import { renderExplainer, sanitizeSvg } from "../src/explainer.js";

test("model SVG can draw but not run, load or navigate", () => {
  const cases = [
    ['<svg><script>alert(1)</script><rect/></svg>', /script|alert/i],
    ['<svg><rect onload="alert(1)" onclick=steal() /></svg>', /onload|onclick|steal/i],
    ['<svg><foreignObject><iframe src="https://x"></iframe></foreignObject></svg>', /foreignObject|iframe|https/i],
    ['<svg><image href="https://tracker.example/p.png"/></svg>', /image|tracker/i],
    ['<svg><use href="https://evil.example/s.svg#a"/></svg>', /evil/],
    ['<svg><a href="javascript:alert(1)"><text>hi</text></a></svg>', /javascript|<a\b/i],
    ['<svg><set attributeName="href" to="javascript:alert(1)"/></svg>', /javascript/],
    ['<svg><style>@import url(https://x)</style></svg>', /@import|<style/i],
  ];
  for (const [input, forbidden] of cases) assert.doesNotMatch(sanitizeSvg(input), forbidden, input);
});

test("references inside the plate and plain drawing survive", () => {
  const svg = '<svg viewBox="0 0 600 340"><path class="outline" d="M0 0 L10 10"/><use href="#m1" x="1" y="2" width="44" height="22"/></svg>';
  const out = sanitizeSvg(svg);
  assert.match(out, /href="#m1"/);
  assert.match(out, /<path class="outline"/);
});

test("anything that isn't an svg is dropped", () => {
  assert.equal(sanitizeSvg("<div>hi</div>"), "");
  assert.equal(sanitizeSvg(undefined), "");
});

const plate = (extra = {}) => ({
  common_name: '<img src=x onerror="alert(1)">VLOOKUP',
  taxonomy: "Lookup function & friends",
  summary: "Finds a value <b>down</b> a column.",
  figure: { svg: '<svg viewBox="0 0 600 340"><rect class="outline" width="10" height="10"/></svg>', caption: "</figcaption><script>x()</script>" },
  field_marks: [{ label: "Lookup value", detail: "What to find." }],
  field_note: "Seen in <Sheet1>.",
  ...extra,
});
const render = (x) => renderExplainer(x, { plateNo: 3, observedIn: "EXCEL", date: "9 Nov 2026" });

test("every text field the model writes is escaped", () => {
  const html = render(plate());
  assert.doesNotMatch(html, /<img|onerror="|<b>down|<script>x\(\)|<Sheet1>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;VLOOKUP/);
});

test("a still plate runs no script at all", () => {
  const html = render(plate());
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /script-src/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("a plate with motion admits exactly one script, by hash", () => {
  const html = render(plate({ motion: { scenes: [{ svg: '<svg viewBox="0 0 600 340"><circle r="4"/></svg>', narration: "Watch it move.", seconds: 4 }] } }));
  assert.match(html, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.equal(html.match(/<script\b/gi)?.length, 1);
});

test("pieces left by one removal can't join into a script, a handler or a link", async () => {
  const { sanitizeSvg } = await import("../src/explainer.js");
  // Removing the inner tag leaves "<script>": only another pass catches it.
  const script = sanitizeSvg('<svg><scr<script>ipt>alert(1)<circle r="3"/></svg>');
  assert.doesNotMatch(script, /<script\b/i);
  const handler = sanitizeSvg('<svg><circle o<script>nclick="alert(1)" r="3"/></svg>');
  assert.doesNotMatch(handler, /\son\w+\s*=/i, "no handler joined back together");
  assert.match(handler, /<circle/, "the drawing itself stays");
  const link = sanitizeSvg('<svg><a hr<a></a>ef="https://evil.example">x</a><rect width="4" height="4"/></svg>');
  assert.doesNotMatch(link, /<a\b/i);
  assert.doesNotMatch(link, /href\s*=/i);
  assert.match(link, /<rect/);
});

test("cleaning leaves motion and links inside the drawing alone", async () => {
  const { sanitizeSvg } = await import("../src/explainer.js");
  const svg = '<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0 L5 5"/></defs><circle r="2"><animate attributeName="cx" from="0" to="8" dur="2s" repeatCount="indefinite"/></circle><use href="#p"/><animateMotion dur="3s"><mpath href="#p"/></animateMotion></svg>';
  assert.equal(sanitizeSvg(svg), svg, "animate, animateMotion and #links are part of the drawing");
});

test("whatever the removals miss, a final check refuses the whole drawing", async () => {
  const { sanitizeSvg } = await import("../src/explainer.js");
  // The removals look for "<script"; this spacing slips past them, so only the final check stops it.
  assert.equal(sanitizeSvg("<svg>< script>alert(1)</svg>"), "");
  assert.equal(sanitizeSvg('<svg><circle r="2"/></svg>'), '<svg><circle r="2"/></svg>');
});
