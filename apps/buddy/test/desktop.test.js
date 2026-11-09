import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReading, renderTree } from "../src/desktop.js";

const at = (x, y, width = 100, height = 20) => ({ x, y, width, height });

test("renderTree lists refs for the model and keeps their positions and names out of its text", () => {
  const tree = {
    role: "window",
    name: "Report.xlsx",
    children: [
      { ref_id: "@s1:e1", role: "button", name: "Save", bounds: at(10, 10), states: ["focused", "visible"] },
      { ref_id: "@s1:e2", role: "textfield", bounds: at(10, 40), value: "Q3" },
    ],
  };
  const bounds = new Map();
  const labels = new Map();
  const { text } = renderTree(tree, bounds, undefined, labels);
  assert.equal(text, ['window "Report.xlsx"', '  @s1:e1 button "Save" [focused]', '  @s1:e2 textfield value="Q3"'].join("\n"));
  assert.deepEqual(bounds.get("@s1:e1"), at(10, 10));
  assert.equal(labels.get("@s1:e1"), '"Save" (button)');
  assert.equal(labels.get("@s1:e2"), "the textfield");
  assert.doesNotMatch(text, /"x"|width/, "bounds never reach the model");
});

test("renderTree clips huge trees and says how to drill in", () => {
  const children = Array.from({ length: 5000 }, (_, i) => ({ ref_id: `@s1:e${i}`, role: "listitem", name: `Item ${i}` }));
  const { text } = renderTree({ role: "list", children }, new Map(), 2000);
  assert.ok(text.length < 2200);
  assert.match(text, /output clipped; use `look` with root=<ref>/);
});

test("renderReading gives the page in reading order and marks what is on screen", () => {
  const tree = {
    role: "window",
    children: [
      { role: "toolbar", name: "Browser chrome", children: [{ role: "button", name: "Back" }] },
      {
        role: "document",
        name: "Pricing",
        bounds: at(0, 0, 1000, 800),
        children: [
          { role: "heading", name: "Plans", bounds: at(0, 0) },
          { role: "group", bounds: at(0, 30), children: [{ role: "statictext", name: "Pro has", bounds: at(0, 30) }, { role: "link", name: "SSO", bounds: at(60, 30) }] },
          { role: "list", bounds: at(0, 60), children: [{ role: "listitem", bounds: at(0, 60), children: [{ role: "statictext", name: "$24 a seat", bounds: at(0, 60) }] }] },
          { role: "row", bounds: at(0, 90), children: [{ role: "cell", name: "Pro" }, { role: "cell", name: "$24" }] },
          { role: "statictext", name: "Terms apply.", bounds: at(0, 3000), states: ["offscreen"] },
        ],
      },
    ],
  };
  const { title, text } = renderReading(tree);
  assert.equal(title, "Pricing");
  assert.equal(text, ["▼ on screen now", "## Plans", "Pro has SSO", "- $24 a seat", "| Pro | $24 |", "▲ end of what's on screen", "Terms apply."].join("\n"));
  assert.doesNotMatch(text, /Back|Browser chrome/, "controls are left to look");
});

test("renderReading reads an editor's whole text, line by line", () => {
  const tree = { role: "document", bounds: at(0, 0, 800, 600), children: [{ role: "textfield", role_description: "document", bounds: at(0, 0, 800, 600), value: "Dear Sam,\r\nThanks for the report.\n" }] };
  assert.equal(renderReading(tree).text, ["▼ on screen now", "Dear Sam,", "Thanks for the report.", "▲ end of what's on screen"].join("\n"));
});

test("renderReading says how much didn't fit", () => {
  const children = Array.from({ length: 50 }, (_, i) => ({ role: "statictext", name: `Paragraph ${i} `.repeat(20), bounds: at(0, i * 30) }));
  const { text } = renderReading({ role: "document", bounds: at(0, 0, 800, 600), children }, 2000);
  assert.match(text, /the page continues for about \d+ more characters/);
});
