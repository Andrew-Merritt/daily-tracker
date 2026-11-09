"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Check, Minus, Pencil } from "lucide-react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { addDays } from "@/lib/dateUtils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatCellValue, type HeatmapMetricType } from "@/components/calendar-heatmap";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export type DayDetailMetric = {
  metric_id: string;
  metric_name: string;
  type: HeatmapMetricType;
  group?: string | null;
  group_order?: number | null;
  metric_order?: number | null;
  private?: boolean;
  start_date?: string | null;
};

type DayRow = { metric_id: string; value: number | null; value_text: string | null };

export type DayDetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string | null;
  onDateChange: (date: string) => void;
  /** All active metrics (including text). */
  metrics: DayDetailMetric[];
  /** Metric currently shown on the heatmap — pinned to the top of the sheet. */
  highlightMetricId?: string | null;
};

const SHOW_PRIVATE_KEY = "heatmap:dayDetail:showPrivate";

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatLongDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("default", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sortMetrics(list: DayDetailMetric[]): DayDetailMetric[] {
  const groupOrder = new Map<string, number>();
  for (const m of list) {
    const key = m.group || "";
    const cur = groupOrder.get(key);
    const cand = m.group_order ?? 0;
    if (cur === undefined || cand < cur) groupOrder.set(key, cand);
  }
  return [...list].sort((a, b) => {
    const ga = a.group || "";
    const gb = b.group || "";
    const d = (groupOrder.get(ga) ?? 0) - (groupOrder.get(gb) ?? 0);
    if (d !== 0) return d;
    if (ga !== gb) return ga.localeCompare(gb);
    const o = (a.metric_order ?? 0) - (b.metric_order ?? 0);
    if (o !== 0) return o;
    return a.metric_id.localeCompare(b.metric_id);
  });
}

/**
 * Bottom sheet (side panel on desktop) showing everything logged on one day:
 * notes, every metric grouped like the Today form, and a link to edit the day.
 * Swipe left/right (or use the arrows) to move between days.
 */
export function DayDetailSheet({
  open,
  onOpenChange,
  date,
  onDateChange,
  metrics,
  highlightMetricId,
}: DayDetailSheetProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const today = localToday();

  const [showPrivate, setShowPrivate] = useState(true);
  useEffect(() => {
    setShowPrivate(localStorage.getItem(SHOW_PRIVATE_KEY) !== "0");
  }, []);
  const togglePrivate = () => {
    setShowPrivate((prev) => {
      localStorage.setItem(SHOW_PRIVATE_KEY, prev ? "0" : "1");
      return !prev;
    });
  };

  // Per-date cache so swiping back and forth is instant.
  const cache = useRef(new Map<string, DayRow[]>());
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !date) return;
    setError(null);
    const cached = cache.current.get(date);
    if (cached) {
      setRows(cached);
      return;
    }
    setRows(null);
    let cancelled = false;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`/api/log?date=${encodeURIComponent(date)}`, { headers });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load day");
        cache.current.set(date, json as DayRow[]);
        if (!cancelled) setRows(json as DayRow[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, date]);

  const view = useMemo(() => {
    if (!date || !rows) return null;
    const byId = new Map(rows.map((r) => [r.metric_id, r]));

    // Only metrics that existed on this date (start_date on or before it).
    const visible = sortMetrics(
      metrics.filter(
        (m) => (showPrivate || !m.private) && (!m.start_date || m.start_date <= date)
      )
    );

    const notes: { metric: DayDetailMetric; text: string }[] = [];
    const groups: { name: string; items: { metric: DayDetailMetric; row: DayRow | undefined }[] }[] = [];
    const notLogged: DayDetailMetric[] = [];
    let highlight: { metric: DayDetailMetric; row: DayRow | undefined } | null = null;

    for (const m of visible) {
      const row = byId.get(m.metric_id);
      if (m.type === "text") {
        const t = row?.value_text?.trim();
        if (t) notes.push({ metric: m, text: row!.value_text! });
        continue;
      }
      if (m.metric_id === highlightMetricId) {
        highlight = { metric: m, row };
        continue;
      }
      // Checkboxes use row/no-row semantics: no row means "not done", which
      // is information, so they always show. Other types without a value are
      // collected into a compact "not logged" line.
      if (m.type !== "checkbox" && row?.value == null) {
        notLogged.push(m);
        continue;
      }
      const name = m.group || "Other";
      let g = groups.find((x) => x.name === name);
      if (!g) {
        g = { name, items: [] };
        groups.push(g);
      }
      g.items.push({ metric: m, row });
    }

    // Highlight metric may be private/hidden or not yet started — fall back to config.
    if (!highlight && highlightMetricId) {
      const m = metrics.find((x) => x.metric_id === highlightMetricId);
      if (m && m.type !== "text" && (showPrivate || !m.private)) {
        highlight = { metric: m, row: byId.get(m.metric_id) };
      }
    }

    const loggedCount = rows.filter((r) => r.value != null || (r.value_text ?? "").trim() !== "").length;
    const hiddenPrivate = showPrivate ? 0 : metrics.filter((m) => m.private).length;

    return { notes, groups, notLogged, highlight, loggedCount, hiddenPrivate };
  }, [date, rows, metrics, showPrivate, highlightMetricId]);

  const canGoNext = !!date && date < today;
  const goPrev = () => date && onDateChange(addDays(date, -1));
  const goNext = () => canGoNext && date && onDateChange(addDays(date, 1));

  // Horizontal swipe between days (ignore mostly-vertical drags so scrolling works).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx > 0) goPrev();
    else goNext();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? "right" : "bottom"}
        className={
          isDesktop
            ? "w-full sm:max-w-md overflow-y-auto flex flex-col"
            : "max-h-[85vh] overflow-y-auto rounded-t-xl flex flex-col"
        }
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        // Don't auto-focus the first button (shows a focus ring on phones).
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SheetHeader className="text-left pr-8">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={goPrev} aria-label="Previous day">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <SheetTitle className="text-base flex-1 text-center">
              {date ? formatLongDate(date) : ""}
            </SheetTitle>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={goNext}
              disabled={!canGoNext}
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <SheetDescription className="text-xs text-center">
            {view ? `${view.loggedCount} value${view.loggedCount === 1 ? "" : "s"} logged` : " "}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 text-sm">
          {error && <p className="text-destructive">Error: {error}</p>}
          {!error && !view && <p className="text-muted-foreground">Loading…</p>}

          {view && (
            <>
              {view.highlight && (
                <div className="rounded-lg border bg-muted/40 px-3 py-2 flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">{view.highlight.metric.metric_name}</span>
                  <span className="text-xl font-semibold tabular-nums">
                    <MetricValue metric={view.highlight.metric} row={view.highlight.row} />
                  </span>
                </div>
              )}

              {view.notes.map(({ metric, text }) => (
                <div key={metric.metric_id}>
                  <div className="text-xs font-medium text-muted-foreground mb-1">{metric.metric_name}</div>
                  <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 leading-relaxed">{text}</p>
                </div>
              ))}

              {view.loggedCount === 0 && view.notes.length === 0 && (
                <p className="text-muted-foreground">Nothing logged on this day.</p>
              )}

              {view.groups.map((g) => (
                <div key={g.name}>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    {g.name}
                  </div>
                  <div className="divide-y rounded-md border">
                    {g.items.map(({ metric, row }) => (
                      <div key={metric.metric_id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <span className="truncate">{metric.metric_name}</span>
                        <span className="tabular-nums font-medium shrink-0">
                          <MetricValue metric={metric} row={row} />
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {view.notLogged.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">Not logged:</span>{" "}
                  {view.notLogged.map((m) => m.metric_name).join(", ")}
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer stays pinned so "Edit this day" is reachable without scrolling. */}
        <div className="sticky -bottom-4 sm:-bottom-6 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-background border-t flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={togglePrivate}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {showPrivate ? "Hide private" : `Show private${view?.hiddenPrivate ? ` (${view.hiddenPrivate})` : ""}`}
          </button>
          {date && (
            <Link href={`/?date=${date}`} className={buttonVariants({ size: "sm" })}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit this day
            </Link>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MetricValue({ metric, row }: { metric: DayDetailMetric; row: DayRow | undefined }) {
  if (metric.type === "checkbox") {
    return row?.value != null && row.value >= 0.5 ? (
      <Check className="h-4 w-4 inline text-[var(--status-good)]" aria-label="Yes" />
    ) : (
      <Minus className="h-4 w-4 inline text-muted-foreground/60" aria-label="No" />
    );
  }
  if (row?.value == null) return <span className="text-muted-foreground/60">—</span>;
  return <>{formatCellValue(row.value, metric.type)}</>;
}
