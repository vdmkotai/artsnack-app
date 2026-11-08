"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  badgeOf,
  grokImageWireOf,
  isSelfHostedVideo,
  outputKeys,
  priceOf,
  providerOf,
  qualityLabelOf,
  type GenerationDoc,
} from "@/components/api/generation-meta";
import {
  formatDurationMs,
  outputKeyTimestamp,
  summarizeComfyRun,
  type ComfyRunPhase,
} from "@/lib/comfy-run-stats";
import { H3_FPS, H3_MODES, h3FrameCount, h3NodeStage, normalizeH3Settings } from "@/lib/h3-video";
import {
  LTX_KNOWN_CHECKPOINTS,
  ltxFrameCount,
  ltxUsesDistilledSigmas,
  normalizeLtxSettings,
} from "@/lib/ltx-video";
import { formatUsd } from "@/lib/api-pricing";
import { GROK_FRAME_ROLE_CHOICES } from "@/lib/grok-imagine";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";
import { ReferenceThumb, generationReferences, type Reference } from "@/components/reference-thumb";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium tracking-wider text-white/45 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs" title={title}>
      <dt className="shrink-0 text-white/55">{label}</dt>
      <dd className="min-w-0 text-right break-words text-white/90 tabular-nums">{children}</dd>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      onClick={() => void copyText(text, label).then((ok) => ok && setCopied(true))}
      className="inline-grid h-5 w-5 place-items-center rounded text-white/50 align-middle hover:bg-white/10 hover:text-white"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

const PHASE_COLORS: Record<ComfyRunPhase["key"], string> = {
  prepare: "bg-slate-400",
  queue: "bg-amber-400",
  render: "bg-sky-400",
  save: "bg-emerald-400",
};

function stripExtension(name: string): string {
  return name.replace(/\.safetensors$/, "");
}

function formatGigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

export type RunDetails = {
  gpuType: string;
  gpuName: string;
  gpuCount: number;
  gpuIndex?: number;
  cloudType: "SECURE" | "COMMUNITY";
  hourlyUsd: number;
  podId?: string;
};

