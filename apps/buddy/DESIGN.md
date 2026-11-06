---
name: Desktop Buddy
description: A field guide to whatever is on your screen; every explainer is a plate.
colors:
  paper: "#f2f4f0"
  plate: "#e6eae3"
  ink: "#1a201c"
  ink-2: "#4c5650"
  ink-3: "#5a645e"
  rule: "#cfd5cd"
  buddy-blue: "#2f7aff"
  mark-disc: "#1f5fd6"
  mark-num: "#ffffff"
  moss: "#557a45"
  moss-wash: "#d7e3cf"
  ochre: "#b9861c"
  ochre-wash: "#f0e2bf"
  slate: "#4a6377"
  slate-wash: "#d3dde6"
  plum: "#8c4a78"
  plum-wash: "#ead6e4"
  rust: "#a24d2f"
  rust-wash: "#efd8cd"
  paper-dark: "#131815"
  plate-dark: "#1b221d"
  ink-dark: "#e5ebe6"
  ink-2-dark: "#aab5ad"
  ink-3-dark: "#8c968f"
  rule-dark: "#2c352f"
  buddy-blue-dark: "#6ea2ff"
  mark-disc-dark: "#6ea2ff"
  mark-num-dark: "#0b1a33"
  moss-dark: "#8fb57c"
  moss-wash-dark: "#2a3a24"
  ochre-dark: "#e0b354"
  ochre-wash-dark: "#3f3317"
  slate-dark: "#8ea9be"
  slate-wash-dark: "#22303b"
  plum-dark: "#cc8cba"
  plum-wash-dark: "#3b2535"
  rust-dark: "#df8a6a"
  rust-wash-dark: "#42271d"
typography:
  display:
    fontFamily: "Alegreya Sans, Segoe UI Variable Display, sans-serif"
    fontSize: "44px"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  display-compact:
    fontFamily: "Alegreya Sans, Segoe UI Variable Display, sans-serif"
    fontSize: "36px"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  taxonomy:
    fontFamily: "Alegreya Sans, Segoe UI Variable Display, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.3
  title:
    fontFamily: "Alegreya Sans, Segoe UI Variable Display, sans-serif"
    fontSize: "15px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.01em"
  mark-name:
    fontFamily: "Alegreya Sans, Segoe UI Variable Display, sans-serif"
    fontSize: "16px"
    fontWeight: 800
    lineHeight: 1.3
  summary:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-small:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  hand-label:
    fontFamily: "Patrick Hand, Segoe Print, cursive"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.3
  hand-note:
    fontFamily: "Patrick Hand, Segoe Print, cursive"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.35
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
  plate-number:
    fontFamily: "Alegreya Sans, Segoe UI Variable Display, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.04em"
    fontFeature: "tnum"
rounded:
  none: "0px"
  scrollbar: "5px"
spacing:
  gutter: "30px"
  section: "26px"
  stack: "12px"
  tight: "8px"
components:
  window-chrome:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    height: "40px"
    padding: "0 150px 0 22px"
  species-header:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.display}"
    padding: "10px 30px 22px"
  plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    padding: "26px 30px 16px"
  section-head:
    textColor: "{colors.ink}"
    typography: "{typography.title}"
  field-mark:
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
  field-note:
    textColor: "{colors.ink}"
    typography: "{typography.hand-note}"
  colophon:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    padding: "12px 0 24px"
---

# Design System: Desktop Buddy

## Overview

**Creative North Star: "The Field Guide to Your Screen"**

Every explainer Buddy opens is a plate in a Peterson- or Sibley-style field guide. The thing the user pointed at (a formula, a dialog, a domain term, an idea) is treated as a species: named large, placed in its family, drawn as an anatomical figure on a tinted plate, ringed with hand-lettered margin labels on leader lines, and tagged with numbered Peterson arrows that tie each part of the drawing to a numbered field mark below. The page then reads like the rest of a guide entry: where you'll meet it, how it behaves, what it is easily confused with, and a pencilled field note grounded in the user's own screen.

The world is paper and ink: pale sage paper, a slightly deeper sage plate, near-black green-tinted ink, hairline rules. Color lives in the figure only, as five naturalist pigments laid down like watercolor washes plus hatch and stipple for shading. The one accent outside the figure is Buddy blue, carried by the Peterson arrows, the window's mark, and the "here" ring around the exact spot the user pointed at. Density is that of a reference book: one column, generous paper, square edges, no containers. The page renders with JavaScript disabled, a strict CSP and embedded fonts, so everything is CSS plus inline SVG.

The renderer (`src/explainer.js`) owns every layout decision; the model writes structured fields and one SVG figure using a fixed class vocabulary. This split is part of the system: new subjects change content, never layout. The world explicitly refuses the stock AI card stack (rounded cards, stat tiles, tinted callout boxes).

