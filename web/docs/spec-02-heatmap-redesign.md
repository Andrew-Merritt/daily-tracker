# Spec 02 — Heatmap Redesign

Last updated: 2026-07-17
Status: ✅ done — Phases 1–2 333e945, Phase 3 0b59e98, Phase 4 6ad5c9a (later polish: 1c79a48)
Model: **Sonnet 5** (Phase 4 stat tiles may be split off to Haiku 4.5)
Depends on: spec-01 Phase A (tokens)

**Files:** `src/components/calendar-heatmap.tsx`, `src/app/heatmap/page.tsx`,
new `src/components/year-grid.tsx`

Current problems being fixed:
- Colors are hand-mixed `rgb()` math in JS — a harsh red→green ramp,
  identical in light and dark mode, unreadable on the dark surface.
- 7px day numbers inside every cell; 🏆 emoji for goal-met.
- Only a 12-month-card grid; no summary stats; no year-strip view.

Public API of `CalendarHeatmap` (props, `HeatmapDataPoint`) stays unchanged
so `/heatmap/page.tsx` callers keep working.

---

## Phase 1 — Color system (replaces `getColor` + `getHeatmapLegendColors`)

Delete all RGB math. New rule set:

1. **Numeric metrics (number/score/count/time/hhmm):** bucket the value into
   quintiles of the visible range → `var(--heat-1)` … `var(--heat-5)`.

   ```ts
   function heatBucket(value: number, min: number, max: number): 1|2|3|4|5 {
     const t = (value - min) / (max - min || 1);
     return (Math.min(4, Math.floor(t * 5)) + 1) as 1|2|3|4|5;
   }
   ```

   - `direction === "decrease"` (lower is better): invert the bucket
     (`6 - bucket`) so *better* days are always the deeper color.
   - `direction === "neutral"`: no inversion (pure magnitude).
2. **Checkbox metrics:** checked → `var(--heat-4)`; unchecked → transparent
   with the empty-cell treatment. Exception: `direction === "decrease"`
   ("avoid" habits, e.g. drank/smoked): checked → `var(--status-danger)`.
3. **No data:** `var(--heat-empty)` at 35% opacity.
4. Discrete buckets, not a continuous gradient — 5 steps read better at cell
   size and match the legend exactly.

Legend: 5 swatches in a row, labeled `less` / `more` at the ends (or
`worse`/`better` when direction is non-neutral). Swatches are 10px rounded
squares using the same vars. Update `getHeatmapLegendColors` to return
`["var(--heat-1)", … , "var(--heat-5)"]` (with the same inversion rule) and
adjust its call sites in `heatmap/page.tsx`.

## Phase 2 — Cell rendering

- **Remove the day-number text** from cells. Date + value move entirely to
  hover (the `onHover` callback already exists and the page renders details).
  Add a `title` attribute as a native-tooltip fallback:
  `"{Mon D} — {formatted value}"`.
- Cell: `rounded-[3px]`, grid `gap-[2px]` (was `gap-px`), remove the
  `text-[7px]` and `color:` styles.
- Hover: keep pointer cursor; replace `hover:scale-125` with an inset ring
  `hover:ring-1 hover:ring-foreground/40` (scale-jitter reads as noise at
  350+ cells).
- Selected date: keep ring treatment (`ring-2 ring-foreground`), drop
  `scale-150`.
- **Goal met:** delete the 🏆 span. Instead: `box-shadow: inset 0 0 0 1.5px
  var(--status-good)`. Native title gains `" · Goal met"` suffix so the
  signal is not color-alone.

## Phase 3 — Year-strip view (new component `year-grid.tsx`)

GitHub-contributions layout as an alternative view; the heatmap page gets a
two-option toggle `Months | Year` (persist choice in
`localStorage["heatmap:view"]`).

- Props: identical to `CalendarHeatmap` (reuse the same color/tooltip logic —
  export `heatBucket` and the cell color helper from `calendar-heatmap.tsx`).
- Layout: CSS grid, 7 rows (Sun–Sat) × up to 53 week-columns for the selected
  year, filled column-by-column. Cell size 11–13px, `gap-[2px]`,
  `rounded-[2px]`.
- Month labels across the top: label a column when the month changes at that
  column, `text-[10px] text-muted-foreground`.
- Weekday labels left: `M`, `W`, `F` only (rows 1/3/5), same text style.
- Horizontal scroll allowed on mobile inside its own container
  (`overflow-x-auto`); never lets the page body scroll horizontally.
- Load animation: each week-column gets `animation: fadeIn .3s ease both`
  with `animation-delay: calc(var(--col) * 6ms)`. Wrap in
  `@media (prefers-reduced-motion: reduce) { animation: none }`.

## Phase 4 — Header stat tiles (Haiku-able once StatTile exists; otherwise
render simple cards inline)

Above the grid on `/heatmap`, a `StatTile` row (spec-01 B1) computed
client-side from the already-fetched log rows for the selected metric+year:

1. **Days logged** — count of days with data / days elapsed in year.
2. **Current streak** — consecutive days-with-data ending today/yesterday.
3. **Longest streak** — max run of days-with-data in the year.
4. **Goal met** — `% of logged days where goalMet === true` (hide tile when
   the metric has no daily goal).

---

## Verify

- [ ] Light + dark mode: ramp reads low→high in both; dark cells visible on
      `#020817`.
- [ ] A `direction: "decrease"` metric (and an avoid-checkbox) shows better
      days deeper / avoid-days red.
- [ ] Legend matches cell colors exactly (same tokens).
- [ ] Year view: 53 columns max, month labels aligned, no page-level
      horizontal scroll on mobile.
- [ ] Goal-met ring visible on both the lightest and darkest cell steps.
- [ ] `npm run lint && npm run build` pass.

Commits per phase:
`Heatmap: token-based quintile color ramp` ·
`Heatmap: cleaner cells, tooltip-first labels, goal rings` ·
`Heatmap: GitHub-style year view` ·
`Heatmap: summary stat tiles`