/** Where the time went: click → submit → queue → render (by stage) → saved. */
function TimingSection({ generation }: { generation: GenerationDoc }) {
  const stats = generation.comfyRun;
  // Rows finished before `completedAt` existed still have the upload time in
  // their output key, which is close enough for a total.
  const keyTime = outputKeyTimestamp(outputKeys(generation)[0]);
  const completedAt = generation.completedAt ?? keyTime;
  const summary = summarizeComfyRun(
    { createdAt: generation.createdAt, completedAt, stats },
    h3NodeStage,
  );
  if (summary.totalMs === undefined && summary.phases.length === 0) return null;
  const approximate = generation.completedAt === undefined;
  const phaseTotal = summary.phases.reduce((total, phase) => total + phase.ms, 0);
  const render = summary.phases.find((phase) => phase.key === "render");
  const stageTotal = summary.stages.reduce((total, stage) => total + stage.ms, 0);
  const modelsKept = stats?.cachedNodes?.includes("unet");

  return (
    <Section title="Time">
      {summary.totalMs !== undefined && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-white/55">
            {approximate ? "Total, from the upload time" : "Total time"}
          </span>
          <span className="text-base font-semibold tabular-nums">
            {approximate ? "≈ " : ""}
            {formatDurationMs(summary.totalMs)}
          </span>
        </div>
      )}
      {phaseTotal > 0 && (
        <div className="flex h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
          {summary.phases.map((phase) => (
            <div
              key={phase.key}
              className={PHASE_COLORS[phase.key]}
              style={{ width: `${(phase.ms / phaseTotal) * 100}%` }}
            />
          ))}
        </div>
      )}
      {summary.phases.length > 0 && (
        <dl className="space-y-1.5">
          {summary.phases.map((phase) => (
            <div key={phase.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="flex min-w-0 items-center gap-2 text-white/70">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", PHASE_COLORS[phase.key])} />
                  {phase.label}
                </dt>
                <dd className="text-white/90 tabular-nums">{formatDurationMs(phase.ms)}</dd>
              </div>
              {phase.key === "render" && summary.stages.length > 0 && (
                <ul className="ml-4 space-y-1 border-l border-white/10 pl-3">
                  {summary.stages.map((stage) => (
                    <li key={stage.key} className="space-y-0.5">
                      <div className="flex items-baseline justify-between gap-3 text-[11px]">
                        <span className="min-w-0 text-white/60">
                          {stage.label}
                          {stage.steps ? (
                            <span className="text-white/40">
                              {" "}
                              · {stage.steps} steps · {(stage.ms / stage.steps / 1000).toFixed(1)}{" "}
                              s/step
                            </span>
                          ) : null}
                        </span>
                        <span className="text-white/80 tabular-nums">
                          {formatDurationMs(stage.ms)}
                        </span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-white/5" aria-hidden>
                        <div
                          className="h-full rounded-full bg-sky-400/60"
                          style={{
                            width: `${(stage.ms / Math.max(render?.ms ?? 0, stageTotal, 1)) * 100}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </dl>
      )}
      {modelsKept && (
        <p className="text-[11px] text-white/45">
          The model stayed loaded from the previous clip, so nothing was read from disk.
        </p>
      )}
      {isSelfHostedVideo(generation) && !stats && (
        <p className="text-[11px] text-white/45">
          A per-stage breakdown is recorded for clips rendered from this version on.
        </p>
      )}
    </Section>
  );
}

function GpuSection({
  generation,
  pod,
}: {
  generation: GenerationDoc;
  pod: RunDetails | null | undefined;
}) {
  const stats = generation.comfyRun;
  const gpuName = stats?.gpuName ?? pod?.gpuType;
  if (!gpuName && !pod) return null;
  const renderMs =
    stats?.executionStartedAt !== undefined && stats.executionEndedAt !== undefined
      ? Math.max(0, stats.executionEndedAt - stats.executionStartedAt)
      : undefined;
  const perGpuHourly = pod ? pod.hourlyUsd / Math.max(1, pod.gpuCount) : undefined;
  const software = [
    stats?.comfyuiVersion && `ComfyUI ${stats.comfyuiVersion}`,
    stats?.pytorchVersion && `PyTorch ${stats.pytorchVersion}`,
  ].filter(Boolean);
  return (
    <Section title="GPU">
      <dl className="space-y-1.5">
        {gpuName && <Row label="Card">{gpuName}</Row>}
        {stats?.vramBytes !== undefined && (
          <Row label="VRAM">{formatGigabytes(stats.vramBytes)}</Row>
        )}
        {pod && pod.gpuCount > 1 && (
          <Row label="On the pod">
            {pod.gpuIndex !== undefined
              ? `GPU ${pod.gpuIndex + 1} of ${pod.gpuCount}`
              : `${pod.gpuCount} GPUs`}
          </Row>
        )}
        {pod && (
          <Row label="Pod">
            RunPod · {pod.cloudType === "SECURE" ? "Secure" : "Community"} ·{" "}
            {formatUsd(pod.hourlyUsd)}/h
          </Row>
        )}
        {renderMs !== undefined && perGpuHourly !== undefined && (
          <Row
            label="Render cost"
            title="Render time at this GPU's share of the pod's hourly price"
          >
            ≈ {formatUsd((renderMs / 3_600_000) * perGpuHourly)}
          </Row>
        )}
        {software.length > 0 && <Row label="Software">{software.join(" · ")}</Row>}
        {pod?.podId && (
          <Row label="Pod id">
            <span className="font-mono text-[11px]">{pod.podId}</span>
          </Row>
        )}
      </dl>
    </Section>
  );
}

function H3SettingsSection({ generation }: { generation: GenerationDoc }) {
  if (!generation.h3Settings) return null;
  const s = normalizeH3Settings(generation.h3Settings);
  const seed = generation.h3Settings.seed;
  const frames = h3FrameCount(s.durationSeconds);
  return (
    <Section title="Settings">
      <dl className="space-y-1.5">
        <Row label="Mode">{H3_MODES.find((mode) => mode.value === s.mode)?.label ?? s.mode}</Row>
        <Row label="Model">{stripExtension(s.checkpoint)}</Row>
        {s.loras.map((lora, index) => (
          <Row key={`${lora.name}:${index}`} label={index === 0 ? "LoRAs" : ""}>
            {stripExtension(lora.name)} <span className="text-white/50">× {lora.strength}</span>
          </Row>
        ))}
        <Row label="Turbo">{s.turbo ? "On (official turbo LoRA)" : "Off"}</Row>
        <Row label="Resolution">
          {s.width}×{s.height}
          {s.upscale ? (
            <span className="text-white/50"> (rendered at half, upscaled 2×)</span>
          ) : null}
        </Row>
        <Row label="Duration">
          {s.durationSeconds} s · {frames} frames · {s.interpolate ? H3_FPS * 2 : H3_FPS} fps
        </Row>
        <Row label="Steps">{s.steps}</Row>
        <Row label="Sampler">
          {s.sampler} · {s.scheduler}
        </Row>
        <Row label="Seed">
          <span className="inline-flex items-center gap-1">
            {seed}
            <CopyButton text={String(seed)} label="Seed" />
          </span>
        </Row>
        <Row label="Sigma shift">
          {s.shiftEnabled ? `Video ${s.shiftVideo} · audio ${s.shiftAudio}` : "Model default"}
        </Row>
        <Row label="Attention">
          {s.fastAttention ? "INT8 (Comfy Kitchen)" : "Standard"}
          {s.sparseAttention !== "off"
            ? ` · ${s.sparseAttention === "vsa" ? `VSA ${s.sparseValue}%` : `SOL τ ${s.sparseValue}`}`
            : ""}
        </Row>
        <Row label="EasyCache">{s.easyCache ? `On · ${s.easyCacheThreshold}` : "Off"}</Row>
        {s.mode === "reference" && (
          <Row label="Reference size">{s.referenceSize === "max" ? "Max (2048 px)" : "Match"}</Row>
        )}
        <Row label="Audio">{s.audio ? "On" : "Off"}</Row>
        {s.interpolate && <Row label="Interpolation">RIFE · 48 fps</Row>}
        {s.upscale && <Row label="Upscale">Latent 2× + 3-step refine</Row>}
      </dl>
    </Section>
  );
}

const LTX_MODE_LABELS = {
  text: "Text → video",
  frames: "Image → video",
  sheet: "Reference sheet",
} as const;

function LtxSettingsSection({ generation }: { generation: GenerationDoc }) {
  if (!generation.ltxSettings) return null;
  const s = normalizeLtxSettings(generation.ltxSettings);
  const seed = generation.ltxSettings.seed;
  const sheet = s.mode === "sheet";
  const twoPass = s.twoPass && !sheet;
  return (
    <Section title="Settings">
      <dl className="space-y-1.5">
        <Row label="Model">LTX 2.3 · {LTX_MODE_LABELS[s.mode]}</Row>
        <Row label="Checkpoint">
          {LTX_KNOWN_CHECKPOINTS[s.checkpoint]?.label ?? stripExtension(s.checkpoint)}
        </Row>
        {s.loras.map((lora, index) => (
          <Row key={`${lora.name}:${index}`} label={index === 0 ? "LoRAs" : ""}>
            {stripExtension(lora.name)} <span className="text-white/50">× {lora.strength}</span>
          </Row>
        ))}
        {sheet && <Row label="Sheet strength">{s.sheetStrength ?? 1}</Row>}
        <Row label="Resolution">
          {s.width}×{s.height}
          {twoPass ? <span className="text-white/50"> (rendered at half, upscaled 2×)</span> : null}
        </Row>
        <Row label="Duration">
          {s.durationSeconds} s · {ltxFrameCount(s.durationSeconds, s.fps)} frames · {s.fps} fps
        </Row>
        <Row label="Steps">
          {ltxUsesDistilledSigmas(s) ? "8 · distilled schedule" : `${s.steps} · LTXV scheduler`}
          {twoPass ? " + 3-step refine" : ""}
        </Row>
        <Row label="CFG">{s.cfg}</Row>
        <Row label="Seed">
          <span className="inline-flex items-center gap-1">
            {seed}
            <CopyButton text={String(seed)} label="Seed" />
          </span>
        </Row>
        {s.mode === "frames" && (
          <Row label="Image">
            Strength {s.imageStrength} · compression {s.imageCompression}
          </Row>
        )}
        <Row label="Audio">{s.audio ? "On" : "Off"}</Row>
        {s.cfg > 1 && s.negativePrompt.trim() && <Row label="Negative">{s.negativePrompt}</Row>}
      </dl>
    </Section>
  );
}

const PROVIDER_LABELS: Record<ReturnType<typeof providerOf>, string> = {
  grok: "Grok",
  fal: "fal.ai",
  higgsfield: "Higgsfield",
  atlas: "Atlas Cloud",
};

/** An Atlas parameter worth a line: short scalars, not prompts or image lists. */
function atlasValue(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value && value.length <= 48 && !/^https?:/.test(value)) {
    return value;
  }
  return null;
}

function ApiSettingsSection({ generation }: { generation: GenerationDoc }) {
  const price = priceOf(generation);
  const quality = qualityLabelOf(generation);
  const grokImageWire = grokImageWireOf(generation);
  const atlasEntries = Object.entries(generation.atlasParams ?? {})
    .filter(([key]) => !/prompt/i.test(key))
    .map(([key, value]) => [key, atlasValue(value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  return (
    <Section title="Settings">
      <dl className="space-y-1.5">
        <Row label="Provider">{PROVIDER_LABELS[providerOf(generation)]}</Row>
        <Row label="Model">{badgeOf(generation)}</Row>
        {generation.endpoint && (
          <Row label="Endpoint">
            <span className="font-mono text-[11px]">{generation.endpoint}</span>
          </Row>
        )}
        {generation.aspectRatio && <Row label="Aspect ratio">{generation.aspectRatio}</Row>}
        {grokImageWire && (
          <Row label="Image model">
            <span className="font-mono text-[11px]">{grokImageWire}</span>
          </Row>
        )}
        {generation.grokVideoModel && (
          <Row label="Video model">
            <span className="font-mono text-[11px]">{generation.grokVideoModel}</span>
          </Row>
        )}
        {generation.grokVideoMode && (
          <Row label="Grok mode">{generation.grokVideoMode === "edit" ? "Edit" : "Extend"}</Row>
        )}
        {generation.sourceVideoKey && (
          <Row label="Source clip">
            {generation.sourceVideoSeconds !== undefined
              ? `${generation.sourceVideoSeconds} s`
              : "—"}
          </Row>
        )}
        {generation.grokFrameRoles && generation.grokFrameRoles.length > 0 && (
          <Row label="Image roles">
            {generation.grokFrameRoles
              .map((entry, index) => {
                const label =
                  GROK_FRAME_ROLE_CHOICES.find((choice) => choice.role === entry.role)?.label ??
                  entry.role;
                return `${index + 1} ${label}${entry.at !== undefined ? ` at ${entry.at} s` : ""}`;
              })
              .join(" · ")}
          </Row>
        )}
        {generation.resolution && <Row label="Resolution">{generation.resolution}</Row>}
        {generation.duration !== undefined && (
          <Row label={generation.grokVideoMode === "extend" ? "Added" : "Duration"}>
            {generation.duration} s
          </Row>
        )}
        {quality && <Row label="Quality">{quality}</Row>}
        {generation.videoTier && <Row label="Tier">{generation.videoTier}</Row>}
        {generation.videoMode && <Row label="Mode">{generation.videoMode}</Row>}
        {generation.videoJobType && <Row label="Job type">{generation.videoJobType}</Row>}
        {generation.generateAudio !== undefined && (
          <Row label="Audio">{generation.generateAudio ? "On" : "Off"}</Row>
        )}
        {(generation.count ?? 1) > 1 && <Row label="Images">{generation.count}</Row>}
        {atlasEntries.map(([key, value]) => (
          <Row key={key} label={key}>
            {value}
          </Row>
        ))}
        {price !== null && (
          <Row label="Cost">
            {generation.costEstimated && price.startsWith("$") ? "≈ " : ""}
            {price}
          </Row>
        )}
      </dl>
    </Section>
  );
}

function PromptSection({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = prompt.length > 280 || prompt.split("\n").length > 6;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium tracking-wider text-white/45 uppercase">Prompt</h3>
        <CopyButton text={prompt} label="Prompt" />
      </div>
      <p
        className={cn(
          "text-xs leading-relaxed whitespace-pre-wrap break-words text-white/80",
          long && !expanded && "line-clamp-6",
        )}
      >
        {prompt}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-white/50 hover:text-white"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </section>
  );
}

const CREATED_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The lightbox's details sidebar for an API or self-hosted generation: what it
 * was given, how long each part took and on what hardware, and every setting —
 * the things the result itself cannot tell you.
 */
export function GenerationDetails({
  id,
  ...actions
}: {
  id: Id<"grokGenerations">;
} & DetailsActions) {
  const generation = useQuery(api.grokGenerations.get, { id });
  const selfHosted = !!generation && isSelfHostedVideo(generation);
  const pod = useQuery(api.comfyVideo.runDetails, selfHosted ? { id } : "skip");
  return <GenerationDetailsView generation={generation} pod={pod} {...actions} />;
}

type DetailsActions = {
  onOpenReference: (reference: Reference) => void;
  onUseReference: (url: string) => void;
  onClose: () => void;
};

/** The panel itself, from data already fetched. `undefined` is still loading. */
export function GenerationDetailsView({
  generation,
  pod,
  onOpenReference,
  onUseReference,
  onClose,
}: {
  generation: GenerationDoc | null | undefined;
  pod: RunDetails | null | undefined;
} & DetailsActions) {
  const selfHosted = !!generation && isSelfHostedVideo(generation);
  const references = generation ? generationReferences(generation) : [];

  return (
    <aside
      data-reference-panel
      aria-label="Generation details"
      className="flex max-h-[45%] shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-950/80 text-white md:max-h-full md:w-80 md:self-stretch"
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 py-2 pr-2 pl-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Details</h2>
          {generation && (
            <p className="truncate text-xs text-white/50">
              {badgeOf(generation)} · {CREATED_FORMAT.format(generation.createdAt)}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          title="Hide details (i)"
          className="h-8 w-8 shrink-0 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Hide details</span>
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
        {generation === undefined ? (
          <p role="status" className="flex items-center gap-2 text-xs text-white/50">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading details...
          </p>
        ) : generation === null ? (
          <p className="text-xs text-white/50">This generation is no longer available.</p>
        ) : (
          <>
            {(references.length > 0 || generation.hasReferenceImage) && (
              <Section title={selfHosted ? "Input images" : "References"}>
                {references.length === 0 ? (
                  <p className="text-xs text-white/50">The original image was not saved.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {references.map((reference, index) => (
                      <ReferenceThumb
                        key={`${reference.url}:${index}`}
                        reference={reference}
                        index={index}
                        onOpen={onOpenReference}
                        onUse={onUseReference}
                      />
                    ))}
                  </div>
                )}
              </Section>
            )}
            <TimingSection generation={generation} />
            {selfHosted && <GpuSection generation={generation} pod={pod} />}
            {selfHosted ? (
              generation.ltxSettings ? (
                <LtxSettingsSection generation={generation} />
              ) : (
                <H3SettingsSection generation={generation} />
              )
            ) : (
              <ApiSettingsSection generation={generation} />
            )}
            <PromptSection prompt={generation.prompt} />
          </>
        )}
      </div>
    </aside>
  );
}