**Key Characteristics:**
- One-column reference page, 30px side gutter, sections divided by hairline rules, never boxed.
- A full-bleed tinted plate carries the figure; it is a field, not a card.
- Three voices of type: Alegreya Sans for names, Patrick Hand for anything "drawn by hand", Segoe for reading text.
- Pigments only inside figures; Buddy blue only for arrows, the identity mark, and the pointed-at spot.
- Light and dark are full peers, both defined token for token through `prefers-color-scheme`.

## Colors

A muted naturalist palette: green-tinted neutrals for paper and ink, five earth pigments with soft washes for the figure, and a single saturated blue that belongs to Buddy.

### Primary
- **Buddy Blue** (`buddy-blue`; dark mode `buddy-blue-dark`): Buddy's identity mark, shared with the pointer overlay, island and bubble. On the plate it draws the Peterson arrow shafts and heads, the window-chrome pointer glyph, the `here` ring (stroke 2.2) around the exact spot the user pointed at, and the text selection background.
- **Arrow Disc Blue** (`mark-disc`; dark `mark-disc-dark`): the numbered disc at the tail of each Peterson arrow. In light mode it is a deeper blue than the shaft so the white numeral (`mark-num`) holds contrast; in dark mode disc and shaft are the same lifted blue and the numeral turns near-black navy (`mark-num-dark`).

### Secondary (figure pigments)
Five pigments, each with a full tone for "the part that matters" and a soft wash for areas. Available to the model as fill classes `p1`..`p5` and `p1s`..`p5s`.
- **Moss** (`moss`, `moss-wash`): p1. In the reference plate, the table range and its body.
- **Ochre** (`ochre`, `ochre-wash`): p2. The returned column.
- **Slate** (`slate`, `slate-wash`): p3. The lookup value; header rows in look-alike sketches.
- **Plum** (`plum`, `plum-wash`): p4. The match-mode argument.
- **Rust** (`rust`, `rust-wash`): p5. Reserved fifth pigment.

Dark mode swaps every pigment for a lighter full tone and a deep, low-chroma wash (the `-dark` keys).

### Neutral
- **Sage Paper** (`paper`): the page and window chrome background; also the scrollbar track.
- **Plate Sage** (`plate`): the full-bleed figure field. Exposed to the model as `plate-fill` for knocking shapes back to the plate tone.
- **Field Ink** (`ink`): headings, names, figure outlines, flow arrows, field-note text.
- **Second Ink** (`ink-2`): reading text in lists, mark details, taxonomy line, captions, leader lines, `label-2` and `small` figure text.
- **Pencil Grey** (`ink-3`): the quietest text (chrome running head, plate number, colophon), dashed `outline-soft`, list bullets, hatch and stipple strokes, scrollbar thumb on hover.
- **Hairline** (`rule`): section rules, the colophon rule, the scrollbar thumb.

### Named Rules
**The Pigments-Stay-in-the-Figure Rule.** The five pigments and their washes appear only inside SVG figures (the plate and the look-alike sketches). Page text, rules and backgrounds use only paper, plate, ink and rule tones.

**The One Blue Rule.** Buddy blue marks Buddy and the pointed-at spot, nothing else: Peterson arrows, the chrome glyph, the `here` ring, selection. The model may use `here` once per figure, only on the exact thing the user pointed at.

**The Wash, Not Tint Rule.** Areas get a soft wash, the part that matters gets the full pigment, and depth, hidden parts or the "don't" side of a contrast get hatch or stipple. Plain flat tints alone are not a figure.

## Typography

**Display Font:** Alegreya Sans (500, 500 italic, 800), fallback Segoe UI Variable Display
**Body Font:** Segoe UI Variable Text, fallback Segoe UI, system-ui
**Hand Font:** Patrick Hand (400), fallback Segoe Print

**Character:** Alegreya Sans is the field guide's species face: humanist, slightly calligraphic, heavy at 800 for names and light italic for taxonomy. Patrick Hand is the illustrator's lettering on the plate and the observer's pencil in the field note. Segoe carries the reading text so long passages feel native to Windows. Both web faces are embedded as base64 WOFF2 (SIL OFL 1.1, see `src/ui/fonts/LICENSES.txt`) because the page has no network.

