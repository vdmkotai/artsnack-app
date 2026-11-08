"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useAction, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import {
  BookmarkCheck,
  BookmarkPlus,
  Check,
  Copy,
  ImagePlus,
  Loader2,
  RefreshCw,
  RotateCcw,
  ScanText,
  Upload,
  X,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import { GenerateSplit } from "@/components/generate-split";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/copy-text";
import { imageUrlToBlob } from "@/lib/fetch-image";
import {
  DEFAULT_DESCRIBE_MODEL_ID,
  DESCRIBE_PRESETS,
  describeCatalogNotice,
  describeModelFor,
  describeModelHint,
  FALLBACK_DESCRIBE_CATALOG,
  getDescribePreset,
  groupDescribeModels,
  isDescribeModelId,
  isDescribePresetId,
  MAX_DESCRIBE_INSTRUCTIONS,
  withPreviousModels,
  type DescribeModel,
  type DescribeModelCatalog,
  type DescribePresetId,
} from "@/lib/image-to-prompt";
import {
  REFERENCE_IMAGE_ACCEPT,
  isAttachableImageFile,
  referenceImageBlob,
} from "@/lib/image-file";
import { prepareReferenceImage } from "@/lib/resize-image";
import { cn } from "@/lib/utils";

// Closed by default; its code loads the first time it is opened.
const ReferencePicker = dynamic(
  () => import("@/components/grok/reference-picker").then((mod) => mod.ReferencePicker),
  { ssr: false },
);

/**
 * The Image → Prompt tool: drop pictures, get prompts that would draw them.
 *
 * Pictures stay on the left once added, and every Describe is a new run of
 * them on the right — one card per picture per run, with the format and model
 * it ran on — so one picture can be tried on Kimi and on Grok at once, and a
 * run in progress never holds up the next. Describe sends only the pictures
 * not yet described with the current settings; with nothing new it offers to
 * run them all again.
 *
 * Runs live in this component's state and nowhere else — a description is
 * worth keeping only once someone decides it is, and that is what Save (into
 * the ordinary saved-prompts library) is for. The panel stays mounted while
 * another provider is showing, so switching away and back loses nothing; a
 * reload does.
 */

const SETTINGS_STORAGE_KEY = "artsnack_describe_settings";
/** The last model list both vendors answered in full, so the picker never opens empty. */
const CATALOG_STORAGE_KEY = "artsnack_describe_models";
/**
 * At most two requests in flight per model — xAI rate-limits each model at
 * two a second — and six in all. Different models run side by side: that is
 * what comparing Kimi with Grok on one picture needs.
 */
const PER_MODEL_IN_FLIGHT = 2;
const MAX_IN_FLIGHT = 6;
/** Pictures waiting on the left. Past this it is a mistake more often than a plan. */
const MAX_INPUTS = 24;

/** A picture added to the panel. It stays until removed; each Describe runs it again. */
type InputImage = {
  id: string;
  name: string;
  blob: Blob;
  previewUrl: string;
  dataUrl: string;
};

type RunStatus = "waiting" | "running" | "done" | "error";

/** One description of one picture, with the settings it ran with. */
type DescribeRun = {
  id: string;
  /** The picture on the left it was made from, which may since have been removed. */
  inputId: string;
  name: string;
  /** Its own object URL: the picture may be removed on the left while this stays. */
  previewUrl: string;
  dataUrl: string;
  settings: Settings;
  /** For a new card of the same picture, with its own object URL. */
  blob: Blob;
  /** "Kimi K3.1 Pro · Natural description": what this card is running on. */
  label: string;
  status: RunStatus;
  text: string;
  error?: string;
  /** "SD tags with weights · Grok 4.6 · $0.0018" — how the text came to be. */
  meta?: string;
  /** Why Grok did not answer, when Atlas did instead. */
  fallbackReason?: string;
  /** The exact text last saved, so an edit after saving re-enables Save. */
  savedText?: string;
};

type DescribeResult = {
  text: string;
  costUsd?: number;
  model: { id: string; label: string; provider: "grok" | "atlas" };
  fellBack: boolean;
  reason?: string;
};

type DescribeArgs = {
  image: string;
  preset: DescribePresetId;
  instructions?: string;
  modelId?: string;
};

