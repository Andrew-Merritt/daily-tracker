/**
 * Fetch every row of a Supabase query past the 1000-row page limit, with the
 * pages requested in parallel instead of one after another.
 *
 * The first page is fetched with an exact count; the remaining pages are then
 * fired concurrently. `makeQuery` must return a fresh, fully-filtered query each
 * call (select + filters + a deterministic order — include a tiebreaker column,
 * otherwise offset pagination can skip or repeat rows at page boundaries).
 *
 *   const rows = await fetchAllRows<LogRow>((count) =>
 *     supabase.from("log")
 *       .select("date, metric_id, value", count ? { count: "exact" } : undefined)
 *       .eq("owner_id", userId)
 *       .order("date").order("metric_id")
 *   );
 */

type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

type RangeableQuery<T> = {
  range(from: number, to: number): PromiseLike<PageResult<T>>;
};

export async function fetchAllRows<T>(
  makeQuery: (withCount: boolean) => RangeableQuery<T>,
  { pageSize = 1000, maxRows = 500_000 }: { pageSize?: number; maxRows?: number } = {}
): Promise<T[]> {
  const first = await makeQuery(true).range(0, pageSize - 1);
  if (first.error) throw new Error(first.error.message);

  const rows: T[] = [...(first.data ?? [])];
  const total = Math.min(first.count ?? rows.length, maxRows);

  // Count unavailable but the page came back full: fall back to sequential paging.
  if (first.count == null) {
    let from = pageSize;
    let last = rows.length;
    while (last === pageSize && from < maxRows) {
      const page = await makeQuery(false).range(from, from + pageSize - 1);
      if (page.error) throw new Error(page.error.message);
      const batch = page.data ?? [];
      rows.push(...batch);
      last = batch.length;
      from += pageSize;
    }
    return rows;
  }

  if (total <= rows.length) return rows;

  const pages: Promise<PageResult<T>>[] = [];
  for (let from = pageSize; from < total; from += pageSize) {
    pages.push(Promise.resolve(makeQuery(false).range(from, from + pageSize - 1)));
  }
  for (const page of await Promise.all(pages)) {
    if (page.error) throw new Error(page.error.message);
    rows.push(...(page.data ?? []));
  }
  return rows;
}