### Hierarchy
- **Display** (Alegreya Sans 800, 44px, line-height 0.98, -0.02em, balanced wrap; 36px below 540px wide): the species (common) name. One per page.
- **Taxonomy** (Alegreya Sans 500 italic, 17px, 1.3): family and habitat line under the name, in `ink-2`.
- **Summary** (Segoe, 17px, 1.5, max 34em): the one-sentence identification under the taxonomy.
- **Title** (Alegreya Sans 800, 15px, 1.2, +0.01em): section heads, sitting on a hairline.
- **Mark name** (Alegreya Sans 800, 16px, 1.3): field-mark labels; look-alike names use the same face at 17px.
- **Body** (Segoe, 15px, 1.55): list items and mark details in `ink-2`; look-alike descriptions at 14px.
- **Hand label** (Patrick Hand, 17px): figure leader labels (`label`) and the plate caption; `label-2` is 15px in `ink-2`.
- **Hand note** (Patrick Hand, 19px, 1.35): the field note; its signature line is 15px, right-aligned, `ink-2`.
- **Label** (Segoe, 12.5px): window running head and colophon, in `ink-3`. Figure `small` text is 12px.
- **Plate number** (Alegreya Sans 500, 13px, +0.04em, tabular figures): "Plate N" at the plate's top right.

### Named Rules
**The Three Hands Rule.** Names are set in Alegreya Sans, reading text in Segoe, and anything drawn or observed by hand (figure labels, captions, the field note) in Patrick Hand. A role never borrows another voice.

**The Tabular Numbers Rule.** Numbers that count or compare (plate number, figure `num` text, ordered behavior steps) use tabular figures.

## Layout

A single scrolling column in a ~640x760 DIP desktop window. A sticky 40px chrome strip doubles as the drag region and carries a running head ("Buddy's field guide") like a book's header line; its right padding (150px) clears the native caption buttons, and a 16px paper-to-transparent fade under it replaces a rule because the native buttons paint over anything inside the strip.

