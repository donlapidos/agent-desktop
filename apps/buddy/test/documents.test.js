import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeDocx } from "../src/documents.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "buddy-docs-"));

test("a document never overwrites another with the same title", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await writeDocx({ title: "Status", markdown: "# Status\n\nOne.", dir });
  const firstBytes = fs.readFileSync(first);
  const second = await writeDocx({ title: "Status", markdown: "# Status\n\nTwo.", dir });
  const third = await writeDocx({ title: "Status", markdown: "# Status\n\nThree.", dir });
  assert.deepEqual([first, second, third].map((f) => path.basename(f)), ["Status.docx", "Status (2).docx", "Status (3).docx"]);
  assert.deepEqual(fs.readFileSync(first), firstBytes, "the first file is untouched");
});

test("titles can't escape the folder or use characters Windows forbids", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = await writeDocx({ title: '..\\..\\Q3: "final"/report?*', markdown: "# Q3", dir });
  assert.equal(path.dirname(file), dir);
  assert.equal(path.basename(file), "....Q3 finalreport.docx");
});

test("the result is a real Word file", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = await writeDocx({ title: "Plan", markdown: "# Plan\n\n## Goals\n- one\n  - nested\n1. first\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n**bold** and *italic*", dir });
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 2).toString(), "PK", "a .docx is a zip");
  assert.ok(bytes.includes(Buffer.from("word/document.xml")));
});
