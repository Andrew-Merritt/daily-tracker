"use client";

import { useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/components/theme-provider";
import { CALC_DEBUG_KEY } from "@/lib/devFlags";

type MainPageSettings = {
  show_indicators: boolean;
  show_trends: boolean;
  show_streaks: boolean;
};

type EmailBackupSettings = {
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  modules: string[];
  last_sent_at: string | null;
};

type UserSettings = {
  main_page: MainPageSettings;
  email_backup?: EmailBackupSettings;
};

type UserProfile = {
  gender: "male" | "female" | "other" | null;
  birth_year: number | null;
};

const DEFAULT_SETTINGS: UserSettings = {
  main_page: {
    show_indicators: true,
    show_trends: true,
    show_streaks: true,
  },
};

const ALL_BACKUP_MODULES = ["tracker", "food", "workouts", "labs", "books"] as const;
const MODULE_LABELS: Record<string, string> = {
  tracker: "Daily Tracker",
  food: "Food",
  workouts: "Workouts",
  labs: "Labs",
  books: "Books",
};
const DEFAULT_BACKUP: EmailBackupSettings = {
  enabled: false,
  frequency: "weekly",
  modules: [...ALL_BACKUP_MODULES],
  last_sent_at: null,
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();

  // Profile state
  const [profile, setProfile] = useState<UserProfile>({ gender: null, birth_year: null });
  const [profileLoading, setProfileLoading] = useState(true);

  // Per-device developer toggle: shows formula/debug info under calculated metrics on the Today page
  const [calcDebug, setCalcDebug] = useState(false);
  useEffect(() => {
    setCalcDebug(localStorage.getItem(CALC_DEBUG_KEY) === "1");
  }, []);
  const toggleCalcDebug = (on: boolean) => {
    setCalcDebug(on);
    if (on) localStorage.setItem(CALC_DEBUG_KEY, "1");
    else localStorage.removeItem(CALC_DEBUG_KEY);
  };
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveStatus, setProfileSaveStatus] = useState<string | null>(null);
  const [birthYearInput, setBirthYearInput] = useState("");

  // Backfill state
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillFromDate, setBackfillFromDate] = useState("");
  const [backfillProgress, setBackfillProgress] = useState<{
    current: number;
    total: number;
    date: string;
    percent: number;
  } | null>(null);
  const [backfillResult, setBackfillResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Email backup state
  const [backup, setBackup] = useState<EmailBackupSettings>(DEFAULT_BACKUP);
  const [backupSending, setBackupSending] = useState(false);
  const [backupSendStatus, setBackupSendStatus] = useState<string | null>(null);

  // Load settings on mount
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const headers = await getAuthHeaders();
        const res = await fetch("/api/settings", { headers });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load settings");
        setSettings(json);
        if (json.email_backup) setBackup({ ...DEFAULT_BACKUP, ...json.email_backup });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load profile on mount
  useEffect(() => {
    (async () => {
      try {
        setProfileLoading(true);
        const headers = await getAuthHeaders();
        const res = await fetch("/api/profile", { headers });
        const json = await res.json();
        if (res.ok) {
          setProfile(json);
          setBirthYearInput(json.birth_year ? String(json.birth_year) : "");
        }
      } catch { /* ignore */ }
      finally { setProfileLoading(false); }
    })();
  }, []);

  const saveProfile = async (updates: Partial<UserProfile>) => {
    setProfileSaving(true);
    setProfileSaveStatus(null);
    try {
      const headers = await getAuthHeaders();
      const next = { ...profile, ...updates };
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to save");
      setProfile(json);
      setProfileSaveStatus("Saved");
      setTimeout(() => setProfileSaveStatus(null), 2000);
    } catch { /* ignore */ }
    finally { setProfileSaving(false); }
  };

  // Save settings helper
  const saveSettings = async (newSettings: UserSettings) => {
    try {
      setSaving(true);
      setSaveStatus(null);
      const headers = await getAuthHeaders();
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newSettings),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to save settings");
      setSettings(json);
      setSaveStatus("Saved");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const saveBackup = async (next: EmailBackupSettings) => {
    setBackup(next);
    const headers = await getAuthHeaders();
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ email_backup: next }),
    });
  };

  const sendNow = async () => {
    setBackupSending(true);
    setBackupSendStatus(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/exports/email", { method: "POST", headers });
      if (res.ok) {
        setBackupSendStatus("Sent!");
        setBackup((b) => ({ ...b, last_sent_at: new Date().toISOString() }));
      } else {
        const json = await res.json();
        setBackupSendStatus(json.error ?? "Failed to send");
      }
    } catch { setBackupSendStatus("Request failed"); }
    finally {
      setBackupSending(false);
      setTimeout(() => setBackupSendStatus(null), 4000);
    }
  };

  // Toggle handler with auto-save
  const handleToggle = (key: keyof MainPageSettings) => {
    const newSettings: UserSettings = {
      ...settings,
      main_page: {
        ...settings.main_page,
        [key]: !settings.main_page[key],
      },
    };
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  // Backfill handlers using Server-Sent Events for progress
  const runBackfill = async (all: boolean) => {
    setBackfillRunning(true);
    setBackfillResult(null);
    setBackfillProgress(null);

    // Build URL with query params
    const params = new URLSearchParams();
    if (all) {
      params.set("all", "true");
    } else {
      params.set("fromDate", backfillFromDate);
    }

    const eventSource = new EventSource(`/api/backfill-stream?${params.toString()}`);

    eventSource.addEventListener("progress", (e) => {
      const data = JSON.parse(e.data);
      setBackfillProgress(data);
    });

    eventSource.addEventListener("complete", (e) => {
      const data = JSON.parse(e.data);
      setBackfillResult({
        success: data.success,
        message: `Recalculated ${data.daysProcessed} days${
          data.errors?.length ? ` (${data.errors.length} warnings)` : ""
        }`,
      });
      setBackfillProgress(null);
      setBackfillRunning(false);
      eventSource.close();
    });

    eventSource.addEventListener("error", (e) => {
      // Check if it's a custom error event or connection error
      if (e instanceof MessageEvent) {
        const data = JSON.parse(e.data);
        setBackfillResult({ success: false, message: data.error });
      } else {
        setBackfillResult({ success: false, message: "Connection lost" });
      }
      setBackfillProgress(null);
      setBackfillRunning(false);
      eventSource.close();
    });

    eventSource.onerror = () => {
      // Only handle if not already closed by complete/error event
      if (backfillRunning) {
        setBackfillResult({ success: false, message: "Connection error" });
        setBackfillProgress(null);
        setBackfillRunning(false);
      }
      eventSource.close();
    };
  };

  return (
    <main className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        {saveStatus && (
          <span className="text-sm text-green-600">{saveStatus}</span>
        )}
        {saving && <span className="text-sm text-muted-foreground">Saving...</span>}
      </div>

      {loading && <div className="text-sm text-muted-foreground">Loading...</div>}
      {error && <div className="text-sm text-red-600">Error: {error}</div>}

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center justify-between">
            Profile
            {profileSaveStatus && <span className="text-sm font-normal text-green-600">{profileSaveStatus}</span>}
            {profileSaving && <span className="text-sm font-normal text-muted-foreground">Saving...</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Used to personalise optimal lab reference ranges by gender and age.
          </p>
          {profileLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Biological Sex</label>
                <div className="flex gap-2">
                  {(["male", "female", "other"] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => { setProfile((p) => ({ ...p, gender: g })); saveProfile({ gender: g }); }}
                      className={`px-3 py-1.5 rounded-md border text-sm capitalize ${
                        profile.gender === g
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background hover:bg-muted"
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Birth Year</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1900}
                    max={new Date().getFullYear()}
                    placeholder="e.g. 1985"
                    value={birthYearInput}
                    onChange={(e) => setBirthYearInput(e.target.value)}
                    onBlur={() => {
                      const y = parseInt(birthYearInput, 10);
                      if (!birthYearInput) {
                        saveProfile({ birth_year: null });
                      } else if (!isNaN(y) && y >= 1900 && y <= new Date().getFullYear()) {
                        saveProfile({ birth_year: y });
                      }
                    }}
                    className="w-32"
                  />
                  {profile.birth_year && (
                    <span className="text-sm text-muted-foreground">
                      Age {new Date().getFullYear() - profile.birth_year}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Theme Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Appearance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose your preferred color theme.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setTheme("light")}
              className={`px-4 py-2 rounded-md border text-sm ${
                theme === "light"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={`px-4 py-2 rounded-md border text-sm ${
                theme === "dark"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme("system")}
              className={`px-4 py-2 rounded-md border text-sm ${
                theme === "system"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              }`}
            >
              System
            </button>
          </div>
        </CardContent>
      </Card>

      {!loading && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Main Page Indicators</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Control which indicators appear on the daily input page next to
              your metrics.
            </p>

            <div className="space-y-3">
              {/* Master toggle */}
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                  checked={settings.main_page.show_indicators}
                  onChange={() => handleToggle("show_indicators")}
                />
                <div>
                  <div className="font-medium">Show indicators</div>
                  <div className="text-sm text-muted-foreground">
                    Master toggle for all indicator badges on the main page
                  </div>
                </div>
              </label>

              {/* Trends toggle - only enabled if master is on */}
              <label
                className={`flex items-start gap-3 cursor-pointer pl-6 ${
                  !settings.main_page.show_indicators ? "opacity-50" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                  checked={settings.main_page.show_trends}
                  onChange={() => handleToggle("show_trends")}
                  disabled={!settings.main_page.show_indicators}
                />
                <div>
                  <div className="font-medium">Trend arrows</div>
                  <div className="text-sm text-muted-foreground">
                    Show trend direction (up/down/flat) for numeric metrics
                    based on 7-day comparison
                  </div>
                </div>
              </label>

              {/* Streaks toggle - only enabled if master is on */}
              <label
                className={`flex items-start gap-3 cursor-pointer pl-6 ${
                  !settings.main_page.show_indicators ? "opacity-50" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                  checked={settings.main_page.show_streaks}
                  onChange={() => handleToggle("show_streaks")}
                  disabled={!settings.main_page.show_indicators}
                />
                <div>
                  <div className="font-medium">Streak badges</div>
                  <div className="text-sm text-muted-foreground">
                    Show current streak count for checkbox metrics
                  </div>
                </div>
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Data Maintenance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Data Maintenance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Recalculate computed metrics (like those using <code className="bg-muted px-1 rounded">prev()</code> or <code className="bg-muted px-1 rounded">diff()</code>).
            Use this after changing formulas or if calculated values seem incorrect.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={calcDebug}
              onChange={(e) => toggleCalcDebug(e.target.checked)}
              className="h-4 w-4 rounded"
            />
            Show calc debug on the Today page
            <span className="text-xs text-muted-foreground">(this device only)</span>
          </label>

          {/* Full backfill */}
          <div className="flex items-center gap-3">
            <Button
              onClick={() => runBackfill(true)}
              disabled={backfillRunning}
              variant="outline"
            >
              {backfillRunning ? "Running..." : "Recalculate All History"}
            </Button>
            <span className="text-sm text-muted-foreground">
              Recalculates all calculated metrics from the beginning
            </span>
          </div>

          {/* From date backfill */}
          <div className="flex items-center gap-3">
            <Input
              type="date"
              value={backfillFromDate}
              onChange={(e) => setBackfillFromDate(e.target.value)}
              className="w-40"
              disabled={backfillRunning}
            />
            <Button
              onClick={() => runBackfill(false)}
              disabled={backfillRunning || !backfillFromDate}
              variant="outline"
            >
              {backfillRunning ? "Running..." : "Recalculate from Date"}
            </Button>
          </div>

          {/* Progress bar */}
          {backfillProgress && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Processing {backfillProgress.date}</span>
                <span>{backfillProgress.current} / {backfillProgress.total} days ({backfillProgress.percent}%)</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-150"
                  style={{ width: `${backfillProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Result message */}
          {backfillResult && (
            <div
              className={`text-sm p-2 rounded ${
                backfillResult.success
                  ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              }`}
            >
              {backfillResult.message}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email Backups */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center justify-between">
            <span>Email Backups</span>
            <div className="flex items-center gap-2">
              {backupSendStatus && (
                <span className={`text-sm font-normal ${backupSendStatus === "Sent!" ? "text-green-600" : "text-red-600"}`}>
                  {backupSendStatus}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={sendNow} disabled={backupSending || !backup.enabled}>
                {backupSending ? "Sending…" : "Send Now"}
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sends a ZIP of CSV files to your account email. Data is stored in your inbox — completely independent of the app database.
          </p>

          {/* Enable toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={backup.enabled}
              onChange={() => saveBackup({ ...backup, enabled: !backup.enabled })}
            />
            <span className="font-medium text-sm">Enable automatic backups</span>
          </label>

          {backup.enabled && (
            <>
              {/* Frequency */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Frequency</p>
                <div className="flex gap-2">
                  {(["daily", "weekly", "monthly"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => saveBackup({ ...backup, frequency: f })}
                      className={`px-3 py-1.5 rounded-md border text-sm capitalize transition-colors ${
                        backup.frequency === f ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {/* Modules */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Modules</p>
                <div className="grid grid-cols-2 gap-2">
                  {ALL_BACKUP_MODULES.map((mod) => (
                    <label key={mod} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300"
                        checked={backup.modules.includes(mod)}
                        onChange={() => {
                          const next = backup.modules.includes(mod)
                            ? backup.modules.filter((m) => m !== mod)
                            : [...backup.modules, mod];
                          saveBackup({ ...backup, modules: next });
                        }}
                      />
                      <span className="text-sm">{MODULE_LABELS[mod]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {backup.last_sent_at && (
            <p className="text-xs text-muted-foreground">
              Last sent: {new Date(backup.last_sent_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground/70">
        Settings are saved automatically when changed.
      </div>
    </main>
  );
}
