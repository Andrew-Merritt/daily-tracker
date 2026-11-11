# Visual & UX Upgrade Roadmap — July 2026

Last updated: 2026-11-09
Status key: ✅ done · 🔄 in progress · ⬜ pending

Master plan for the visual/UX overhaul, prioritized around the two daily-use
modules: **Daily Tracker** and **Workouts**. Each item has its own spec doc in
this folder, written so it can be handed to an implementing model one at a
time, in one session each.

---

## Execution order & model assignments

Run the specs in this order. Do not start a spec until its dependencies are ✅.

| # | Spec | Doc | Model | Depends on | Status |
|---|------|-----|-------|------------|--------|
| 1a | Design tokens in globals.css | `spec-01-design-tokens-and-chart-foundation.md` Phase A | **Haiku 4.5** | — | ✅ (8fa3d6e) |
| 1b | `<TrackerChart>` + `<StatTile>` components | spec-01 Phase B | **Sonnet 5** | 1a | ✅ (8769d00) |
| 1c | Hardcoded-hex sweep | spec-01 Phase C | **Haiku 4.5** | 1a | ✅ (2b66db6) |
| 1d | Typeface (optional) | spec-01 Phase D | **Haiku 4.5** | — | ✅ (d14ec01) |
| 2 | Heatmap redesign | `spec-02-heatmap-redesign.md` | **Sonnet 5** | 1a | ✅ (333e945, 0b59e98, 6ad5c9a) |
| 3a | Metric stats sheet re-skin | `spec-03-tracker-subpage-reskins.md` § A | **Sonnet 5** | 1b | ⬜ next up |
| 3b | /metrics page re-skin | spec-03 § B | **Haiku 4.5** | 1b, 3a | ⬜ |
| 3c | /summary sparklines | spec-03 § C | **Sonnet 5** | 1b | ⬜ |
| 3d | Retire /ma | spec-03 § D | **Haiku 4.5** | 3a | ⬜ |
| 4a | ExerciseStatsSheet re-skin | `spec-04-workout-module-upgrades.md` § A | **Sonnet 5** | 1b | ⬜ |
| 4b | Estimated 1RM progression | spec-04 § B | **Sonnet 5** | 4a | ⬜ |
| 4c | Weekly volume dashboard | spec-04 § C | **Sonnet 5** | 1b | ⬜ |
| 4d | Workout consistency heatmap | spec-04 § D | **Haiku 4.5** | 2, 5 | ⬜ blocked — needs spec-05, out of scope this pass |
| 5 | Workout → tracker system metrics | `spec-05-workout-system-metrics.md` | **Opus 4.8** (do not use a smaller model) | — | ⬜ deliberately deferred this pass — needs Opus |
| 6a | SWR reference migration | `spec-06-swr-data-layer.md` § A | **Sonnet 5** | — | ⬜ |
| 6b | SWR page-by-page conversion | spec-06 § B | **Haiku 4.5** | 6a | ⬜ |

### Progress log (2026-07-30 session)

Implemented specs 01–02 in full on branch `claude/daily-tracker-improvements-e4novl`,
committed locally (not pushed — working locally by request). Commits, in order:

- `8fa3d6e` Add chart/status/heatmap design tokens
- `8769d00` Add TrackerChart and StatTile shared components
- `2b66db6` Replace hardcoded chart hexes with design tokens
- `d14ec01` Load Inter via next/font
- `333e945` Heatmap: token-based quintile color ramp, cleaner cells, tooltip-first labels, goal rings
- `0b59e98` Heatmap: GitHub-style year view
- `6ad5c9a` Heatmap: summary stat tiles

Notes for whoever picks this up:

- **Not yet visually verified in a browser.** `tsc --noEmit`, `npm run build`,
  and `npm run lint` all pass, but no one has opened `/heatmap` (Months + Year
  view, light + dark) or a metric/exercise stats sheet in a real browser to
  confirm the token sweep and heatmap rewrite actually look right. Do this
  before trusting 1–2 as done-done.
