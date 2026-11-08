"use client";

import * as React from "react";
import { AlertCircle, Loader2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { InfoHint } from "@/components/api/field-row";
import {
  GROK_FRAME_ROLE_CHOICES,
  type GrokFrameRole,
  type GrokFrameRoleName,
  type GrokSourceVideo,
  type GrokVideoOptions,
} from "@/lib/grok-imagine";
import type { GrokVideoMode, GrokVideoModelId } from "@/lib/api-models";
import { videoPosterIfAvailable, videoUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";

/**
 * The Grok video controls that have no counterpart on the other providers:
 * the mode (Generate, Edit, Extend), Generate's model choice, each image's
 * role on 1.5, and the source clip for Edit and Extend. Every rule they show
 * comes from `grokVideoOptions` in packages/shared/grok-imagine.ts — these only
 * draw it, so the native client can draw the same thing from the same call.
 */

const MODE_HINTS: Record<GrokVideoMode, string> = {
  generate: "A new clip from the prompt, and any images you attach.",
  edit: "Changes a clip of up to 8.7 s and keeps its length, shape and resolution (up to 720p). Say what must stay the same.",
  extend:
    "Continues a 2–15 s clip from its last frame. The result is the clip plus the added seconds, at up to 720p.",
};

export function GrokVideoModeRow({
  options,
  mode,
  model,
  onModeChange,
  onModelChange,
  modelPrice,
}: {
  options: GrokVideoOptions;
  mode: GrokVideoMode;
  model: GrokVideoModelId;
  onModeChange: (mode: GrokVideoMode) => void;
  onModelChange: (model: GrokVideoModelId) => void;
  /** Inline quota per model, already formatted; null hides it. */
  modelPrice: (model: GrokVideoModelId) => string | null;
}) {
  const selected = options.models?.find((entry) => entry.id === model);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label className="text-xs">Mode</Label>
          <InfoHint text={MODE_HINTS[mode]} />
        </div>
        <div role="group" aria-label="Grok video mode" className="flex gap-1.5">
          {options.modes.map((entry) => (
            <Button
              key={entry.value}
              variant={mode === entry.value ? "default" : "outline"}
              size="sm"
              className="h-7 flex-1 text-[11px] font-normal"
              aria-pressed={mode === entry.value}
              onClick={() => onModeChange(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </div>
      {options.models ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label className="text-xs">Video model</Label>
            {selected && <InfoHint text={selected.note} />}
          </div>
          <div role="group" aria-label="Grok video model" className="flex gap-1.5">
            {options.models.map((entry) => {
              const price = modelPrice(entry.id);
              return (
                <Button
                  key={entry.id}
                  variant={model === entry.id ? "default" : "outline"}
                  size="sm"
                  className="h-7 flex-1 text-[11px] font-normal"
                  aria-pressed={model === entry.id}
                  title={entry.note}
                  onClick={() => onModelChange(entry.id)}
                >
                  {entry.label}
                  {price && (
                    <span className="ml-1 text-[10px] tabular-nums opacity-70">{price}</span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <Label className="text-xs">Video model</Label>
          <p className="flex h-7 items-center text-[11px] text-muted-foreground">
            grok-imagine-video — the model that edits and extends
          </p>
        </div>
      )}
    </div>
  );
}

/** One image's role under its thumbnail, and a keyframe's time beside it. */
export function GrokFrameRoleControl({
  role,
  keyframeCount,
  maxKeyframes,
  duration,
  onRoleChange,
  onTimeChange,
}: {
  role: GrokFrameRole;
  keyframeCount: number;
  maxKeyframes: number;
  duration: number;
  onRoleChange: (role: GrokFrameRoleName) => void;
  onTimeChange: (at: number) => void;
}) {
  const atCap = keyframeCount >= maxKeyframes && role.role !== "keyframe";
  return (
    <div className="mt-1 w-20 space-y-0.5">
      <select
        aria-label="What this image does in the clip"
        className="h-6 w-full rounded border bg-card px-1 text-[10px]"
        value={role.role}
        onChange={(event) => onRoleChange(event.target.value as GrokFrameRoleName)}
      >
        {GROK_FRAME_ROLE_CHOICES.map((choice) => (
          <option
            key={choice.role}
            value={choice.role}
            disabled={choice.role === "keyframe" && atCap}
            title={choice.hint}
          >
            {choice.label}
          </option>
        ))}
      </select>
      {role.role === "keyframe" && (
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
          at
          <input
            type="number"
            aria-label="Keyframe time in seconds"
            className="h-6 w-full min-w-0 rounded border bg-card px-1 text-[10px] tabular-nums text-foreground"
            min={0.33}
            max={Math.max(0.33, duration - 0.33)}
            // xAI snaps to a 1/3-second grid itself; any typed time is kept
            // inside the clip by the shared rule.
            step="any"
            title="Seconds into the clip; xAI snaps it to the nearest 1/3 s"
            // Keyed on the stored value so a clamp from outside shows up even
            // while the field is not being edited.
            key={role.at}
            defaultValue={role.at}
            onBlur={(event) => onTimeChange(Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") onTimeChange(Number(event.currentTarget.value));
            }}
          />
          s
        </label>
      )}
    </div>
  );
}

/**
 * The clip an Edit or Extend works on: one of the app's own results (the
 * tiles' "Edit/Extend with Grok") or an uploaded mp4. Previewed muted and
 * paused — nothing here starts sound on its own.
 */
export function GrokSourceVideoSlot({
  source,
  range,
  busy,
  onPick,
  onClear,
}: {
  source: GrokSourceVideo | null;
  range: { min: number; max: number };
  busy: boolean;
  onPick?: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const outside = source !== null && (source.seconds > range.max || source.seconds < range.min);
  const limit = range.min > 0 ? `${range.min}–${range.max} s` : `up to ${range.max} s`;
  return (
    <div
      className={cn(
        "space-y-1 rounded-lg transition-colors",
        dragging && "ring-2 ring-primary bg-primary/5",
      )}
      onDragOver={(event) => {
        if (!onPick) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = [...event.dataTransfer.files].find((candidate) => isMp4File(candidate));
        if (file && onPick) onPick(file);
      }}
    >
      <div className="flex items-center gap-1">
        <Label className="text-xs">Source video</Label>
        <InfoHint
          text={`An mp4 of ${limit}. Use "Edit/Extend with Grok" on any of your clips, or upload one.`}
        />
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {source ? (
          <div className="relative">
            {/* Muted, paused, metadata only: a preview, never a player that
                starts on its own. */}
            <video
              src={videoUrl(source.key)}
              poster={videoPosterIfAvailable(source.key)}
              muted
              playsInline
              controls
              preload="metadata"
              className={cn(
                "h-24 max-w-[12rem] rounded-lg border bg-muted object-contain",
                outside && "border-destructive ring-2 ring-destructive/60",
              )}
            />
            <Button
              variant="destructive"
              size="icon"
              className="absolute -top-2 -right-2 h-5 w-5"
              aria-label="Remove source video"
              onClick={onClear}
            >
              <X className="h-3 w-3" />
            </Button>
            <p
              className={cn(
                "mt-0.5 text-[10px] tabular-nums text-muted-foreground",
                outside && "text-destructive",
              )}
            >
              {source.seconds} s · {source.resolution}
            </p>
          </div>
        ) : null}
        {onPick && (
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
            <span className="text-[10px]">
              {busy ? "Uploading…" : source ? "Replace" : "Upload mp4"}
            </span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,.mp4"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && onPick) onPick(file);
        }}
      />
    </div>
  );
}

export function isMp4File(file: File): boolean {
  return file.type === "video/mp4" || (!file.type && /\.mp4$/i.test(file.name));
}

/** What would stop the click, said before it. */
export function GrokIssues({ issues }: { issues: readonly string[] }) {
  if (issues.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1 text-xs leading-relaxed">
        {issues.map((issue) => (
          <p key={issue}>{issue}</p>
        ))}
      </div>
    </div>
  );
}
