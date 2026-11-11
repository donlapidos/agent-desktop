import assert from "node:assert/strict";
import { test } from "node:test";
import { controlShape, controlValues, findControl, furthestStep, nearestNames, valuesChanged, renderReading, renderTree, SHAPE_CHANGE, shapeDistance } from "../src/desktop.js";

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

const ribbon = (...tabs) => ({ role: "window", children: tabs.map((name, i) => ({ ref_id: `@s1:e${i}`, role: "tab", name })) });

test("furthestStep catches a user who worked ahead at the furthest step they reached", () => {
  const needles = ["create table", "table design", "table style"];
  const tree = { role: "window", children: [{ role: "tab", name: "Table Design" }] };
  assert.equal(furthestStep(needles, new Set(), tree), 1);
  assert.equal(furthestStep(needles, new Set(), null, "Create Table"), 0, "a dialog's title counts");
  assert.equal(furthestStep(needles, new Set(["table design"]), tree), -1, "text that was already on screen never counts");
});

test("shapeDistance sees controls come and go but not typing or selection", () => {
  const before = controlShape(ribbon("Home", "Insert", "Data"));
  const typed = controlShape({ ...ribbon("Home", "Insert", "Data"), value: "Q3 total" });
  assert.equal(shapeDistance(before, typed), 0);
  const paneOpened = controlShape(ribbon("Home", "Insert", "Data", "Table Design", "Style 1", "Style 2", "Banded Rows", "Total Row", "Header Row"));
  assert.ok(shapeDistance(before, paneOpened) >= SHAPE_CHANGE);
});

const control = (ref, role, name, extra = {}) => ({ ref_id: ref, role, name, bounds: at(0, 0), ...extra });

test("findControl finds the control a guide step names, as the user reads it", () => {
  const tree = { role: "window", children: [control("@s1:e1", "tab", "Data"), control("@s1:e2", "button", "Sort A to Z"), control("@s1:e3", "button", "Sor&t…")] };
  assert.equal(findControl(tree, "data")?.node.ref_id, "@s1:e1", "case doesn't matter");
  assert.equal(findControl(tree, "Sort")?.node.ref_id, "@s1:e3", "the same name beats one that only starts with it");
  assert.equal(findControl(tree, "A to Z")?.node.ref_id, "@s1:e2");
  assert.equal(findControl(tree, "Pivot"), null);
});

test("findControl won't guess between equally likely controls, and a role tells them apart", () => {
  const tree = { role: "window", children: [control("@s1:e1", "tab", "Insert"), control("@s1:e2", "menuitem", "Insert")] };
  assert.deepEqual(findControl(tree, "Insert")?.candidates?.map((n) => n.ref_id), ["@s1:e1", "@s1:e2"]);
  assert.equal(findControl(tree, "Insert", "tab")?.node.ref_id, "@s1:e1");
});

test("findControl ignores controls scrolled out of view", () => {
  const tree = { role: "window", children: [control("@s1:e1", "button", "Save", { states: ["offscreen"] }), control("@s1:e2", "button", "Save as")] };
  assert.equal(findControl(tree, "Save")?.node.ref_id, "@s1:e2");
});

test("valuesChanged sees a new selection or typed text, and not controls coming or going", () => {
  const sheet = (cell) => ({ role: "window", children: [{ ref_id: "@s1:e1", role: "combobox", name: "Name Box", value: cell }, { ref_id: "@s1:e2", role: "tab", name: "Data" }] });
  const before = controlValues(sheet("A1"));
  assert.equal(valuesChanged(before, controlValues(sheet("A1"))), false);
  assert.equal(valuesChanged(before, controlValues(sheet("E2"))), true, "clicking E2 moves the Name Box");
  assert.equal(valuesChanged(before, controlValues({ role: "window", children: [] })), false, "a control that went away is the shape's business");
});

test("findControl matches near misses by meaning, and doesn't guess between equals or stretch too far", () => {
  let n = 0;
  const ui = (...names) => ({ role: "window", children: names.map((name) => ({ role: "button", name, ref_id: `@s1:e${++n}`, bounds: { x: n * 10, y: 0, width: 9, height: 9 } })) });
  const excel = ui("Sort A to Z", "Sort Z to A", "Filter", "Clear");
  assert.equal(findControl(excel, "Sort Largest to Smallest")?.node?.name, "Sort Z to A");
  assert.equal(findControl(excel, "Sort Largest to Smallest")?.near, true, "marked as a near match in the log");
  assert.equal(findControl(excel, "Sort ascending")?.node?.name, "Sort A to Z");
  assert.equal(findControl(ui("File", "Options", "Help"), "Settings")?.node?.name, "Options");
  assert.equal(findControl(ui("Delete sheet", "Insert sheet"), "Remove sheet")?.node?.name, "Delete sheet");
  assert.equal(findControl(ui("Delete row", "Delete column"), "Remove")?.candidates?.length, 2, "equally close: Buddy asks the model rather than guess");
  assert.equal(findControl(ui("View", "Zoom", "Status bar"), "Word wrap"), null, "nothing close: no stretch");
  assert.equal(findControl(ui("Export", "Save As"), "Export to PDF"), null, "half a match isn't enough");
  assert.equal(findControl(ui("Sort", "Sort by colour"), "sorts")?.node?.name, "Sort", "the shorter label wins when both cover it");
  assert.deepEqual(nearestNames(ui("Word count", "Wrap text", "Zoom"), "Word wrap"), ["Word count", "Wrap text"]);
});