type Settings = { preset: DescribePresetId; instructions: string; modelId: string };

function readSettings(): Settings {
  const fallback: Settings = {
    preset: "natural",
    instructions: "",
    modelId: DEFAULT_DESCRIBE_MODEL_ID,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;
    const { preset, instructions, modelId } = parsed as Record<string, unknown>;
    return {
      preset: isDescribePresetId(preset) ? preset : fallback.preset,
      instructions: typeof instructions === "string" ? instructions : "",
      modelId: isDescribeModelId(modelId) ? modelId : fallback.modelId,
    };
  } catch {
    return fallback;
  }
}

function isDescribeModel(value: unknown): value is DescribeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return (
    isDescribeModelId(model.id) &&
    (model.provider === "grok" || model.provider === "atlas") &&
    typeof model.model === "string" &&
    typeof model.label === "string" &&
    typeof model.note === "string" &&
    typeof model.vision === "boolean"
  );
}

/** The last list both vendors answered in full, or null. */
function readStoredModels(): DescribeModel[] | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(CATALOG_STORAGE_KEY) ?? "null") as unknown;
    const models = (parsed as { models?: unknown } | null)?.models;
    return Array.isArray(models) && models.length > 0 && models.every(isDescribeModel)
      ? models
      : null;
  } catch {
    return null;
  }
}

function readStoredCatalog(): DescribeModelCatalog {
  const models = readStoredModels();
  return models ? { models } : FALLBACK_DESCRIBE_CATALOG;
}

/** Remembering the list is a convenience: full or refused storage loses nothing else. */
function storeModels(models: readonly DescribeModel[]): void {
  try {
    localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({ models }));
  } catch {
    // The list still shows; the next page load starts from the built-in one.
  }
}

/**
 * One live read per page load — the vendors' lists change over days — shared
 * by every mount. A failed read is forgotten so the next load tries again,
 * and so is a partial one, whose failed list is filled in from the stored
 * one. Only a list both vendors answered in full replaces the stored one: a
 * stand-in list would hide every model the user saw last time.
 */
let catalogRequest: Promise<DescribeModelCatalog | null> | null = null;

function loadCatalog(
  listModels: () => Promise<DescribeModelCatalog>,
  { reload = false } = {},
): Promise<DescribeModelCatalog | null> {
  if (reload) catalogRequest = null;
  catalogRequest ??= listModels().then(
    (catalog) => {
      if (catalog.grokError || catalog.atlasError) {
        catalogRequest = null;
        return withPreviousModels(catalog, readStoredModels() ?? []);
      }
      storeModels(catalog.models);
      return catalog;
    },
    () => {
      catalogRequest = null;
      return null;
    },
  );
  return catalogRequest;
}

function itemId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What makes two runs of one picture the same request. */
function settingsKey(settings: Settings): string {
  return JSON.stringify([settings.preset, settings.modelId, settings.instructions.trim()]);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Module scope for the same reason as toastOnFailure in api-panel: the React
 * Compiler abandons a whole component that holds a `try` it cannot lower.
 * Never rejects.
 */
async function prepareInput(file: Blob, name: string): Promise<InputImage | string> {
  try {
    const { blob } = await prepareReferenceImage(file, "describe");
    // The object URL last: made before a read that can fail, it would leak.
    const dataUrl = await blobToDataUrl(blob);
    return {
      id: itemId(),
      name,
      blob,
      previewUrl: URL.createObjectURL(blob),
      dataUrl,
    };
  } catch (error) {
    return error instanceof Error ? error.message : "Could not read the image";
  }
}

async function runDescribe(
  describe: (args: DescribeArgs) => Promise<DescribeResult>,
  args: DescribeArgs,
): Promise<{ ok: true; result: DescribeResult } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await describe(args) };
  } catch (error) {
    return {
      ok: false,
      // The server's message rides in a ConvexError's data; its `message`
      // carries the request id and stack around it.
      error:
        error instanceof ConvexError
          ? String(error.data)
          : error instanceof Error
            ? error.message
            : "Description failed",
    };
  }
}

async function savePromptText(
  savePrompt: (args: { text: string }) => Promise<{ duplicate: boolean }>,
  text: string,
): Promise<boolean> {
  try {
    const result = await savePrompt({ text });
    toast.success(result.duplicate ? "Already saved" : "Prompt saved");
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not save the prompt");
    return false;
  }
}