Everything below sits on a 30px side gutter. Order is fixed by the renderer: species header, full-bleed plate, Field marks, a two-column pair (Where you'll meet it / How it behaves; single column under 540px), Easily confused with (auto-fit grid, min 150px, up to three), field note, colophon. Sections open with 26px top padding; lists stack at 8-12px; the colophon sits 34px below the content.

The figure is authored on a 600x340 viewBox (taller only if needed) with a 24px safe margin; look-alike sketches are 160x90 with their caption near y 82. The specimen floats centrally and a ring of margin labels points into it; subjects with states get two small views side by side.

### Named Rules
**The Renderer Owns Layout Rule.** The model supplies fields and SVG; it never supplies page structure, spacing, or wrappers. Field marks cap at 6, look-alikes at 3.

## Elevation & Depth

Completely flat. There are no shadows anywhere on the explainer. Depth is tonal: paper versus the slightly deeper plate field, and inside figures, hatch and stipple patterns (`ink-3` strokes) for shading, hidden parts and contrast. The only gradient is the functional chrome fade.

### Named Rules
**The Paper Has No Shadows Rule.** Separation comes from tone change (paper to plate) or a 1px hairline, never from elevation.

## Shapes

Square. The plate runs edge to edge with no radius and no frame; sections are divided by 1px top rules (`rule` for section heads and colophon, full `ink` for each look-alike column, like a guide's specimen rule). Round forms are reserved for marks: the 9.5px-radius Peterson arrow disc, 6px list bullets, the leader-line dot marker. Figure strokes use round joins and caps (`outline` 1.6, `leader` 1, `outline-soft` 1.2 dashed 3/3, `flow` 1.6 with an ink arrowhead).

## Components

### Peterson Arrow (signature)
A numbered blue disc with a short arrow, defined once as SVG symbols `m1`..`m6` in four directions (right, `l` left, `u` up, `d` down; 44x22 or 22x44). The number always stays upright. Placed in the figure beside the part it names; reused at 34x17 as the marker for the matching field mark, so arrow n on the plate and mark n in the list are visibly the same object. Colors are presentation attributes (Chromium does not style `<use>` clones from document classes).

### Species Header
Display name, italic taxonomy, one-sentence summary; no eyebrow, no badge.

### Plate
Full-bleed `plate` field holding the model's SVG, "Plate N" at top right, Patrick Hand caption below in `ink-2`.

### Section Head
Small Alegreya Sans 800 head sitting on a hairline (10px above the text). The only heading device below the species name.

### Field Marks
A two-column grid row: 34px arrow marker, then mark name (block) and detail in `ink-2`.

### Habitat and Behavior Lists
Habitat is a bulleted list with 6px `ink-3` dots; behavior is numbered with Alegreya Sans 800 tabular counters in `ink`.

### Look-alike (Similar Species)
Up to three columns, each topped by a 1px `ink` rule, holding an optional 160x90 sketch, the name, and the tell-apart sentence. Either every look-alike gets a sketch or none does.

### Field Note
Unboxed Patrick Hand paragraph in `ink`, signed "— seen in {app}, {date}" right-aligned beneath.

### Colophon
Hairline-topped footer: italic "A Field Guide to Your Screen" left, "Plate N" right, both `ink-3`.

### Other Buddy surfaces (not yet aligned)
The island pill (`src/ui/island.html`), speech bubble (`src/ui/bubble.html`) and pointer overlay (`src/ui/overlay.html`) predate this world and were not redesigned. They use their own local styles (dark pill, translucent bubble, system fonts, rounded corners and shadows). Their only shared commitment with the explainer is Buddy blue (#2f7aff) as the pointer and identity mark. This document does not define tokens for them; treat the field-guide world as the system of record when they are brought into line.

## Do's and Don'ts

### Do:
- **Do** use the model-facing class vocabulary for every figure color and stroke (`ink`, `p1`..`p5`, `p1s`..`p5s`, `hatch`, `stipple`, `outline`, `outline-soft`, `leader`, `flow`, `here`, `label`, `label-2`, `name`, `small`, `num`) so light and dark both work.
- **Do** tie every numbered arrow on the figure to the field mark with the same number.
- **Do** keep figure content 24px inside the viewBox and leave generous empty plate around the specimen.
- **Do** ground figures and the field note in the user's real labels and numbers.
- **Do** define every new color in both the light and dark token sets.

### Don't:
- **Don't** put the figure, a section, or a list inside a rounded card, stat tile or tinted callout box; the plate is a full-bleed field and sections are divided by hairlines.
- **Don't** draw a frame around the figure.
- **Don't** use a pigment outside an SVG figure, or Buddy blue for anything but arrows, the identity mark, selection, and the single `here` spot.
- **Don't** hard-code colors in model SVG; use the classes.
- **Don't** add shadows to the explainer.
- **Don't** load fonts, images or scripts from the network; embed fonts as data URIs and draw everything else in inline SVG.

## Motion

The plate is drawn in front of the reader once, then holds still; body text outside the plate never waits.
All of it lives in `src/ui/explainer.css` under `prefers-reduced-motion: no-preference`.

- **Entrance (automatic, every plate).** Ink lines (`outline`, `flow`) draw on over 900ms; washes and pigments
  settle at 350ms; leaders draw and labels fade at 700-800ms; the `here` ring at 1.1s; Peterson arrows pop
  (520ms, `cubic-bezier(0.16, 1, 0.3, 1)`, from 0.55 scale) in number order from 1.3s, 140ms apart, each together
  with its twin marker in the field-marks list. The renderer injects `pathLength="1"` on ink lines so one dash rule
  draws any length; `outline-soft` keeps its pixel dash pattern and is not drawn on. Lines with markers fade in as
  they draw, because markers can't be dashed.
- **Motion as content (model-authored, only when movement is the idea).** One moving idea per plate, starting at
  2.2s or later: a traveling `token` (ochre disc on SMIL `animateMotion`, hidden until it starts), `grow` /
  `grow-x` for quantities, `swap-a` / `swap-b` for two states crossfading on a 7s cycle, or slow SMIL with a rest in
  each loop. Text and labels never move.
- **Reduced motion.** CSS animation is off under `prefers-reduced-motion: reduce`, and the renderer strips every SMIL
  element when Windows reports reduced motion (SMIL ignores the media query). `swap-b` stays hidden, so a still
  plate shows state A. Every plate must read correctly as a still.
- **Motion sequence (model-authored, optional).** When an idea unfolds over time (a process, flow,
  transformation, cause and effect), the model adds `motion.scenes`: 2-6 scenes of 3-8s, each a full 600x340 SVG
  with its own SMIL clock and one line of narration. The sequence leads the plate ("Plate N · in motion") on the same
  tinted stage, and the still figure follows as the reference to keep. Scenes crossfade (450ms) as one continuous shot;
  each draws itself in faster than a plate (ink 650ms, washes 200-500ms, arrows at 600ms) and lands on a held final
  frame. Easing is `keySplines 0.2 0.8 0.2 1` throughout, the same curve as the island. Narration is pencilled in
  Patrick Hand under the stage; progress is one thin rule per scene (width proportional to its length) that fills
  with ink, beside a round ink play/pause/replay button. Scenes clip to the stage so camera moves (animated
  `viewBox`) never spill onto the page. Reference: `scripts/samples/vlookup-motion.json`
  (built by `scripts/make-motion-sample.cjs`).
- **The player is the only script.** Plates with a sequence carry one renderer-owned script, admitted by its SHA-256
  hash in the page CSP; the model writes no script, and the sanitizer strips handlers and href animations.
  Under reduced motion the sequence becomes a storyboard: every scene shown in order, frozen at its final frame.
- **Don't** use bounce or elastic easing, animate text, or run more than one loop on a plate.
