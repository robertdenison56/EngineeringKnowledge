# ADR 0009: Own-code vector rasterizer — removing the poppler dependency

Date: 2026-06-17 · Status: Accepted

## Context

A pipeline review for external-system reliance found exactly one hard
external dependency: **poppler/`pdftoppm`**, an OS binary the gateway shelled
out to (`raster.ts`, ADR 0005) to rasterize drawing sheets to PNG for the
vision describe flow. Everything else is in-process — pdf.js (pure-JS,
Apache-2.0), node:sqlite (built-in), the embedding providers (optional, with a
local Ollama option), and the vision model itself (BYO by design). Poppler
required a system install (`brew install poppler`), and a missing binary
silently disabled description.

We already decode the page's geometry and positioned text via pdf.js for
parsing. The same primitives can drive a renderer, so the rasterization step
can be our own code with no new external system.

## Decisions

- **Render the page ourselves from pdf.js primitives** (`raster/`). `render.ts`
  walks the operator list (CTM-tracked path geometry — lines, Béziers, fills)
  and the positioned-text stream, drawing onto a tiny software canvas
  (`canvas.ts`) that supersamples and box-downsamples for anti-aliasing, then
  encodes PNG via `node:zlib` (`png.ts`). An embedded public-domain 8×8 font
  (`font.ts`) draws text — no font files. **No external binary, no native
  module**; the only library is pdf.js, which we already ship.
- **Tuned for engineering drawings, not generic fidelity.** Because we parsed
  the sheet we can render it *for the vision reader*: a contrast hierarchy
  (mid-gray linework, pure-black annotation text) so dense geometry never
  drowns the text; a white halo behind each text fragment so annotations lift
  off the linework; a minimum stroke width so hairlines survive; resolution
  independence (any DPI from one vector source); and — the key property —
  text drawn fragment-by-fragment at true coordinates, which **visually
  reassembles strings** (rotated stacked-fraction span dimensions like
  `118'-4⅛"`) that our string-assembly drops. The page is parsed once;
  overview + quadrant tiles re-rasterize the same model.
- **The gateway prefers our renderer; poppler is an optional fallback.**
  `rasterizeSheetForVision` renders with our own code when the page has vector
  content (born-digital sheets — the entire target corpus), and falls back to
  poppler ONLY for image-only/scanned pages our vector renderer cannot draw,
  and only if poppler happens to be installed. The gateway **no longer
  requires** an external binary.

## Consequences

- The gateway is self-contained: `npm install` and it rasterizes sheets, with
  no `brew install` and no silent capability loss. For the born-digital AEC
  corpus this is the whole pipeline with zero external systems.
- Validated with the same eval method as the rest of the vision work: a vision
  model (Sonnet) read our render of Caltrans 03-3H3904 sheet 26 and correctly
  described it — all four views, the structure, scales, bent labels, and
  dimensions including the rotated stacked-fraction spans our parser misses.
  **Honest limit:** on the densest small-text regions poppler is still
  marginally more faithful (real glyph outlines vs our 8×8 font; some stacked
  fractions render as `1/8`-style inline). That is why poppler remains an
  opt-in fallback — but it is no longer a requirement, and the deterministic
  fusion facts (ADR 0007/0008) carry the authoritative dimension values
  regardless of render fidelity.
- New capabilities this unlocks (the renderer understands the content, which
  poppler cannot): semantic-region tiling (crop tiles around detected
  views/title-block/schedules instead of blind quadrants) and color-coded
  semantic emphasis (dimensions/callouts highlighted) — implemented as far as
  the contrast hierarchy + halos; region tiling and color overlays are the
  natural next step.
- pdf.js stays (in-process, Apache-2.0) — replacing it would reimplement PDF
  parsing at lower accuracy and is not where external-system risk lived.