/**
 * The label comes from the list the run was started with where it can: the
 * server names a model it has never seen listed by its slug.
 */
function describeMeta(
  preset: DescribePresetId,
  result: DescribeResult,
  models: readonly DescribeModel[],
): string {
  const label = models.find((model) => model.id === result.model.id)?.label ?? result.model.label;
  const via = result.model.provider === "atlas" ? `Atlas · ${label}` : label;
  const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(4)}` : "";
  return `${getDescribePreset(preset).label} · ${via}${cost}`;
}

/** What a waiting or running card sends, and what its answer is labelled with. */
type Job = {
  args: DescribeArgs;
  settings: Settings;
  models: readonly DescribeModel[];
};

export function ImageToPromptPanel({ header }: { header: React.ReactNode }) {
  const describe = useAction(api.imageToPrompt.describe);
  const listModels = useAction(api.imageToPrompt.models);
  const savePrompt = useMutation(api.savedPrompts.save);

  const [settings, setSettings] = React.useState<Settings>(readSettings);
  const [catalog, setCatalog] = React.useState<DescribeModelCatalog>(readStoredCatalog);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [catalogFailed, setCatalogFailed] = React.useState(false);
  const [inputs, setInputs] = React.useState<InputImage[]>([]);
  const [runs, setRuns] = React.useState<DescribeRun[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [isAdding, setIsAdding] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // The queue lives in refs: only event handlers and settled requests read or
  // change it, never a render.
  /** Card ids waiting for a free slot, oldest first. */
  const queueRef = React.useRef<string[]>([]);
  /**
   * What each waiting or running card sends. Removing or retrying a card
   * replaces or drops its entry, which is how a request that settles later
   * knows its answer belongs to nothing on screen.
   */
  const jobsRef = React.useRef(new Map<string, Job>());
  /** Requests in flight, per model id. */
  const inFlightRef = React.useRef(new Map<string, number>());
  /** When Describe last queued anything: a double click must not send it all twice. */
  const lastDescribeRef = React.useRef(0);

  // Object URLs outlive the component unless revoked; the ref sees the latest
  // lists without making the cleanup effect depend on them.
  const urlsRef = React.useRef({ inputs, runs });
  React.useEffect(() => {
    urlsRef.current = { inputs, runs };
  }, [inputs, runs]);
  React.useEffect(() => {
    const jobs = jobsRef.current;
    const queue = queueRef.current;
    return () => {
      // Nothing waiting is sent once the panel is gone.
      queue.length = 0;
      jobs.clear();
      for (const input of urlsRef.current.inputs) URL.revokeObjectURL(input.previewUrl);
      for (const run of urlsRef.current.runs) URL.revokeObjectURL(run.previewUrl);
    };
  }, []);

  const applyCatalog = (fresh: DescribeModelCatalog | null) => {
    setCatalogLoading(false);
    setCatalogFailed(fresh === null);
    if (fresh) setCatalog(fresh);
  };

  React.useEffect(() => {
    let mounted = true;
    void loadCatalog(listModels).then((fresh) => {
      if (!mounted) return;
      setCatalogLoading(false);
      setCatalogFailed(fresh === null);
      if (fresh) setCatalog(fresh);
    });
    return () => {
      mounted = false;
    };
  }, [listModels]);

  const reloadCatalog = () => {
    setCatalogLoading(true);
    void loadCatalog(listModels, { reload: true }).then(applyCatalog);
  };

  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const modelFor = (modelId: string) =>
    catalog.models.find((candidate) => candidate.id === modelId) ?? describeModelFor(modelId);

  const runLabel = (snapshot: Settings) =>
    `${modelFor(snapshot.modelId).label} · ${getDescribePreset(snapshot.preset).label}`;

  const patchRun = (id: string, patch: Partial<DescribeRun>) => {
    setRuns((previous) => previous.map((run) => (run.id === id ? { ...run, ...patch } : run)));
  };

  // --- The queue ----------------------------------------------------------

  /** Starts waiting cards, oldest first, while their model and the total have room. */
  const pump = () => {
    const queue = queueRef.current;
    const inFlight = inFlightRef.current;
    let total = 0;
    for (const count of inFlight.values()) total += count;
    let index = 0;
    while (index < queue.length && total < MAX_IN_FLIGHT) {
      const id = queue[index];
      const job = jobsRef.current.get(id);
      const running = job ? (inFlight.get(job.settings.modelId) ?? 0) : 0;
      if (job && running >= PER_MODEL_IN_FLIGHT) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      if (!job) continue;
      inFlight.set(job.settings.modelId, running + 1);
      total += 1;
      void start(id, job);
    }
  };

  const start = async (id: string, job: Job) => {
    patchRun(id, { status: "running", error: undefined });
    const outcome = await runDescribe(describe, job.args);
    const inFlight = inFlightRef.current;
    const modelId = job.settings.modelId;
    inFlight.set(modelId, Math.max(0, (inFlight.get(modelId) ?? 1) - 1));
    if (jobsRef.current.get(id) === job) {
      jobsRef.current.delete(id);
      patchRun(
        id,
        outcome.ok
          ? {
              status: "done",
              text: outcome.result.text,
              meta: describeMeta(job.settings.preset, outcome.result, job.models),
              fallbackReason: outcome.result.fellBack ? outcome.result.reason : undefined,
              savedText: undefined,
            }
          : { status: "error", error: outcome.error },
      );
    }
    pump();
  };

  const enqueue = (run: DescribeRun) => {
    const instructions = run.settings.instructions.trim();
    jobsRef.current.set(run.id, {
      args: {
        image: run.dataUrl,
        preset: run.settings.preset,
        instructions: instructions || undefined,
        modelId: run.settings.modelId,
      },
      settings: run.settings,
      models: catalog.models,
    });
    queueRef.current.push(run.id);
  };

  const newRun = (
    inputId: string,
    source: { name: string; blob: Blob; dataUrl: string },
    snapshot: Settings,
  ): DescribeRun => ({
    id: itemId(),
    inputId,
    name: source.name,
    blob: source.blob,
    previewUrl: URL.createObjectURL(source.blob),
    dataUrl: source.dataUrl,
    settings: snapshot,
    label: runLabel(snapshot),
    status: "waiting",
    text: "",
  });

  // --- Pictures on the left -------------------------------------------------

  const addBlobs = async (blobs: { blob: Blob; name: string }[]) => {
    // The room below is counted from the list as it was; a second drop while
    // the first is still being prepared would count against a stale length.
    if (isAdding) {
      toast.info("Still preparing the last images — drop these again in a moment");
      return;
    }
    const room = MAX_INPUTS - urlsRef.current.inputs.length;
    if (room <= 0) {
      toast.error(`Up to ${MAX_INPUTS} images at a time — remove some first`);
      return;
    }
    if (blobs.length > room) toast.info(`Only the first ${room} added — ${MAX_INPUTS} at most`);
    setIsAdding(true);
    const prepared: InputImage[] = [];
    for (const { blob, name } of blobs.slice(0, room)) {
      const input = await prepareInput(blob, name);
      if (typeof input === "string") toast.error(`${name}: ${input}`);
      else prepared.push(input);
    }
    setInputs((previous) => [...previous, ...prepared]);
    setIsAdding(false);
  };

  const addFiles = (files: FileList | File[]) => {
    const images = [...files].filter(isAttachableImageFile);
    if (images.length === 0) return;
    void addBlobs(images.map((file) => ({ blob: referenceImageBlob(file), name: file.name })));
  };

  const addFromGallery = async (url: string) => {
    const blob = await imageUrlToBlob(url).catch(() => null);
    if (!blob) {
      toast.error("Could not load that image");
      return;
    }
    const name = url.split("?")[0].split("/").pop() || "gallery image";
    await addBlobs([{ blob, name }]);
  };

  const removeInput = (id: string) => {
    setInputs((previous) => {
      const gone = previous.find((input) => input.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return previous.filter((input) => input.id !== id);
    });
  };

  const clearInputs = () => {
    setInputs((previous) => {
      for (const input of previous) URL.revokeObjectURL(input.previewUrl);
      return [];
    });
  };

  // --- Runs on the right ----------------------------------------------------

  // A picture counts as described with the current settings while a card of
  // it with those settings is on screen and has not failed: removing or
  // clearing a card, or a run that never got an answer, makes it new again,
  // and Again and Retry count like Describe.
  const key = settingsKey(settings);
  const describedIds = new Set(
    runs
      .filter((run) => run.status !== "error" && settingsKey(run.settings) === key)
      .map((run) => run.inputId),
  );
  const freshInputs = inputs.filter((input) => !describedIds.has(input.id));

  const describeInputs = () => {
    const now = Date.now();
    if (now - lastDescribeRef.current < 600) return;
    const targets = freshInputs.length > 0 ? freshInputs : inputs;
    if (targets.length === 0) return;
    lastDescribeRef.current = now;
    const snapshot = settings;
    const created = targets.map((input) => newRun(input.id, input, snapshot));
    for (const run of created) enqueue(run);
    setRuns((previous) => [...created, ...previous]);
    pump();
  };

  /** A new card for the same picture with the current settings; the old one stays. */
  const runAgain = (source: DescribeRun) => {
    const run = newRun(source.inputId, source, settings);
    enqueue(run);
    setRuns((previous) => [run, ...previous]);
    pump();
  };

  /** A failed card tries again in place, with the current settings. */
  const retry = (source: DescribeRun) => {
    const run: DescribeRun = {
      ...source,
      settings,
      label: runLabel(settings),
      status: "waiting",
      error: undefined,
    };
    enqueue(run);
    patchRun(source.id, {
      settings: run.settings,
      label: run.label,
      status: "waiting",
      error: undefined,
    });
    pump();
  };

  /** A waiting card is never sent; a running one finishes (and is billed) unseen. */
  const removeRun = (id: string) => {
    jobsRef.current.delete(id);
    setRuns((previous) => {
      const gone = previous.find((run) => run.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return previous.filter((run) => run.id !== id);
    });
  };

  /** Every card but those whose request is in flight — those are answered (and billed) anyway. */
  const clearRuns = () => {
    setRuns((previous) => {
      const kept = previous.filter((run) => run.status === "running");
      for (const run of previous) {
        if (run.status === "running") continue;
        jobsRef.current.delete(run.id);
        URL.revokeObjectURL(run.previewUrl);
      }
      return kept;
    });
  };

  const saveRun = async (run: DescribeRun) => {
    const text = run.text.trim();
    if (!text) return;
    if (await savePromptText(savePrompt, text)) patchRun(run.id, { savedText: text });
  };

  const active = runs.filter((run) => run.status === "waiting" || run.status === "running").length;
  const preset = getDescribePreset(settings.preset);
  const model = modelFor(settings.modelId);
  const modelOptions = groupDescribeModels(catalog.models, settings.modelId).flatMap((group) =>
    group.models.map((candidate) => ({
      value: candidate.id,
      label: candidate.label,
      // The slug tells apart Atlas's same-named variants (GPT 5.6 Sol is three
      // models) and is what a search for "codex" or "az" should find.
      description:
        candidate.provider === "atlas" ? `${candidate.note} · ${candidate.model}` : candidate.note,
      group: group.title,
    })),
  );
  const catalogNotice = describeCatalogNotice(
    catalog,
    catalogFailed ? "the server did not answer" : null,
  );

  const describeButton = (
    <Button
      size="lg"
      className="w-full"
      disabled={inputs.length === 0 || isAdding}
      title={
        freshInputs.length === 0 && inputs.length > 0
          ? "Every picture has been described with these settings — this runs them all again"
          : undefined
      }
      onClick={describeInputs}
    >
      <ScanText className="mr-2 h-4 w-4" />
      {inputs.length === 0
        ? "Add images to describe"
        : freshInputs.length > 0
          ? `Describe ${freshInputs.length} image${freshInputs.length === 1 ? "" : "s"}`
          : `Describe ${inputs.length === 1 ? "it" : `all ${inputs.length}`} again`}
    </Button>
  );

  return (
    <div className="flex flex-col lg:h-[calc(100vh-3.5rem)] lg:min-h-0">
      <GenerateSplit storageKey="generate-split-describe" className="lg:flex-1">
        <div className="min-w-0 lg:flex lg:flex-col lg:h-full">
          {header}
          <div className="flex-1 overflow-y-auto px-3 py-3 pb-24 lg:px-4 lg:pb-4">
            <div className="max-w-3xl mx-auto lg:max-w-none space-y-4">
              <div
                className={cn(
                  "rounded-lg border border-dashed transition-colors",
                  isDragging && "border-primary bg-primary/5 ring-2 ring-primary",
                )}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                  setIsDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  addFiles(event.dataTransfer.files);
                }}
              >
                {inputs.length > 0 && (
                  <div className="border-b border-dashed p-2.5">
                    <div className="mb-2 flex items-center justify-between gap-2 px-0.5 text-[11px] text-muted-foreground">
                      <span>
                        {inputs.length} image{inputs.length === 1 ? "" : "s"} — they stay here; each
                        Describe is a new run
                      </span>
                      <button
                        type="button"
                        className="shrink-0 hover:text-foreground"
                        onClick={clearInputs}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {inputs.map((input) => (
                        <InputThumb
                          key={input.id}
                          input={input}
                          described={describedIds.has(input.id)}
                          onRemove={() => removeInput(input.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "flex w-full flex-col items-center justify-center gap-2 px-4 text-muted-foreground hover:text-primary transition-colors",
                    inputs.length > 0 ? "py-4" : "py-8",
                  )}
                >
                  {isAdding ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <Upload className="h-6 w-6" />
                  )}
                  <span className="text-sm">
                    {inputs.length > 0
                      ? "Drop or click to add more"
                      : "Drop images here or click to upload"}
                  </span>
                  {inputs.length === 0 && (
                    <span className="text-[11px]">Several at once — each gets its own prompt</span>
                  )}
                </button>
                <div className="flex justify-center border-t border-dashed py-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={() => setPickerOpen(true)}
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    From gallery
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={REFERENCE_IMAGE_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files?.length) addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Prompt format</Label>
                <div
                  role="group"
                  aria-label="Prompt format"
                  className="flex flex-wrap items-center gap-0.5 rounded-md border bg-card p-0.5"
                >
                  {DESCRIBE_PRESETS.map((candidate) => (
                    <Button
                      key={candidate.id}
                      variant={settings.preset === candidate.id ? "default" : "ghost"}
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs font-normal"
                      aria-pressed={settings.preset === candidate.id}
                      onClick={() => updateSettings({ preset: candidate.id })}
                    >
                      {candidate.label}
                    </Button>
                  ))}
                </div>
                <p className="px-0.5 text-[11px] text-muted-foreground">{preset.hint}</p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">Model</Label>
                  {(catalogNotice || catalogLoading) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5 text-[11px] font-normal"
                      disabled={catalogLoading}
                      onClick={reloadCatalog}
                    >
                      {catalogLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {catalogLoading ? "Loading models…" : "Reload list"}
                    </Button>
                  )}
                </div>
                <SearchableSelect
                  options={modelOptions}
                  value={model.id}
                  onValueChange={(modelId) => updateSettings({ modelId })}
                  placeholder="Models"
                  emptyMessage="No model matches."
                />
                <p className="px-0.5 text-[11px] text-muted-foreground">
                  {describeModelHint(model, catalog.models)}
                </p>
                {catalogNotice && (
                  <p className="px-0.5 text-[11px] text-muted-foreground">{catalogNotice}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="describe-instructions" className="text-xs">
                  Extra instructions <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="describe-instructions"
                  value={settings.instructions}
                  maxLength={MAX_DESCRIBE_INSTRUCTIONS}
                  onChange={(event) => updateSettings({ instructions: event.target.value })}
                  placeholder="e.g. Describe the pose and how she moves in detail; keep the dress colour exact; put her on a beach at sunset"
                  className="min-h-20"
                />
              </div>
            </div>
          </div>

          <div className="hidden lg:block border-t bg-background px-3 py-2 lg:px-4">
            {describeButton}
          </div>
        </div>

        <div className="min-w-0 lg:h-full lg:overflow-y-auto pb-24 lg:pb-0">
          <div className="space-y-3 px-3 py-3 lg:px-4">
            {runs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-sm text-muted-foreground">
                <ScanText className="h-8 w-8" />
                <p>Prompts for the images you add will appear here.</p>
                <p className="text-xs">
                  Run one picture on several models to compare them; edit, copy or save what you
                  like.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {runs.length} result{runs.length === 1 ? "" : "s"}
                    {active > 0 && ` · ${active} in progress`}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={runs.every((run) => run.status === "running")}
                    onClick={clearRuns}
                  >
                    Clear all
                  </Button>
                </div>
                {runs.map((run) => (
                  <DescribeCard
                    key={run.id}
                    run={run}
                    onChange={(text) => patchRun(run.id, { text })}
                    onAgain={() => runAgain(run)}
                    onRetry={() => retry(run)}
                    onSave={() => void saveRun(run)}
                    onRemove={() => removeRun(run.id)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </GenerateSplit>

      <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-background/80 backdrop-blur-md border-t z-40">
        <div className="max-w-3xl mx-auto">{describeButton}</div>
      </div>

      {pickerOpen && (
        <ReferencePicker
          onClose={() => setPickerOpen(false)}
          onPick={(url) => {
            setPickerOpen(false);
            void addFromGallery(url);
          }}
        />
      )}
    </div>
  );
}

/** A picture waiting on the left, marked once it has run with the current settings. */
function InputThumb({
  input,
  described,
  onRemove,
}: {
  input: InputImage;
  described: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="group relative h-20 w-20 overflow-hidden rounded-md border bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={input.previewUrl} alt={input.name} className="h-full w-full object-cover" />
      {described && (
        <span
          className="absolute bottom-1 left-1 rounded-full bg-primary p-0.5 text-primary-foreground shadow-sm"
          title="Described with the current format, model and instructions"
        >
          <Check className="h-3 w-3" />
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${input.name}`}
        title="Remove"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-background/85 p-0.5 text-foreground opacity-100 transition-opacity hover:bg-background sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function DescribeCard({
  run,
  onChange,
  onAgain,
  onRetry,
  onSave,
  onRemove,
}: {
  run: DescribeRun;
  onChange: (text: string) => void;
  onAgain: () => void;
  onRetry: () => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const busy = run.status === "waiting" || run.status === "running";
  const trimmed = run.text.trim();
  const saved = run.savedText !== undefined && run.savedText === trimmed;

  return (
    <div className="flex gap-3 rounded-lg border bg-card p-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={run.previewUrl}
        alt={run.name}
        className="h-28 w-28 shrink-0 rounded-md object-cover sm:h-36 sm:w-36"
      />
      <div className="min-w-0 flex-1 space-y-2">
        {run.status !== "done" && (
          <p className="pt-1 text-[11px] text-muted-foreground">{run.label}</p>
        )}
        {run.status === "waiting" && (
          <p className="text-xs text-muted-foreground">Waiting for a free slot on this model…</p>
        )}
        {run.status === "running" && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Looking at the image…
          </p>
        )}
        {run.status === "error" && (
          <p role="alert" className="text-xs text-destructive">
            {run.error}
          </p>
        )}
        {run.status === "done" && (
          <>
            <Textarea
              value={run.text}
              onChange={(event) => onChange(event.target.value)}
              aria-label={`Prompt for ${run.name}`}
              className="min-h-24 font-mono text-xs"
            />
            {run.meta && <p className="text-[11px] text-muted-foreground">{run.meta}</p>}
            {run.fallbackReason && (
              <p className="text-[11px] text-muted-foreground">
                Grok did not answer ({run.fallbackReason}), Atlas did.
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {run.status === "done" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={!trimmed || saved}
                onClick={onSave}
              >
                {saved ? (
                  <BookmarkCheck className="h-3.5 w-3.5" />
                ) : (
                  <BookmarkPlus className="h-3.5 w-3.5" />
                )}
                {saved ? "Saved" : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={!trimmed}
                onClick={() => {
                  void copyText(trimmed).then((ok) => {
                    if (ok) toast.success("Prompt copied");
                  });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                title="Describe this picture again with the current format, model and instructions, as a new card"
                onClick={onAgain}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Again
              </Button>
            </>
          )}
          {run.status === "error" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              title="Try again with the current format, model and instructions"
              onClick={onRetry}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 w-7 p-0"
            aria-label="Remove"
            title={busy ? "Remove — a request already sent still finishes and is billed" : "Remove"}
            onClick={onRemove}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
