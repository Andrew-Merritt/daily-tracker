# Quick Add (phone one-tap logging)

## How it works today

- **/metrics → "Quick" column** (`config.quick_add`, migration `20261013_config_quick_add.sql`).
  Only `hhmm` and `checkbox` metrics that aren't calculated can be ticked.
- **`GET /api/ai/metrics`** (the `listMetrics` agent tool) returns `quick_add` for each metric, in Today-page order.
- **Phone:** a Scripting Shortcut in *HTTP Request Shortcuts* (Waboodoo, Android) uses a read + write
  `dt_…` API key (Settings → API Keys, "Quick Buttons"). Tapping it:
  1. fetches `/api/ai/metrics` and keeps the metrics with `quick_add` set
  2. shows them as a pick list
  3. POSTs the pick to `/api/ai/log` with the phone's local date.
     Checkbox metrics are sent as `1`. `hhmm` metrics are sent as minutes since midnight,
     rounded to the nearest 5 minutes and capped at 23:55.
- The script lives on the phone. A copy with setup steps is at
  https://claude.ai/artifact/M3jiqRTZvVySgdr12HpZXY (private to the owner's Claude account).

Known behavior:
- Logging the same metric twice the same day overwrites the first value. That's intentional for retimes.
- There's no offline queue. If the request fails the toast says so and nothing is saved.

## Later

1. **After-midnight date rule.** `eat_finish` or `sleep_time` tapped after midnight lands on the new
   calendar day. Decide the cutoff hour (e.g. before 04:00 counts as the previous day) and which metrics
   it applies to. Then add it to the phone script, or make it a per-metric setting so the server or
   script can read it.
2. **"+1" for count metrics** (fish_oil, potassium, d3+k2, poops, alcohol, …). `logMetrics` overwrites
   values, so add an `increment: true` option to it in `lib/agent/tools/log.ts` (read the current value,
   then add). After that, allow `count` in the Quick column and have the script send increments.
3. **Option B: a separate one-tap icon per metric.** Each ticked metric gets its own home-screen icon,
   e.g. in a launcher folder, so logging is one tap with no pick list. These icons are set up on the
   phone in HTTP Request Shortcuts. /metrics could offer a downloadable import file to generate them,
   but that ties us to the app's export format, which could change between versions.
