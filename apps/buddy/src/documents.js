// Real Word documents from the model's Markdown: headings, paragraphs, bullet and numbered lists, tables, bold and
// italic. Writing the file directly is faster and far more reliable than typing a report into Word keystroke by
// keystroke, and the user gets a normal .docx they can edit, save and share.
import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell,
  TableRow, TextRun, WidthType,
} from "docx";

const FONT = "Aptos";
const HEADINGS = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

// **bold**, *italic* and ***both*** inside a line.
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    if (m[2]) out.push(new TextRun({ text: m[2], bold: true, italics: true, ...base }));
    else if (m[3]) out.push(new TextRun({ text: m[3], bold: true, ...base }));
    else out.push(new TextRun({ text: m[4], italics: true, ...base }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text: "", ...base })];
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isDivider = (line) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "C9CED6" };

function table(lines) {
  const rows = lines.filter((l) => !isDivider(l)).map(cells);
  const width = Math.max(...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, insideHorizontal: BORDER, insideVertical: BORDER },
    rows: rows.map((r, i) =>
      new TableRow({
        tableHeader: i === 0,
        children: Array.from({ length: width }, (_, k) =>
          new TableCell({
            shading: i === 0 ? { type: ShadingType.CLEAR, fill: "EEF1F5", color: "auto" } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: runs(r[k] ?? "", i === 0 ? { bold: true } : {}) })],
          }),
        ),
      }),
    ),
  });
}

/** Markdown -> docx body elements. The first `# ` heading becomes the title. */
function body(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let titled = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const style = level === 1 && !titled ? HEADINGS[0] : HEADINGS[level];
      if (style === HeadingLevel.TITLE) titled = true;
      out.push(new Paragraph({ heading: style, children: runs(h[2]) }));
      continue;
    }
    if (line.trim().startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) block.push(lines[i++]);
      i--;
      out.push(table(block), new Paragraph({ children: [] }));
      continue;
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(new Paragraph({ numbering: { reference: "bullets", level: Math.min(2, Math.floor(bullet[1].length / 2)) }, children: runs(bullet[2]) }));
      continue;
    }
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(new Paragraph({ numbering: { reference: "numbers", level: Math.min(2, Math.floor(numbered[1].length / 2)) }, children: runs(numbered[2]) }));
      continue;
    }
    out.push(new Paragraph({ children: runs(line.trim()), spacing: { after: 120 } }));
  }
  return out;
}

const levels = (format, texts) =>
  texts.map((text, level) => ({
    level,
    format,
    text,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
  }));

const safeName = (s) => String(s || "Buddy report").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Buddy report";

/**
 * Writes `<dir>/<title>.docx` (adding " (2)", " (3)" rather than overwriting) and returns its path.
 * @param {{ title: string, markdown: string, dir: string }} doc
 */
export async function writeDocx({ title, markdown, dir }) {
  const doc = new Document({
    creator: "Desktop Buddy",
    title,
    styles: {
      default: { document: { run: { font: FONT, size: 22 }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { font: FONT, size: 48, bold: true, color: "16181D" }, paragraph: { spacing: { after: 240 } } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 32, bold: true, color: "1F3B66" }, paragraph: { spacing: { before: 320, after: 120 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 26, bold: true, color: "1F3B66" }, paragraph: { spacing: { before: 240, after: 100 } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 23, bold: true, color: "33415C" }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: levels(LevelFormat.BULLET, ["•", "◦", "▪"]) },
        { reference: "numbers", levels: levels(LevelFormat.DECIMAL, ["%1.", "%2.", "%3."]) },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } } }, children: body(markdown) }],
  });
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(title);
  let file = path.join(dir, `${base}.docx`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).docx`);
  fs.writeFileSync(file, await Packer.toBuffer(doc));
  return file;
}
