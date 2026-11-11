"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DurationPicker } from "@/components/ui/mobile-pickers";
import {
  type WorkoutTimerState,
  type TabataSplit,
  type CountUpPreset,
  type AudioSettings,
  type SoundType,
  playTone,
  isScreenOffAudioEnabled,
  setScreenOffAudioEnabled,
} from "@/hooks/useWorkoutTimer";
// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function formatHMS(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatMS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${pad(m)}:${pad(s)}`;
}

function splitSummary(split: TabataSplit): string {
  const rounds = split.rounds ?? 1;
  const parts: string[] = [];
  if (split.warmup_seconds > 0) parts.push(`${split.warmup_seconds}s warmup`);
  const cycleStr = rounds > 1
    ? `${rounds}r × ${split.cycles}×${split.on_seconds}s/${split.off_seconds}s`
    : `${split.cycles}×${split.on_seconds}s/${split.off_seconds}s`;
  parts.push(cycleStr);
  if (split.cooldown_seconds > 0) parts.push(`${split.cooldown_seconds}s cooldown`);
  return parts.join(" · ");
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "warmup": return "Warmup";
    case "on": return "Go!";
    case "off": return "Rest";
    case "cooldown": return "Cooldown";
    case "done": return "Done ✓";
    default: return "";
  }
}

function phaseColor(phase: string, split: TabataSplit | null): string {
  if (!split) return "#6b7280";
  switch (phase) {
    case "warmup": return split.warmup_color;
    case "on": return split.on_color;
    case "off": return split.off_color;
    case "cooldown": return split.cooldown_color;
    default: return "#6b7280";
  }
}

function newSplitId(): string {
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const SOUND_TYPES: { value: SoundType; label: string }[] = [
  { value: "tone",        label: "Tone" },
  { value: "boxing-bell", label: "Boxing Bell" },
  { value: "air-horn",    label: "Air Horn" },
  { value: "whistle",     label: "Whistle" },
  { value: "chime",       label: "Chime" },
  { value: "buzzer",      label: "Buzzer" },
];

function emptyAudio(): AudioSettings {
  return { enabled: true, soundType: "tone", frequency: 440, oscType: "sine" };
}

// ─── AudioRow ─────────────────────────────────────────────────────────────────
// Simplified: only sound type selector + on/off + test button.

function AudioRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: AudioSettings;
  onChange: (v: AudioSettings) => void;
}) {
  const soundType = value.soundType ?? "tone";
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-20 shrink-0 font-medium text-muted-foreground">{label}</span>
      <label className="flex items-center gap-1 cursor-pointer shrink-0">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          className="cursor-pointer"
        />
        <span className="text-xs">On</span>
      </label>
      <select
        value={soundType}
        disabled={!value.enabled}
        onChange={(e) => onChange({ ...value, soundType: e.target.value as SoundType })}
        className="flex-1 h-7 text-xs border rounded px-1 bg-background"
      >
        {SOUND_TYPES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
      <button
        type="button"
        disabled={!value.enabled}
        onClick={() => playTone(value)}
        className="text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-40 shrink-0"
        title="Test sound"
      >
        ▶
      </button>
    </div>
  );
}

// ─── Split Editor ─────────────────────────────────────────────────────────────

function SplitEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: TabataSplit | null;
  onSave: (s: TabataSplit) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "New Split");
  // Duration fields stored as total seconds (integers)
  const [warmup, setWarmup] = useState(initial?.warmup_seconds ?? 0);
  const [rounds, setRounds] = useState(String(initial?.rounds ?? 1));
  const [cycles, setCycles] = useState(String(initial?.cycles ?? 8));
  const [on, setOn] = useState(initial?.on_seconds ?? 20);
  const [off, setOff] = useState(initial?.off_seconds ?? 10);
  const [cooldown, setCooldown] = useState(initial?.cooldown_seconds ?? 0);
  const [warmupColor, setWarmupColor] = useState(initial?.warmup_color ?? "#3b82f6");
  const [onColor, setOnColor] = useState(initial?.on_color ?? "#22c55e");
  const [offColor, setOffColor] = useState(initial?.off_color ?? "#ef4444");
  const [cooldownColor, setCooldownColor] = useState(initial?.cooldown_color ?? "#a855f7");
  const [warmupAudio, setWarmupAudio] = useState<AudioSettings>(
    initial?.warmup_audio ?? { ...emptyAudio(), soundType: "tone" }
  );
  const [onAudio, setOnAudio] = useState<AudioSettings>(
    initial?.on_audio ?? { ...emptyAudio(), soundType: "boxing-bell" }
  );
  const [offAudio, setOffAudio] = useState<AudioSettings>(
    initial?.off_audio ?? { ...emptyAudio(), soundType: "buzzer" }
  );
  const [cooldownAudio, setCooldownAudio] = useState<AudioSettings>(
    initial?.cooldown_audio ?? { ...emptyAudio(), soundType: "tone" }
  );
  const [doneAudio, setDoneAudio] = useState<AudioSettings>(
    initial?.done_audio ?? { ...emptyAudio(), soundType: "chime" }
  );

  const handleSave = () => {
    const split: TabataSplit = {
      id: initial?.id ?? newSplitId(),
      name: name.trim() || "Split",
      warmup_seconds: Math.max(0, warmup),
      rounds: Math.max(1, parseInt(rounds) || 1),
      cycles: Math.max(1, parseInt(cycles) || 1),
      on_seconds: Math.max(1, on),
      off_seconds: Math.max(0, off),
      cooldown_seconds: Math.max(0, cooldown),
      warmup_color: warmupColor,
      on_color: onColor,
      off_color: offColor,
      cooldown_color: cooldownColor,
      warmup_audio: warmupAudio,
      on_audio: onAudio,
      off_audio: offAudio,
      cooldown_audio: cooldownAudio,
      done_audio: doneAudio,
    };
    onSave(split);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground text-sm">← Back</button>
        <h3 className="font-semibold text-base">{initial ? "Edit Split" : "New Split"}</h3>
      </div>

      {/* Basic fields */}
      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full h-9 px-3 border rounded-md text-sm mt-0.5"
          />
        </div>

        {/* Duration fields use h/m/s drum pickers; Cycles stays a number input */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">Warmup</label>
            <DurationPicker
              value={warmup / 60}
              onChange={(mins) => setWarmup(Math.round(mins * 60))}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">Rounds</label>
            <input
              type="number"
              min={1}
              value={rounds}
              onChange={(e) => setRounds(e.target.value)}
              className="block w-full h-10 px-3 border rounded-md text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">Cycles / Round</label>
            <input
              type="number"
              min={1}
              value={cycles}
              onChange={(e) => setCycles(e.target.value)}
              className="block w-full h-10 px-3 border rounded-md text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">On</label>
            <DurationPicker
              value={on / 60}
              onChange={(mins) => setOn(Math.max(1, Math.round(mins * 60)))}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">Off</label>
            <DurationPicker
              value={off / 60}
              onChange={(mins) => setOff(Math.round(mins * 60))}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">Cooldown</label>
            <DurationPicker
              value={cooldown / 60}
              onChange={(mins) => setCooldown(Math.round(mins * 60))}
            />
          </div>
        </div>
      </div>

      {/* Colors */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">Phase Colors</p>
        <div className="flex gap-4 flex-wrap">
          {[
            { label: "Warmup", value: warmupColor, onChange: setWarmupColor },
            { label: "On", value: onColor, onChange: setOnColor },
            { label: "Off", value: offColor, onChange: setOffColor },
            { label: "Cooldown", value: cooldownColor, onChange: setCooldownColor },
          ].map(({ label, value, onChange }) => (
            <label key={label} className="flex flex-col items-center gap-1 cursor-pointer text-xs text-muted-foreground">
              <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0.5"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Audio */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Audio</p>
        <AudioRow label="Warmup" value={warmupAudio} onChange={setWarmupAudio} />
        <AudioRow label="On" value={onAudio} onChange={setOnAudio} />
        <AudioRow label="Off" value={offAudio} onChange={setOffAudio} />
        <AudioRow label="Cooldown" value={cooldownAudio} onChange={setCooldownAudio} />
        <AudioRow label="Done" value={doneAudio} onChange={setDoneAudio} />
      </div>

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSave}>Save</Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Splits List View ─────────────────────────────────────────────────────────

function SplitsView({
  splits,
  onEdit,
  onDelete,
  onCopy,
  onNew,
  onBack,
  onImport,
  onExport,
  onReorder,
}: {
  splits: TabataSplit[];
  onEdit: (split: TabataSplit) => void;
  onDelete: (id: string) => void;
  onCopy: (split: TabataSplit) => void;
  onNew: () => void;
  onBack: () => void;
  onImport: (json: string) => void;
  onExport: () => void;
  onReorder: (from: number, to: number) => void;
}) {
  const importRef = useRef<HTMLInputElement>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === "string") onImport(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleDragEnd = () => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      onReorder(dragIndex, dragOverIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm">← Back</button>
          <h3 className="font-semibold text-base">Manage Splits</h3>
        </div>
        <Button size="sm" onClick={onNew}>+ New</Button>
      </div>

      <div className="space-y-2">
        {splits.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No splits saved.</p>
        )}
        {splits.map((split, index) => {
          const isDragging = dragIndex === index;
          const isOver = dragOverIndex === index && dragIndex !== index;
          return (
            <div
              key={split.id}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnter={() => setDragOverIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDragEnd={handleDragEnd}
              className={`flex items-center justify-between border rounded-lg px-3 py-2 gap-2 transition-opacity ${
                isDragging ? "opacity-40" : "opacity-100"
              } ${isOver ? "border-primary border-2" : "border-border"}`}
            >
              <span className="text-muted-foreground cursor-grab select-none text-lg shrink-0" title="Drag to reorder">⠿</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{split.name}</p>
                <p className="text-xs text-muted-foreground truncate">{splitSummary(split)}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                {deletingId === split.id ? (
                  <>
                    <span className="text-xs text-muted-foreground self-center">Delete?</span>
                    <button
                      type="button"
                      onClick={() => { onDelete(split.id); setDeletingId(null); }}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted text-destructive"
                    >Yes</button>
                    <button
                      type="button"
                      onClick={() => setDeletingId(null)}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted"
                    >No</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => onCopy(split)} className="text-xs px-2 py-1 rounded border hover:bg-muted" title="Duplicate">Copy</button>
                    <button type="button" onClick={() => onEdit(split)} className="text-xs px-2 py-1 rounded border hover:bg-muted">Edit</button>
                    <button
                      type="button"
                      onClick={() => setDeletingId(split.id)}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted text-destructive"
                    >Delete</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 border-t pt-3">
        <Button variant="outline" size="sm" onClick={onExport}>Export JSON</Button>
        <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>Import JSON</Button>
        <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileImport} />
      </div>
    </div>
  );
}

// ─── Count-up helpers ─────────────────────────────────────────────────────────

function newPresetId(): string {
  return `cu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function cuPresetSummary(p: CountUpPreset): string {
  const parts: string[] = [];
  if (p.goal_seconds > 0) parts.push(`Goal: ${formatMS(p.goal_seconds)}`);
  if (p.interval_seconds > 0) parts.push(`Dings every ${p.interval_seconds}s`);
  if (parts.length === 0) return "No goal · No dings";
  return parts.join(" · ");
}

// ─── CountUpPresetEditor ──────────────────────────────────────────────────────

const INTERVAL_OPTIONS = [
  { label: "None", value: 0 },
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "2m", value: 120 },
  { label: "Custom", value: -1 },
];

function CountUpPresetEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: CountUpPreset | null;
  onSave: (p: CountUpPreset) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "New Preset");
  const [goal, setGoal] = useState(initial?.goal_seconds ?? 60);

  const initInterval = initial?.interval_seconds ?? 15;
  const isKnownInterval = INTERVAL_OPTIONS.some((o) => o.value === initInterval);
  const [intervalOption, setIntervalOption] = useState<number>(
    isKnownInterval ? initInterval : -1
  );
  const [customInterval, setCustomInterval] = useState(
    isKnownInterval ? 30 : initInterval
  );

  const [intervalAudio, setIntervalAudio] = useState<AudioSettings>(
    initial?.interval_audio ?? { enabled: true, soundType: "tone", frequency: 880, oscType: "sine" }
  );
  const [goalAudio, setGoalAudio] = useState<AudioSettings>(
    initial?.goal_audio ?? { enabled: true, soundType: "chime", frequency: 660, oscType: "sine" }
  );

  const intervalSeconds = intervalOption === -1 ? customInterval : intervalOption;

  const handleSave = () => {
    const preset: CountUpPreset = {
      id: initial?.id ?? newPresetId(),
      name: name.trim() || "Preset",
      goal_seconds: Math.max(0, goal),
      interval_seconds: Math.max(0, intervalSeconds),
      interval_audio: intervalAudio,
      goal_audio: goalAudio,
    };
    onSave(preset);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground text-sm">← Back</button>
        <h3 className="font-semibold text-base">{initial ? "Edit Preset" : "New Preset"}</h3>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full h-9 px-3 border rounded-md text-sm mt-0.5"
          />
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-0.5">Goal (0 = no goal)</label>
          <DurationPicker
            value={goal / 60}
            onChange={(mins) => setGoal(Math.round(mins * 60))}
          />
          {goal === 0 && (
            <p className="text-xs text-muted-foreground mt-1">No goal — timer runs indefinitely</p>
          )}
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-0.5">Interval dings</label>
          <select
            value={intervalOption}
            onChange={(e) => setIntervalOption(Number(e.target.value))}
            className="w-full h-9 text-sm border rounded-md px-2 bg-background"
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {intervalOption === -1 && (
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={customInterval}
                onChange={(e) => setCustomInterval(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-24 h-9 px-3 border rounded-md text-sm"
              />
              <span className="text-sm text-muted-foreground">seconds</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Audio</p>
        <AudioRow
          label="Interval"
          value={intervalAudio}
          onChange={setIntervalAudio}
        />
        <div style={{ opacity: goal === 0 ? 0.4 : 1 }}>
          <AudioRow
            label="Goal"
            value={goalAudio}
            onChange={setGoalAudio}
          />
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSave}>Save</Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── CountUpPresetsView ───────────────────────────────────────────────────────

function CountUpPresetsView({
  presets,
  onEdit,
  onDelete,
  onCopy,
  onNew,
  onBack,
  onImport,
  onExport,
  onReorder,
}: {
  presets: CountUpPreset[];
  onEdit: (p: CountUpPreset) => void;
  onDelete: (id: string) => void;
  onCopy: (p: CountUpPreset) => void;
  onNew: () => void;
  onBack: () => void;
  onImport: (json: string) => void;
  onExport: () => void;
  onReorder: (from: number, to: number) => void;
}) {
  const importRef = useRef<HTMLInputElement>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === "string") onImport(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleDragEnd = () => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      onReorder(dragIndex, dragOverIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm">← Back</button>
          <h3 className="font-semibold text-base">Manage Presets</h3>
        </div>
        <Button size="sm" onClick={onNew}>+ New</Button>
      </div>

      <div className="space-y-2">
        {presets.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No presets saved.</p>
        )}
        {presets.map((preset, index) => {
          const isDragging = dragIndex === index;
          const isOver = dragOverIndex === index && dragIndex !== index;
          return (
            <div
              key={preset.id}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnter={() => setDragOverIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDragEnd={handleDragEnd}
              className={`flex items-center justify-between border rounded-lg px-3 py-2 gap-2 transition-opacity ${
                isDragging ? "opacity-40" : "opacity-100"
              } ${isOver ? "border-primary border-2" : "border-border"}`}
            >
              <span className="text-muted-foreground cursor-grab select-none text-lg shrink-0" title="Drag to reorder">⠿</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{preset.name}</p>
                <p className="text-xs text-muted-foreground truncate">{cuPresetSummary(preset)}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                {deletingId === preset.id ? (
                  <>
                    <span className="text-xs text-muted-foreground self-center">Delete?</span>
                    <button
                      type="button"
                      onClick={() => { onDelete(preset.id); setDeletingId(null); }}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted text-destructive"
                    >Yes</button>
                    <button
                      type="button"
                      onClick={() => setDeletingId(null)}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted"
                    >No</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => onCopy(preset)} className="text-xs px-2 py-1 rounded border hover:bg-muted" title="Duplicate">Copy</button>
                    <button type="button" onClick={() => onEdit(preset)} className="text-xs px-2 py-1 rounded border hover:bg-muted">Edit</button>
                    <button
                      type="button"
                      onClick={() => setDeletingId(preset.id)}
                      className="text-xs px-2 py-1 rounded border hover:bg-muted text-destructive"
                    >Delete</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 border-t pt-3">
        <Button variant="outline" size="sm" onClick={onExport}>Export JSON</Button>
        <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>Import JSON</Button>
        <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileImport} />
      </div>
    </div>
  );
}

// ─── CountUpTab ────────────────────────────────────────────────────────────────

function CountUpTab({
  timer,
  onManagePresets,
}: {
  timer: WorkoutTimerState;
  onManagePresets: () => void;
}) {
  // Local preset selection — null means "show preset list"
  const [activePreset, setActivePreset] = useState<CountUpPreset | null>(
    timer.cuSelectedPreset
  );

  // Sync if hook preset changes externally (e.g. restored from storage on mount)
  useEffect(() => {
    if (timer.cuSelectedPreset && !activePreset) {
      setActivePreset(timer.cuSelectedPreset);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer.cuSelectedPreset]);

  const goalReachedEdgeRef = useRef(false);
  const [flashActive, setFlashActive] = useState(false);

  useEffect(() => {
    if (timer.cuGoalReached && !goalReachedEdgeRef.current) {
      goalReachedEdgeRef.current = true;
      setFlashActive(true);
      setTimeout(() => setFlashActive(false), 1500);
    }
    if (!timer.cuGoalReached) {
      goalReachedEdgeRef.current = false;
      setFlashActive(false);
    }
  }, [timer.cuGoalReached]);

  const elapsed = Math.floor(timer.cuElapsed);

  const handleSelectPreset = (p: CountUpPreset) => {
    timer.cuSelectPreset(p);
    setActivePreset(p);
  };

  const handleChooseDifferent = () => {
    timer.cuReset();
    setActivePreset(null);
  };

  // ── Idle — no preset selected ────────────────────────────────────────────────
  if (!activePreset) {
    return (
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          {timer.cuPresets.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No presets. Create one via Manage Presets.
            </p>
          )}
          {timer.cuPresets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleSelectPreset(p)}
              className="w-full text-left border rounded-lg px-3 py-2.5 transition-colors border-border hover:bg-muted active:bg-muted"
            >
              <p className="text-sm font-medium">{p.name}</p>
              <p className="text-xs text-muted-foreground">{cuPresetSummary(p)}</p>
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onManagePresets}
            className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            Manage Presets →
          </button>
        </div>
      </div>
    );
  }

  // ── Running or paused (preset selected) ─────────────────────────────────────
  const goal = activePreset.goal_seconds;
  const fillPct = goal > 0 ? Math.min(100, (elapsed / goal) * 100) : 0;
  const boxColor = "#3b82f6";
  const isRunning = timer.cuRunning;

  const handleBoxClick = () => {
    if (!isRunning && elapsed === 0) {
      timer.cuStart();
    } else if (isRunning) {
      timer.cuPause();
    } else {
      timer.cuResume();
    }
  };

  const hint = !isRunning && elapsed === 0
    ? "Tap to start"
    : isRunning
    ? "Tap to pause"
    : "Tap to resume";

  return (
    <div className="flex flex-col gap-3 py-2">
      <p className="text-sm text-center text-muted-foreground font-medium">{activePreset.name}</p>

      <div
        role="button"
        tabIndex={0}
        aria-label={hint}
        onClick={handleBoxClick}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") handleBoxClick(); }}
        className="relative rounded-xl flex flex-col items-center justify-center py-8 gap-2 cursor-pointer select-none overflow-hidden"
        style={{
          backgroundColor: boxColor + "22",
          borderColor: boxColor + "66",
          borderWidth: 2,
          animation: flashActive ? "goal-flash 1.2s ease-in-out forwards" : undefined,
        }}
      >
        {/* Fill bar */}
        {fillPct > 0 && (
          <div
            className="absolute inset-y-0 left-0 transition-all duration-500 pointer-events-none"
            style={{ width: `${fillPct}%`, backgroundColor: boxColor + "30" }}
          />
        )}

        <div
          className="relative z-10 font-mono text-5xl font-bold tabular-nums tracking-tight"
          style={{ color: boxColor }}
        >
          {formatHMS(elapsed)}
        </div>

        {goal > 0 && (
          <div className="relative z-10 text-sm font-medium" style={{ color: boxColor + "cc" }}>
            {timer.cuGoalReached ? "Goal reached!" : `Goal: ${formatMS(goal)}`}
          </div>
        )}

        {activePreset.interval_seconds > 0 && (
          <div className="relative z-10 text-xs text-muted-foreground">
            Dings every {activePreset.interval_seconds}s
          </div>
        )}

        <div className="relative z-10 text-xs mt-1" style={{ color: boxColor + "99" }}>
          {hint}
        </div>
      </div>

      <div className="flex gap-2 justify-center items-center">
        {isRunning ? (
          <Button onClick={timer.cuPause} variant="outline" className="w-28">Pause</Button>
        ) : elapsed > 0 ? (
          <Button onClick={timer.cuResume} className="w-28">Resume</Button>
        ) : (
          <Button onClick={timer.cuStart} className="w-28">Start</Button>
        )}
        <Button onClick={timer.cuReset} variant="ghost" size="sm">Reset</Button>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleChooseDifferent}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          ← Choose different preset
        </button>
      </div>
    </div>
  );
}

// ─── StopwatchBox ─────────────────────────────────────────────────────────────
// Reusable stopwatch display used both in StopwatchTab and inside TabataTab.

function StopwatchBox({
  timer,
  onSendToWorkout,
}: {
  timer: WorkoutTimerState;
  onSendToWorkout?: (seconds: number) => void;
}) {
  const [sent, setSent] = useState(false);
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSend = () => {
    if (!onSendToWorkout) return;
    onSendToWorkout(timer.swDisplay);
    setSent(true);
    if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    sentTimerRef.current = setTimeout(() => setSent(false), 2000);
  };

  const swToggle = timer.swRunning ? timer.swPause : timer.swStart;
  const swHint = timer.swRunning
    ? "Tap to pause"
    : timer.swDisplay > 0
    ? "Tap to resume"
    : "Tap to start";

  // Measure the container to build the rounded-rect SVG path for the comet
  const boxRef = useRef<HTMLDivElement>(null);
  const [cometPath, setCometPath] = useState("");

  useEffect(() => {
    if (!timer.swRunning || !boxRef.current) return;
    // Use clientWidth/clientHeight: absolute children live in the padding-box coordinate
    // system (border excluded). getBoundingClientRect includes the 2px border, pushing
    // the right/bottom path segments outside overflow:hidden and making them invisible.
    const w = boxRef.current.clientWidth;
    const h = boxRef.current.clientHeight;
    if (w === 0) return;
    // Path 3px inside the padding edge so the 3px-tall comet stays within overflow:hidden
    const s = 3;
    const r = 8;
    setCometPath(
      `M ${s + r},${s} H ${w - s - r} Q ${w - s},${s} ${w - s},${s + r}` +
      ` V ${h - s - r} Q ${w - s},${h - s} ${w - s - r},${h - s}` +
      ` H ${s + r} Q ${s},${h - s} ${s},${h - s - r}` +
      ` V ${s + r} Q ${s},${s} ${s + r},${s} Z`
    );
  }, [timer.swRunning]);

  return (
    <>
      <div
        ref={boxRef}
        role="button"
        tabIndex={0}
        aria-label={swHint}
        onClick={swToggle}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") swToggle(); }}
        className="relative rounded-xl flex flex-col items-center justify-center py-4 gap-1 cursor-pointer select-none overflow-hidden w-full"
        style={{ backgroundColor: "#6b728018", borderColor: "#6b728044", borderWidth: 2 }}
      >
        {/* Single comet following the rounded-rect border via CSS Motion Path */}
        {timer.swRunning && cometPath && (
          <div
            className="pointer-events-none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: 64,
              height: 3,
              borderRadius: 2,
              background: "linear-gradient(90deg, transparent, rgba(148,163,184,0.95), transparent)",
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              offsetPath: `path('${cometPath}')`,
              offsetDistance: "0%",
              offsetRotate: "auto",
              offsetAnchor: "50% 50%",
              animation: "border-trip 1s linear infinite",
            } as React.CSSProperties}
          />
        )}
        <div className="relative z-10 font-mono text-5xl font-bold tabular-nums tracking-tight text-muted-foreground">
          {formatHMS(timer.swDisplay)}
        </div>
        <div className="relative z-10 text-xs text-muted-foreground uppercase tracking-widest">
          {swHint}
        </div>
      </div>
      {(timer.swStartTime || timer.swPauseTime) && (
        <div className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground">
          {timer.swStartTime && (
            <span>Started: {timer.swStartTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
          )}
          {timer.swPauseTime && (
            <span>Paused: {timer.swPauseTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
          )}
        </div>
      )}
      {timer.swDisplay > 0 && (
        <div className="flex justify-center gap-2">
          <Button variant="ghost" size="sm" onClick={timer.swReset} className="text-xs text-muted-foreground">
            Reset Stopwatch
          </Button>
          {onSendToWorkout && (
            <Button
              variant={sent ? "default" : "secondary"}
              size="sm"
              className={`text-xs transition-colors duration-200 ${sent ? "bg-green-600 hover:bg-green-600 text-white" : ""}`}
              onClick={handleSend}
            >
              {sent ? "✓ Sent" : "Send to Workout Duration"}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

// ─── Stopwatch Tab ─────────────────────────────────────────────────────────────

function StopwatchTab({
  timer,
  onSendToWorkout,
}: {
  timer: WorkoutTimerState;
  onSendToWorkout?: (seconds: number) => void;
}) {
  return (
    <div className="flex flex-col gap-4 py-4">
      {/* StopwatchBox — tappable display with chase animation + Reset button */}
      <StopwatchBox timer={timer} onSendToWorkout={onSendToWorkout} />
      <div className="flex gap-3 justify-center">
        {!timer.swRunning ? (
          <Button onClick={timer.swStart} className="w-28">
            {timer.swDisplay > 0 ? "Resume" : "Start"}
          </Button>
        ) : (
          <Button onClick={timer.swPause} variant="outline" className="w-28">Pause</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground text-center max-w-xs">
        Keeps running when the panel is closed.
      </p>
    </div>
  );
}

// ─── Tabata Tab ────────────────────────────────────────────────────────────────

function TabataTab({
  timer,
  onManageSplits,
  onSendToWorkout,
}: {
  timer: WorkoutTimerState;
  onManageSplits: () => void;
  onSendToWorkout?: (seconds: number) => void;
}) {
  // Local state: split selected but timer not yet started
  const [pendingSplit, setPendingSplit] = useState<TabataSplit | null>(null);

  // Cycle progress fill toggle — persisted to localStorage
  const [showCycleProgress, setShowCycleProgress] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return localStorage.getItem("timer_cycle_progress") !== "false"; } catch { return true; }
  });
  const toggleProgress = () => {
    setShowCycleProgress((prev) => {
      const next = !prev;
      try { localStorage.setItem("timer_cycle_progress", String(next)); } catch {}
      return next;
    });
  };

  // Screen-off audio — persisted in the hook (it owns the audio route).
  // On = sounds survive a long quiet block with the screen off, but Android
  // hands audio focus to us and pauses music in other apps.
  const [screenOffAudio, setScreenOffAudio] = useState(isScreenOffAudioEnabled);
  const toggleScreenOffAudio = () => {
    const next = !screenOffAudio;
    setScreenOffAudio(next);
    setScreenOffAudioEnabled(next); // called from a click = valid user gesture
  };

  const { tabPhase, tabRunning, tabSelectedSplit, tabPhaseRemaining, tabCurrentCycle } = timer;

  // Fill fraction: completed work cycles + progress through current "on" phase
  const totalWorkCycles = Math.max(1, (tabSelectedSplit?.rounds ?? 1) * (tabSelectedSplit?.cycles ?? 1));
  const completedFraction = timer.tabCompletedWorkCycles / totalWorkCycles;
  const inProgressFraction = tabPhase === "on" && tabSelectedSplit
    ? (1 - tabPhaseRemaining / Math.max(1, tabSelectedSplit.on_seconds)) / totalWorkCycles
    : 0;
  const fillPct = Math.min(100, (completedFraction + inProgressFraction) * 100);
  const isActive = tabPhase !== "idle" && tabPhase !== "done";
  const isDone = tabPhase === "done";
  const color = phaseColor(tabPhase, tabSelectedSplit);

  const handleSelectSplit = (split: TabataSplit) => {
    timer.tabSelectSplit(split);
    setPendingSplit(split);
  };

  const handleStart = () => {
    setPendingSplit(null);
    timer.tabStart();
  };

  const handleChooseDifferent = () => {
    setPendingSplit(null);
    timer.tabReset();
  };

  // Reset HIIT timer but stay on the ready screen for the same split
  const handleReset = () => {
    setPendingSplit(tabSelectedSplit);
    timer.tabReset();
  };

  // ── Idle — split selector ────────────────────────────────────────────────────
  if (tabPhase === "idle" && !tabRunning && !pendingSplit) {
    return (
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          {timer.splits.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No splits. Create one via Manage Splits.
            </p>
          )}
          {timer.splits.map((split) => (
            <button
              key={split.id}
              type="button"
              onClick={() => handleSelectSplit(split)}
              className="w-full text-left border rounded-lg px-3 py-2.5 transition-colors border-border hover:bg-muted active:bg-muted"
            >
              <p className="text-sm font-medium">{split.name}</p>
              <p className="text-xs text-muted-foreground">{splitSummary(split)}</p>
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onManageSplits}
            className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            Manage Splits →
          </button>
        </div>
      </div>
    );
  }

  // ── Ready — split selected, not yet started ──────────────────────────────────
  if (tabPhase === "idle" && pendingSplit) {
    const firstPhase = pendingSplit.warmup_seconds > 0 ? "warmup" : "on";
    const firstDuration = pendingSplit.warmup_seconds > 0 ? pendingSplit.warmup_seconds : pendingSplit.on_seconds;
    const readyColor = firstPhase === "warmup" ? pendingSplit.warmup_color : pendingSplit.on_color;
    const readyLabel = firstPhase === "warmup" ? "Warmup" : "Go!";

    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-center text-muted-foreground font-medium">{pendingSplit.name}</p>
        {/* Tap to start */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Tap to start"
          onClick={handleStart}
          onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") handleStart(); }}
          className="rounded-xl flex flex-col items-center justify-center py-8 gap-2 cursor-pointer select-none"
          style={{ backgroundColor: readyColor + "22", borderColor: readyColor + "66", borderWidth: 2 }}
        >
          <div className="text-5xl font-mono font-bold tabular-nums tracking-tight" style={{ color: readyColor }}>
            {formatMS(firstDuration)}
          </div>
          <div className="text-xl font-semibold" style={{ color: readyColor }}>{readyLabel}</div>
          <div className="text-xs mt-1" style={{ color: readyColor + "99" }}>Tap to start</div>
        </div>
        <div className="flex gap-3 justify-center">
          <Button onClick={handleStart} className="w-28">Start</Button>
          <Button variant="ghost" onClick={() => setPendingSplit(null)}>← Back</Button>
        </div>

        {/* Screen-off audio opt-in — see the audio-focus note in useWorkoutTimer */}
        <label className="flex items-start gap-2 px-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={screenOffAudio}
            onChange={toggleScreenOffAudio}
            className="mt-0.5 shrink-0"
          />
          <span className="text-xs text-muted-foreground leading-snug">
            Keep sounds alive with screen off
            <span className="block opacity-70">
              Needed for long quiet blocks, but pauses music in other apps.
            </span>
          </span>
        </label>

        {/* Stopwatch — visible on ready screen too */}
        <StopwatchBox timer={timer} onSendToWorkout={onSendToWorkout} />
      </div>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  if (isDone) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 w-full">
        <div className="text-4xl font-bold">Done ✓</div>
        <p className="text-sm text-muted-foreground">{tabSelectedSplit?.name}</p>
        {/* HIIT action buttons — above the stopwatch so they're clearly HIIT-related */}
        <div className="flex gap-3">
          <Button onClick={handleReset}>Repeat</Button>
          <Button variant="outline" onClick={handleChooseDifferent}>Choose Different</Button>
        </div>
        {/* Stopwatch */}
        <StopwatchBox timer={timer} onSendToWorkout={onSendToWorkout} />
      </div>
    );
  }

  // ── Active / Paused ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Phase block — tap to pause/resume */}
      <div
        role="button"
        tabIndex={0}
        aria-label={tabRunning ? "Tap to pause" : "Tap to resume"}
        onClick={tabRunning ? timer.tabPause : timer.tabResume}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            tabRunning ? timer.tabPause() : timer.tabResume();
          }
        }}
        className="relative rounded-xl flex flex-col items-center justify-center py-8 gap-2 transition-colors duration-300 cursor-pointer select-none overflow-hidden"
        style={{ backgroundColor: color + "22", borderColor: color + "66", borderWidth: 2 }}
      >
        {/* Horizontal fill — work cycle progress */}
        {showCycleProgress && (
          <div
            className="absolute inset-y-0 left-0 transition-all duration-500 pointer-events-none"
            style={{ width: `${fillPct}%`, backgroundColor: color + "30" }}
          />
        )}

        {/* Content */}
        <div className="relative z-10 text-5xl font-mono font-bold tabular-nums tracking-tight" style={{ color }}>
          {formatMS(tabPhaseRemaining)}
        </div>
        <div className="relative z-10 text-xl font-semibold" style={{ color }}>
          {phaseLabel(tabPhase)}
        </div>
        {isActive && tabSelectedSplit && tabPhase !== "warmup" && tabPhase !== "cooldown" && (
          <div className="relative z-10 text-sm text-muted-foreground">
            {(() => {
              const rounds = tabSelectedSplit.rounds ?? 1;
              const cyclesPerRound = tabSelectedSplit.cycles;
              if (rounds > 1) {
                const cycleInRound = ((tabCurrentCycle - 1) % cyclesPerRound) + 1;
                const currentRound = Math.ceil(tabCurrentCycle / cyclesPerRound);
                return `Round ${currentRound}/${rounds} · Cycle ${cycleInRound}/${cyclesPerRound}`;
              }
              return `Cycle ${tabCurrentCycle} / ${cyclesPerRound}`;
            })()}
          </div>
        )}
        <div className="relative z-10 text-xs mt-1" style={{ color: color + "99" }}>
          {tabRunning ? "Tap to pause" : "Tap to resume"}
        </div>

        {/* 3-2-1 charge bar — sweeps left→right over 1s on each countdown beep */}
        {tabPhaseRemaining <= 3 && tabPhaseRemaining > 0 && tabPhase !== "idle" && (
          <div
            key={`charge-${tabPhaseRemaining}`}
            className="absolute bottom-0 left-0 w-full h-1 pointer-events-none"
            style={{
              background: `linear-gradient(90deg, ${color}88, ${color})`,
              animation: "charge-sweep 1s linear forwards",
              transformOrigin: "left",
            }}
          />
        )}

        {/* Cycle progress toggle — top-right corner */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleProgress(); }}
          className="absolute top-2 right-2 z-20 w-6 h-6 flex items-center justify-center text-sm opacity-40 hover:opacity-90 transition-opacity"
          title={showCycleProgress ? "Hide cycle progress" : "Show cycle progress"}
        >
          {showCycleProgress ? "⊙" : "⊗"}
        </button>
      </div>

      {/* Controls row */}
      <div className="flex gap-2 justify-center items-center">
        <button
          type="button"
          onClick={timer.tabPrevPhase}
          className="w-10 h-10 rounded-full border flex items-center justify-center text-lg hover:bg-muted"
          title="Previous section"
        >
          ⏮
        </button>
        {tabRunning ? (
          <Button onClick={timer.tabPause} variant="outline" className="w-28">Pause</Button>
        ) : (
          <Button onClick={timer.tabResume} className="w-28">Resume</Button>
        )}
        <button
          type="button"
          onClick={timer.tabNextPhase}
          className="w-10 h-10 rounded-full border flex items-center justify-center text-lg hover:bg-muted"
          title="Next section"
        >
          ⏭
        </button>
        <Button onClick={handleReset} variant="ghost" size="sm">Reset</Button>
      </div>

      {/* Stopwatch */}
      <StopwatchBox timer={timer} onSendToWorkout={onSendToWorkout} />
    </div>
  );
}

// ─── FAB ──────────────────────────────────────────────────────────────────────

export function WorkoutTimerFAB({
  timer,
  onClick,
  bottomClass = "bottom-6",
}: {
  timer: WorkoutTimerState;
  onClick: () => void;
  bottomClass?: string;
}) {
  return (
    <div className={`fixed ${bottomClass} right-6 z-40 flex flex-col items-end gap-1`}>
      {timer.swRunning && (
        <div className="text-xs font-mono bg-background border rounded px-2 py-0.5 shadow tabular-nums">
          {formatHMS(timer.swDisplay)}
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        className="relative w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center text-2xl hover:bg-primary/90 transition-colors"
        title="Workout Timer"
      >
        ⏱
        {timer.anyRunning && (
          <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-background" />
        )}
      </button>
    </div>
  );
}

// ─── Main Sheet ───────────────────────────────────────────────────────────────

type InternalView = "main" | "splits" | "editor" | "cu-presets" | "cu-editor";

export function WorkoutTimerSheet({
  timer,
  open,
  onOpenChange,
  onSendToWorkout,
}: {
  timer: WorkoutTimerState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendToWorkout?: (seconds: number) => void;
}) {
  const [view, setView] = useState<InternalView>("main");
  const [editingSplit, setEditingSplit] = useState<TabataSplit | null>(null);
  const [editingPreset, setEditingPreset] = useState<CountUpPreset | null>(null);
  const [activeTab, setActiveTab] = useState("stopwatch");

  const handleExport = () => {
    const json = timer.exportSplits();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workout-splits.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveSplit = (split: TabataSplit) => {
    timer.saveSplit(split);
    setView("splits");
    setEditingSplit(null);
  };

  const handleCopySplit = (split: TabataSplit) => {
    const copy: TabataSplit = {
      ...split,
      id: newSplitId(),
      name: `${split.name} (copy)`,
    };
    timer.saveSplit(copy);
  };

  const goBackToTabata = () => {
    setView("main");
    setActiveTab("tabata");
  };

  const handleExportPresets = () => {
    const json = timer.cuExportPresets();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "countup-presets.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSavePreset = (preset: CountUpPreset) => {
    timer.cuSavePreset(preset);
    setView("cu-presets");
    setEditingPreset(null);
  };

  const handleCopyPreset = (preset: CountUpPreset) => {
    const copy: CountUpPreset = {
      ...preset,
      id: newPresetId(),
      name: `${preset.name} (copy)`,
    };
    timer.cuSavePreset(copy);
  };

  const goBackToCountUp = () => {
    setView("main");
    setActiveTab("countup");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] overflow-y-auto">
        <SheetTitle className="sr-only">Workout Timer</SheetTitle>

        {view === "editor" && (
          <SplitEditor
            initial={editingSplit}
            onSave={handleSaveSplit}
            onCancel={() => { setView("splits"); setEditingSplit(null); }}
          />
        )}

        {view === "splits" && (
          <SplitsView
            splits={timer.splits}
            onEdit={(split) => { setEditingSplit(split); setView("editor"); }}
            onDelete={timer.deleteSplit}
            onCopy={handleCopySplit}
            onNew={() => { setEditingSplit(null); setView("editor"); }}
            onBack={goBackToTabata}
            onImport={timer.importSplits}
            onExport={handleExport}
            onReorder={timer.reorderSplits}
          />
        )}

        {view === "cu-editor" && (
          <CountUpPresetEditor
            initial={editingPreset}
            onSave={handleSavePreset}
            onCancel={() => { setView("cu-presets"); setEditingPreset(null); }}
          />
        )}

        {view === "cu-presets" && (
          <CountUpPresetsView
            presets={timer.cuPresets}
            onEdit={(preset) => { setEditingPreset(preset); setView("cu-editor"); }}
            onDelete={timer.cuDeletePreset}
            onCopy={handleCopyPreset}
            onNew={() => { setEditingPreset(null); setView("cu-editor"); }}
            onBack={goBackToCountUp}
            onImport={timer.cuImportPresets}
            onExport={handleExportPresets}
            onReorder={timer.cuReorderPresets}
          />
        )}

        {view === "main" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Workout Timer</h2>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full">
                <TabsTrigger value="stopwatch" className="flex-1">Stopwatch</TabsTrigger>
                <TabsTrigger value="tabata" className="flex-1">HIIT</TabsTrigger>
                <TabsTrigger value="countup" className="flex-1">Count-up</TabsTrigger>
              </TabsList>
              <TabsContent value="stopwatch">
                <StopwatchTab timer={timer} onSendToWorkout={onSendToWorkout} />
              </TabsContent>
              <TabsContent value="tabata">
                <TabataTab
                  timer={timer}
                  onManageSplits={() => setView("splits")}
                  onSendToWorkout={onSendToWorkout}
                />
              </TabsContent>
              <TabsContent value="countup">
                <CountUpTab
                  timer={timer}
                  onManagePresets={() => setView("cu-presets")}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
