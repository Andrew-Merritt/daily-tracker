# Spec 01 — Design Tokens & Chart Foundation

Last updated: 2026-07-17
Status: ✅ done — Phase A 8fa3d6e, B 8769d00, C 2b66db6, D d14ec01
Models: Phase A **Haiku 4.5** · Phase B **Sonnet 5** · Phase C **Haiku 4.5** · Phase D **Haiku 4.5** (optional)

Every chart in the app currently hardcodes its own hex colors
(`#3b82f6`, `#374151`, `#94a3b8`, …) with no dark-mode awareness. This spec
adds one set of theme tokens and two shared components that every later spec
builds on.

All colors below are **pre-validated** (colorblind separation + contrast
against this app's real surfaces: light `#ffffff`, dark `#020817`).
Transcribe them exactly. Do not substitute.

---

## Phase A — Tokens in `globals.css` (Haiku 4.5)

**File:** `src/app/globals.css`

Add inside the existing `@layer base` block, appending to the existing
`:root` and `.dark` selectors (do NOT remove any existing variable). Note
these new tokens are full color values, unlike the existing HSL-triplet
variables — that is intentional; they are consumed directly.

```css
:root {
  /* … existing vars stay … */

  /* Chart series (fixed order — assign by slot, never re-order or cycle) */
  --chart-1: #2a78d6;  /* blue — primary/accent series */
  --chart-2: #008300;  /* green */
  --chart-3: #e87ba4;  /* magenta */
  --chart-4: #eda100;  /* yellow */
  --chart-5: #1baf7a;  /* aqua */
  --chart-6: #eb6834;  /* orange */

  /* Chart chrome */
  --chart-grid: #e5e7eb;
  --chart-axis: #9ca3af;

  /* Status (goal semantics — never used as a series color) */
  --status-good: #0ca30c;
  --status-good-text: #006300;
  --status-warning: #fab219;
  --status-danger: #d03b3b;

  /* Heatmap sequential ramp, low → high intensity */
  --heat-1: #cde2fb;
  --heat-2: #86b6ef;
  --heat-3: #3987e5;
  --heat-4: #1c5cab;
  --heat-5: #0d366b;
  --heat-empty: hsl(var(--muted));
}

.dark {
  /* … existing vars stay … */

  --chart-1: #3987e5;
  --chart-2: #008300;
  --chart-3: #d55181;
  --chart-4: #c98500;
  --chart-5: #199e70;
  --chart-6: #d95926;

  --chart-grid: #1f2937;
  --chart-axis: #6b7280;

  --status-good: #0ca30c;
  --status-good-text: #0ca30c;
  --status-warning: #fab219;
  --status-danger: #e66767;

  /* Dark ramp inverts lightness: low recedes toward the dark surface */
  --heat-1: #0d366b;
  --heat-2: #184f95;
  --heat-3: #256abf;
  --heat-4: #3987e5;
  --heat-5: #86b6ef;
  --heat-empty: hsl(var(--muted));
}
```

Also append to the existing `@theme inline` block so Tailwind utilities work
(`text-chart-1`, `bg-status-good`, …):

```css
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-chart-6: var(--chart-6);
  --color-status-good: var(--status-good);
  --color-status-warning: var(--status-warning);
  --color-status-danger: var(--status-danger);
```

**Verify:** `npm run build` passes; app renders unchanged (tokens are not yet
consumed).
**Commit:** `Add chart/status/heatmap design tokens`

---

## Phase B — `<TrackerChart>` and `<StatTile>` (Sonnet 5)

### B1. `src/components/ui/stat-tile.tsx` (new)

```tsx
type StatTileProps = {
  label: string;                       // e.g. "Current streak"
  value: string;                       // pre-formatted, e.g. "12 days"
  delta?: { text: string; direction: "up" | "down" | "flat"; good?: boolean };
  spark?: number[];                    // optional mini sparkline values
  onClick?: () => void;
};
```

- Renders inside a bordered rounded card (`border rounded-lg px-3 py-2`).
- `label`: `text-xs text-muted-foreground`.
- `value`: `text-2xl font-semibold tracking-tight`.
- `delta`: small badge — arrow glyph + text. Color: `--status-good-text` when
  `good`, `--status-danger` when `!good`, `text-muted-foreground` when flat.
  Always includes the arrow glyph so color is not the only signal.
- `spark`: 40×16 inline SVG polyline, stroke `var(--chart-1)`, strokeWidth
  1.5, no axes, right-aligned in the tile. Skip if fewer than 3 points.
- A row of tiles = `grid grid-cols-2 sm:grid-cols-4 gap-2`.

### B2. `src/components/tracker-chart.tsx` (new)

A styled wrapper around Recharts used by all metric time-series charts.

```tsx
type TrackerSeries = {
  key: string;                 // dataKey in `data`
  name: string;                // legend/tooltip label
  slot?: 1 | 2 | 3 | 4 | 5 | 6; // color slot, default 1
  kind?: "area" | "line";      // default "area" for first series, "line" after
  dashed?: boolean;            // e.g. moving-average overlays
};

type TrackerChartProps = {
  data: Record<string, unknown>[];   // rows including a `date` field (YYYY-MM-DD)
  series: TrackerSeries[];
  height?: number;                   // default 240
  goal?: { value: number; label?: string };  // horizontal reference line
  yFormatter?: (v: number) => string;
};
```

Rendering rules (this is the "visually stunning" part — follow exactly):

1. `ResponsiveContainer` → `ComposedChart`.
2. **Gradient area fill** for `kind:"area"` series: an SVG `<defs>`
   `<linearGradient>` per slot — stop 0% at the slot color with opacity
   0.25, stop 100% opacity 0. Area `fill` = the gradient, `stroke` = slot
   color, `strokeWidth` 2, `dot=false`, `activeDot={{ r: 4 }}`.
3. Lines: `strokeWidth` 2, `dot=false`. `dashed` → `strokeDasharray="4 3"`
   and strokeOpacity 0.8.
4. Grid: `<CartesianGrid vertical={false} stroke="var(--chart-grid)" />`.
5. Axes: `stroke="var(--chart-axis)"`, `tickLine={false}`,
   `axisLine={false}`, `fontSize` 11. XAxis formats `date` as `M/D`.
6. `goal` → `<ReferenceLine y={goal.value} stroke="var(--status-good)"
   strokeDasharray="6 4" />` with the label at the right edge, fontSize 10.
7. Tooltip: reuse `ChartTooltip` from `src/components/chart-tooltip.tsx`.
8. Legend: only when `series.length >= 2`; small dot swatches, fontSize 11,
   `text-muted-foreground` text (text never wears the series color).
9. **Never two y-axes.** If a caller needs two scales, they render two
   stacked `<TrackerChart>`s.

**Verify:** temporary render on any page with sample data, then remove; both
themes checked (toggle `.dark`).
**Commit:** `Add TrackerChart and StatTile shared components`

---

## Phase C — Hardcoded-hex sweep (Haiku 4.5)

Replace raw hex with tokens in place (no structural changes, no component
swaps — that is spec-03/04). Mapping:

| Old hex | Replace with |
|---|---|
| `#3b82f6` (blue) | `var(--chart-1)` |
| `#10b981` (green) | `var(--chart-5)` |
| `#f59e0b` (amber) | `var(--chart-4)` |
| `#8b5cf6` (violet) | `var(--chart-3)` |
| `#f97316` (orange) | `var(--chart-6)` |
| `#374151` (grid strokes) | `var(--chart-grid)` |
| `#94a3b8` / `#6b7280` (axis strokes) | `var(--chart-axis)` |
| `rgb(34, 197, 94)` (green fills) | `var(--status-good)` |
| `rgb(239, 68, 68)` (red fills) | `var(--status-danger)` |

Files (grep each for `#` colors and `rgb(` to catch all instances):

- [ ] `src/components/metric-stats-sheet.tsx`
- [ ] `src/components/radar-chart.tsx`
- [ ] `src/components/custom-insight-card.tsx`
- [ ] `src/components/insight-detail-sheet.tsx`
- [ ] `src/components/BodyMeasurementsSheet.tsx`
- [ ] `src/app/ma/page.tsx`
- [ ] `src/app/metrics/page.tsx`
- [ ] `src/app/workouts/components/ExerciseStatsSheet.tsx`
- [ ] `src/app/radar/page.tsx`
- [ ] `src/app/books/stats/page.tsx` (keep its `GENRE_COLORS` count, but
      source the first 6 from `var(--chart-1..6)`)

Exclusions: do NOT touch `calendar-heatmap.tsx` (spec-02 replaces its color
logic wholesale) and do NOT touch loading/ icon components.

**Verify:** visually open /metrics, /radar, /books/stats, a metric stats
sheet, and an exercise stats sheet in light AND dark mode. Charts must be
legible in both.
**Commit:** `Replace hardcoded chart hexes with design tokens`

---

## Phase D — Typeface (optional, Haiku 4.5)

**Files:** `src/app/layout.tsx`, `src/app/globals.css`

1. `import { Inter } from "next/font/google"` with
   `const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })`.
2. Add `inter.variable` to the `<html>` className; change body font-family to
   `var(--font-sans), system-ui, sans-serif` (remove the inline style).
3. Add utility: numbers that must align vertically (log table, axis ticks)
   get `font-variant-numeric: tabular-nums` via a `.tabular` class.

**Commit:** `Load Inter via next/font`
