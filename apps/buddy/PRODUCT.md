# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Today: the builder, on a Windows work PC. Intended: a public product people install. Users are knowledge workers
mid-task in any desktop app who hit something they don't understand (a software feature, a domain concept in their
own files, or anything they are reading or learning) and want it explained in place, without leaving the app.

## Product Purpose
Desktop Buddy is a desktop assistant that sees the screen through the OS accessibility tree. It guides by pointing
(a pointer flies to the control and labels it), acts on request with per-action approval, and explains: the user
points at anything (hover + Ctrl+Alt+E, or the island's Explain pick mode) and Buddy opens a one-page visual
explainer beside it. Success for an explainer: a reference card worth keeping or sharing, not a disposable answer.

## Positioning
Explanations are grounded in exactly what the user pointed at: a crop of their screen plus the accessibility
element under the pointer, so the explainer can use the user's own data and labels as its worked example. A generic
chatbot answer cannot do that.

## Operating Context
- Explainers open in a separate desktop window (~640x760 DIP) beside the pointed spot, over whatever app the user is
  in, in light or dark OS theme.
- Content is written by Claude at request time as structured fields (name, taxonomy, summary, field marks, habitat,
  behavior, look-alikes, field note) plus one SVG figure drawn with a fixed class vocabulary; the renderer
  (src/explainer.js) owns every layout decision. The model must be able to fill it reliably for any subject.
- Saved to %APPDATA%/desktop-buddy/explainers/ as standalone HTML.
- Other Buddy surfaces: the island (status pill, top center), the speech bubble, the pointer overlay.

## Capabilities and Constraints
- Rendering: Electron (Chromium), JavaScript disabled, CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:`,
  network blocked. No web fonts unless embedded as data URIs; no scripts; no external images.
- Visuals must be CSS + inline SVG authored by the model in a single pass.
- Brand: "Buddy", blue pointer (#2f7aff) across the overlay and island.

## Brand Commitments
- Name "Buddy" / "Desktop Buddy". The blue pointer is Buddy's identity mark on screen.

## Evidence on Hand
- No real user explainers yet; test samples only. Do not fabricate usage metrics or testimonials.

## Product Principles
1. Grounded in what the user pointed at: their screen, their labels, their numbers.
2. Teach the idea, not just name the control.
3. Worth keeping: an explainer should read as a finished artifact, not chat output.
4. Safe by construction: model-written pages can display, never execute.