- Phase C hex sweep deliberately left some colors untouched (not in spec's
  mapping table): `#888` in `insight-detail-sheet.tsx`/`custom-insight-card.tsx`,
  the dynamic `rgb(${r},${g},${b})` template functions, and the
  `comparisonColors`/goal-target color arrays in `metric-stats-sheet.tsx`
  (spec-03 §A is where those get reworked into fixed slot assignments).
- `books/stats/page.tsx` `GENRE_COLORS`: only the first 6 entries became
  `var(--chart-1..6)` per spec; entries 7–10 stay literal hex intentionally.
- `getHeatmapLegendColors` signature changed: used to take
  `(direction, minVal, maxVal)` and return `{color, value}[]`; now takes just
  `direction` and returns `string[]`. It does **not** invert by direction —
  per-cell inversion (`getHeatCellColor` in `calendar-heatmap.tsx`) already
  bakes in "better = deeper," so the legend is always heat-1→heat-5 left to
  right. Don't re-add inversion here.
- Spec-04 §D needs spec-05's `workout_done`/`workout_tonnage` metrics to
  exist — skip it this pass along with spec-05 itself.
- **Update 2026-11-09:** the heatmap has since been reworked again (rolling
  12-month period, percentile colors, overlay, Weeks view, patterns) and
  checked in a browser on phone and desktop. `getHeatmapLegendColors` was
  replaced by `LEGEND_COLORS` in `src/lib/heatmap.ts`; the note above about
  its signature is historical.
- Next: spec-03 §A (`metric-stats-sheet.tsx` re-skin) is next up; it
  establishes the `TrackerChart`/`StatTile` consumption pattern that 03
  §B/§C and all of 04 copy.

### Why these assignments

- **Haiku 4.5** — pure transcription/find-and-replace tasks where the spec
  contains every value and every file location. No design judgment required.
  If a Haiku task hits anything ambiguous, stop and escalate to Sonnet rather
  than improvising.
- **Sonnet 5** — component building and edits inside large existing files
  (`metric-stats-sheet.tsx` is ~1,700 lines). The spec pins the API and
  visuals; the model handles integration.
- **Opus 4.8** — spec-05 only. It writes to the `log` table (the core data
  store for the whole tracker) and must be idempotent across workout
  create/edit/delete. Wrong writes here corrupt real history. This is the one
  task where model capability matters more than cost.

### Session protocol (paste this to the implementing model)

> Read `web/docs/<spec>.md` and implement exactly the phase named. Follow the
> spec's values verbatim — colors, tokens, and component APIs are
> pre-validated; do not substitute your own. When done: `npm run lint` and
> `npm run build` in `web/` must pass, then run the spec's Verify checklist,
> commit with the message given in the spec, and stop. Do not start the next
> phase.

---

## Design decisions already made (do not re-litigate in implementation)

1. **Palette is fixed and validated.** The categorical/series colors,
   sequential heatmap ramps, and status colors in spec-01 were validated for
   colorblind safety and contrast against this app's actual surfaces
   (`#ffffff` light / `#020817` dark) with a perceptual validator. They are
   not aesthetic suggestions — do not tweak them.
2. **One accent hue: blue** (`--chart-1`). Sequential ramps derive from it.
   Green/red are reserved for goal/status semantics only.
3. **No dual-axis charts.** Two measures of different scale → two stacked
   charts or normalize to % change.
4. **Charts always ship a tooltip**; series identity is never color-alone
   (legend or direct label required at ≥2 series).
5. **Heatmap intensity = single-hue ramp**, not red→green. Red is reserved
   for "avoid" metrics and goal-miss semantics.

## Deferred (revisit after the above ships)

- Unified command-center dashboard (cards per module)
- Cmd+K command palette / quick log
- Food/books system metrics (same pattern as spec-05)
- Custom insights out of localStorage into DB
- Weekly AI digest email
- ~~Web app manifest for Android installability~~ ✅ done (`src/app/manifest.ts`, with app shortcuts)
