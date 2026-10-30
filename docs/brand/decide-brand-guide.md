# DECIDE — brand guide

## The mark: "Threshold D"

A geometric **D** whose stem is cut away from its bowl.

- **The stem is the action boundary.** It is the line an action must not cross until it is decided.
- **The gap is the decision.** Nothing passes through it automatically.
- **The point inside is the one exact action being held and evaluated.** It is coloured in the signal amber of the app's DEFER state.

In the film, the five disposition colours (EXECUTE, ASK, DEFER, ESCALATE, REFUSE) converge on the stem before the mark resolves: many paths, one disposition.

### Why this candidate

Three directions were drawn and compared at 24, 32 and 128 px on dark and light backgrounds (comparison sheet kept with the film sources, not in the repo).

| Candidate | Idea | Verdict |
|---|---|---|
| A — Convergence | Three paths converge on a vertical bar, then a dot beyond it | **Rejected.** It reads as a stock "skip to end" (▶︎❘) media icon |
| **B — Threshold D** | D with a detached stem (the boundary) and a held point | **Chosen.** Reads as D, carries the boundary idea, and stays distinct at 24 px |
| C — Striped D | Concentric D-paths joined at the stem, with an amber bar | **Rejected.** At 24 px the stripes and the bar merge, and it resembles generic striped logos |

## Files

| File | Use |
|---|---|
| `decide-symbol.svg` | App icon, favicon or avatar. A light mark on a `#15130f` rounded tile, so it works on any background |
| `decide-symbol-bare.svg` | The light mark with no tile, for dark surfaces |
| `decide-lockup-light.svg` | Symbol and wordmark, light ink, **for dark backgrounds** |
| `decide-lockup-dark.svg` | Symbol and wordmark, dark ink, **for light backgrounds** |
| `decide-monochrome.svg` | Single colour via `currentColor` (inherits the CSS `color`; black when standalone) |

All files are hand-built vector paths with a `viewBox`. They contain no raster images, fonts, `<text>` or external references. The wordmark is geometric strokes, so no font licence is involved.

## Geometry (64-unit grid)

- **Stem:** 7 × 48, at x = 10.5, y = 8.
- **Bowl:** a 7-unit stroke, starting 6 units right of the stem; radius 20.5, centred on y = 32.
- **Point:** r = 5.5, at (33, 32).
- **Wordmark:** cap height 40 and stroke 6.5 (the same weight ratio as the stem), placed at (84, 12) in the lockup.
- **Clear space:** at least the bowl's stroke width × 2 (14 units) on every side.
- **Minimum size:** symbol 16 px (tile version 24 px); lockup 24 px tall.

## Colour

| Token | Hex | Role |
|---|---|---|
| Ink (dark) | `#15130f` | App background; ink on light surfaces |
| Ink (light) | `#f1ebe0` | App text; ink on dark surfaces |
| Signal | `#f0a43a` | The held point, on dark backgrounds |
| Signal (on light) | `#b86e0b` | The held point, on light backgrounds |

The disposition colours (`#5cc68f` execute, `#7fa6ef` ask, `#f0a43a` defer, `#b591ec` escalate, `#f0776d` refuse) belong to the product UI, not the logo.

## Voice

- **Name:** DECIDE (always capitals in the wordmark).
- **Descriptor:** The Action Boundary.
- **Line:** "When to act. When not to."
  - The suggested "Know when to act. Know when not to." was softened on purpose. DECIDE does not *know*; its known failure is executing on fresh, agreeing, false evidence, and the brand line must not claim otherwise.

## Don'ts

- Don't close the gap between the stem and the bowl. The gap is the meaning.
- Don't add brains, shields, locks, circuits, gradients or bevels.
- Don't recolour the point in a disposition colour, which would imply a decision outcome.
- Don't set the wordmark in a font. Use the outlined artwork.
