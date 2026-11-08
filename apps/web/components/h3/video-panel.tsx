"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useAction, useMutation, useQuery } from "convex/react";
import { usePaginatedQuery as useCachedPaginatedQuery } from "@/lib/convex-cache";
import { ConvexError } from "convex/values";
import { Loader2, RotateCcw, Shuffle, Video } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ApiResults, type GenerationDoc } from "@/components/api/api-results";
import { uploadToStorage, withServerTimeout } from "@/components/api/submit-guards";
import { useHeldWhileHidden } from "@/components/api/use-held-while-hidden";
import { GenerateSplit } from "@/components/generate-split";
import { PromptInput } from "@/components/grok/prompt-input";
import {
  type Advice,
  AdviceLine,
  CommunityMark,
  Field,
  ImageSlot,
  type InputImage,
  type InputRole,
  NumberInput,
  Toggle,
} from "@/components/h3/form-controls";
import { H3LoraStack } from "@/components/h3/h3-lora-stack";
import {
  loadLtxForm,
  LtxComposer,
  type LtxFormState,
  ltxProblems,
  saveLtxForm,
} from "@/components/h3/ltx-composer";
import { VideoPodStatus, videoPodLabel } from "@/components/h3/video-pod-status";
import { PromptEnhanceButton } from "@/components/prompt-enhance-button";
import { PromptLibrary } from "@/components/prompt-library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Slider } from "@/components/ui/slider";
import { imageUrlToBlob } from "@/lib/fetch-image";
import { isAttachableImageFile, pastedImageFiles, referenceImageBlob } from "@/lib/image-file";
import {
  DEFAULT_H3_SETTINGS,
  defaultCheckpointFor,
  H3_ASPECTS,
  H3_BASE_FILES,
  H3_FULL_STEPS,
  H3_LIMITS,
  H3_MODES,
  H3_SAMPLERS,
  H3_SCHEDULERS,
  H3_SHORT_EDGES,
  H3_TURBO_STEPS,
  h3Dimensions,
  h3FrameCount,
  h3ReferenceTagProblem,
  normalizeH3Settings,
  type H3Aspect,
  type H3Mode,
  type H3VideoSettings,
} from "@/lib/h3-video";
import { mediaUrl } from "@/lib/media-url";
import { normalizeLtxSettings } from "@/lib/ltx-video";
import { referenceOutputKey } from "@/lib/reference-generation";
import type { VideoHandoffRole } from "@/lib/reference-handoff";
import { prepareReferenceImage } from "@/lib/resize-image";
import { onPodCatalogChange } from "@/lib/pod-catalog-version";
import { cn } from "@/lib/utils";
import { useStableRows } from "@/hooks/use-stable-rows";

// Closed by default; its code loads the first time it is opened.
const ReferencePicker = dynamic(
  () => import("@/components/grok/reference-picker").then((mod) => mod.ReferencePicker),
  { ssr: false },
);

const FORM_KEY = "artsnack-h3-video-form";
const FAMILY_KEY = "artsnack-video-family";
const PAGE_SIZE = 30;
/**
 * The fallback re-read of the pod's model lists. A download made from this
 * browser announces itself (`onPodCatalogChange`) and the tab re-reads on
 * return, so this only catches changes made from somewhere else.
 */
const CATALOG_POLL_MS = 90_000;

type VideoCatalog = {
  checkpoints: string[];
  loras: string[];
  extras?: { rife: boolean; upscaler: boolean };
  ltx?: { ready: boolean; checkpoints: string[]; loras: string[] };
  error?: string;
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/*
 * Error handling lives out here, in module scope, on purpose. The React
 * Compiler cannot lower a `try` with a finalizer or with any conditional
 * expression inside it, and when it meets one it gives up on the *whole*
 * component — for this panel that meant every keystroke, slider tick and pod
 * update re-rendered the results grid as well.
 */
async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Runs `work`, reporting a failure as a toast. Resolves to whether it succeeded. */
async function toastErrors(work: () => Promise<void>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    toast.error(errorText(error));
    return false;
  }
}

/**
 * The catalogue to show after a read.
 *
 * An answer identical to the one on screen keeps the old object, so nothing
 * that reads it re-renders. A failed read keeps the last good lists: a single
 * timeout used to replace them with empty ones, which emptied the checkpoint
 * dropdown and disabled RIFE and Upscale until the next poll. One failure in a
 * row is ignored outright; from the second on the lists stay and the error is
 * shown beside them.
 */
function nextCatalog(
  previous: VideoCatalog | null,
  outcome: Settled<VideoCatalog>,
  failuresInARow: number,
): VideoCatalog {
  if (outcome.ok) {
    return previous && JSON.stringify(previous) === JSON.stringify(outcome.value)
      ? previous
      : outcome.value;
  }
  const error = errorText(outcome.error);
  if (previous && !previous.error && failuresInARow < 2) return previous;
  if (previous?.error === error) return previous;
  return previous ? { ...previous, error } : { checkpoints: [], loras: [], error };
}

async function prepareInput(raw: Blob, role: InputRole, sourceUrl?: string): Promise<InputImage> {
  const prepared = await prepareReferenceImage(raw, "fal");
  return {
    id: `${Date.now()}-${Math.random()}`,
    role,
    blob: prepared.blob,
    previewUrl: URL.createObjectURL(prepared.blob),
    sourceUrl,
  };
}

type FormState = H3VideoSettings & {
  /** "custom" = width/height typed by hand. */
  aspect: H3Aspect | "custom";
  shortEdge: number;
  count: number;
};

const DEFAULT_FORM: FormState = {
  ...DEFAULT_H3_SETTINGS,
  aspect: "16:9",
  shortEdge: 768,
  count: 1,
};

/**
 * The quality/speed settings we recommend for the official model, per mode —
 * what "Recommended settings" restores and what the green marks compare with.
 * Measured 2026-10-12 on an RTX PRO 6000: Turbo + fast attention is the
 * fastest setting with no visible loss; sparse attention and EasyCache trade
 * some detail for speed, so they stay a choice.
 */
function recommendedFor(mode: H3Mode) {
  return {
    turbo: true,
    steps: H3_TURBO_STEPS[mode],
    sampler: DEFAULT_H3_SETTINGS.sampler,
    scheduler: DEFAULT_H3_SETTINGS.scheduler,
    shiftEnabled: false,
    fastAttention: true,
    sparseAttention: "off" as const,
    easyCache: false,
  };
}

/** Bumped when the recommended settings change: a form saved under an older
 *  revision keeps its prompt, size and models but takes the new settings. */
const FORM_REVISION = 2;

function errorText(error: unknown): string {
  if (error instanceof ConvexError) return String(error.data);
  return error instanceof Error ? error.message : "Something went wrong";
}

function loadFamily(): "h3" | "ltx" {
  if (typeof window === "undefined") return "h3";
  return window.localStorage.getItem(FAMILY_KEY) === "ltx" ? "ltx" : "h3";
}

/** Switches the H3 form's mode, carrying the official checkpoint and Turbo steps along. */
function withMode(mode: H3Mode) {
  return (previous: FormState): FormState => {
    // Follow the official model for the mode only when the user is still on
    // an official one — a custom checkpoint is a deliberate choice.
    const official = [H3_BASE_FILES.fl2va, H3_BASE_FILES.ref2va] as string[];
    const officialFp8 = /^minimax_h3_(fl2va|ref2va)_pruned_fp8_scaled\.safetensors$/;
    const checkpoint = official.includes(previous.checkpoint)
      ? defaultCheckpointFor(mode)
      : officialFp8.test(previous.checkpoint)
        ? `minimax_h3_${mode === "reference" ? "ref2va" : "fl2va"}_pruned_fp8_scaled.safetensors`
        : previous.checkpoint;
    return {
      ...previous,
      mode,
      checkpoint,
      steps: previous.turbo ? H3_TURBO_STEPS[mode] : previous.steps,
    };
  };
}

function loadForm(): FormState {
  if (typeof window === "undefined") return DEFAULT_FORM;
  try {
    const raw = window.localStorage.getItem(FORM_KEY);
    if (!raw) return DEFAULT_FORM;
    const stored = JSON.parse(raw) as Partial<FormState> & { revision?: number };
    const settings = normalizeH3Settings({ ...DEFAULT_H3_SETTINGS, ...stored });
    return {
      ...DEFAULT_FORM,
      ...settings,
      ...(stored.revision === FORM_REVISION ? {} : recommendedFor(settings.mode)),
      aspect: stored.aspect ?? DEFAULT_FORM.aspect,
      shortEdge: stored.shortEdge ?? DEFAULT_FORM.shortEdge,
      count: Math.min(4, Math.max(1, Math.round(stored.count ?? 1))),
    };
  } catch {
    return DEFAULT_FORM;
  }
}

/** An image sent over from the API tab's results. */
export type VideoHandoff = { url: string; role: VideoHandoffRole; seq: number };

export function VideoPanel({
  active,
  tabs,
  reproduceId,
  onReproduceHandled,
  handoff,
  onHandoffHandled,
}: {
  active: boolean;
  tabs: React.ReactNode;
  reproduceId?: string;
  onReproduceHandled?: () => void;
  handoff?: VideoHandoff | null;
  onHandoffHandled?: () => void;
}) {
  // Restored in the initialisers, not in a mount effect: the panel is loaded
  // with `ssr: false`, so there is no server render to match, and a handoff or
  // reproduce that mounts the panel must see the saved family and form at once
  // — set a render later, the handoff would configure the wrong one.
  const [form, setForm] = React.useState<FormState>(loadForm);
  const [inputs, setInputs] = React.useState<InputImage[]>([]);
  const [submitting, setSubmitting] = React.useState<string | null>(null);
  const [catalog, setCatalog] = React.useState<VideoCatalog | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const pickingRole = React.useRef<InputRole>("reference");
  const [pickerRole, setPickerRole] = React.useState<InputRole | null>(null);
  const [dragging, setDragging] = React.useState(false);

  // Several video pods may run at once. "Auto" sends each clip to the least
  // busy ready pod that has its models; picking one pins the clip to it.
  const pods = useQuery(api.runpodBackendStore.videoPods, {});
  const readyPods = (pods ?? []).filter((candidate) => candidate.state === "ready");
  const [runOn, setRunOn] = React.useState<Id<"runpodBackends"> | "auto">("auto");
  const pinnedPod = runOn === "auto" ? undefined : readyPods.find((p) => p._id === runOn);
  // A picked pod that is stopped or still starting: never fall back to Auto
  // behind the user's back — block the form until they pick again.
  const pinnedUnavailable = runOn !== "auto" && !pinnedPod;
  // A picked pod that went away falls back to Auto rather than blocking the form.
  React.useEffect(() => {
    if (runOn !== "auto" && pods && !pods.some((p) => p._id === runOn)) setRunOn("auto");
  }, [pods, runOn]);
  const podReady = readyPods.length > 0;
  const pinnedPodId = pinnedPod?._id;
  const readCatalog = useAction(api.podCatalog.videoCatalog);
  const startJob = useMutation(api.comfyVideo.start);
  const startLtxJob = useMutation(api.comfyVideo.startLtx);
  // Two model families share the pod, the inputs, the queue and the results;
  // each keeps its own form, so switching back and forth loses nothing.
  const [family, setFamilyState] = React.useState<"h3" | "ltx">(loadFamily);
  const [ltxForm, setLtxForm] = React.useState<LtxFormState>(loadLtxForm);
  const setFamily = (next: "h3" | "ltx") => {
    setFamilyState(next);
    window.localStorage.setItem(FAMILY_KEY, next);
  };
  const uploadUrl = useMutation(api.grokGenerations.generateRefUploadUrl);
  const removeGeneration = useMutation(api.grokGenerations.remove);
  const removeMany = useMutation(api.grokGenerations.removeMany);
  const [removingFailed, setRemovingFailed] = React.useState(false);
  // Subscribed whether or not the tab is showing. It used to be skipped while
  // hidden, which threw away the loaded pages on every switch and remounted
  // every tile on the way back; stable rows plus the hold below make the
  // background subscription cost nothing on screen.
  const {
    results: liveResults,
    status: listStatus,
    loadMore,
  } = useCachedPaginatedQuery(api.comfyVideo.list, {}, { initialNumItems: PAGE_SIZE });
  const results = useHeldWhileHidden(useStableRows(liveResults as GenerationDoc[]), active);
  // Convex rebuilds `loadMore` whenever the last page changes — on every push —
  // so it is read through a ref, and the grid is handed one function for good.
  const latestLoadMore = React.useRef(loadMore);
  React.useLayoutEffect(() => {
    latestLoadMore.current = loadMore;
  });

  React.useEffect(() => saveLtxForm(ltxForm), [ltxForm]);
  React.useEffect(() => {
    window.localStorage.setItem(FORM_KEY, JSON.stringify({ ...form, revision: FORM_REVISION }));
  }, [form]);

  /*
   * The pod's model lists change whenever a download lands, so they
   * are re-read while the tab is open: at once on opening, whenever a download
   * announces itself, on coming back to a hidden browser tab, and otherwise on
   * a slow timer. One read at a time is what counts — a sequence number drops
   * any answer that was overtaken, so a slow reply can never overwrite a newer
   * one — and nothing is read while the document is hidden.
   */
  const catalogRequest = React.useRef(0);
  React.useEffect(() => {
    if (!active || !podReady) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failuresInARow = 0;

    const refresh = async () => {
      clearTimeout(timer);
      timer = undefined;
      // Picked up again by the visibilitychange listener below.
      if (document.hidden) return;
      const request = ++catalogRequest.current;
      const outcome = await settle(() =>
        readCatalog(pinnedPodId ? { backendId: pinnedPodId } : {}),
      );
      if (disposed || request !== catalogRequest.current) return;
      failuresInARow = outcome.ok ? 0 : failuresInARow + 1;
      const failures = failuresInARow;
      setCatalog((previous) => nextCatalog(previous, outcome, failures));
      timer = setTimeout(() => void refresh(), CATALOG_POLL_MS);
    };

    void refresh();
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const stopWatching = onPodCatalogChange(() => void refresh());
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      stopWatching();
    };
  }, [active, podReady, pinnedPodId, readCatalog]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const setMode = (mode: H3Mode) => setForm(withMode(mode));

  const setTurbo = (turbo: boolean) =>
    setForm((previous) => ({
      ...previous,
      turbo,
      steps: turbo ? H3_TURBO_STEPS[previous.mode] : H3_FULL_STEPS,
    }));

  const setPreset = (aspect: H3Aspect | "custom", shortEdge: number) =>
    setForm((previous) =>
      aspect === "custom"
        ? { ...previous, aspect, shortEdge }
        : { ...previous, aspect, shortEdge, ...h3Dimensions(shortEdge, aspect) },
    );

  const addImage = React.useCallback(async (raw: Blob, role: InputRole, sourceUrl?: string) => {
    const image = await prepareInput(raw, role, sourceUrl);
    setInputs((previous) => {
      // First and last frames are single slots; references append.
      const kept = role === "reference" ? previous : previous.filter((item) => item.role !== role);
      for (const dropped of previous) {
        if (!kept.includes(dropped)) URL.revokeObjectURL(dropped.previewUrl);
      }
      const references = kept.filter((item) => item.role === "reference");
      if (role === "reference" && references.length >= H3_LIMITS.references) {
        // Turned away at the limit: nothing will ever show its preview.
        URL.revokeObjectURL(image.previewUrl);
        return kept;
      }
      return [...kept, image];
    });
  }, []);

  // Previews are object URLs, which live as long as the document unless revoked.
  const inputsRef = React.useRef(inputs);
  React.useEffect(() => {
    inputsRef.current = inputs;
  }, [inputs]);
  React.useEffect(() => {
    return () => {
      for (const item of inputsRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  const removeImage = (id: string) =>
    setInputs((previous) => {
      const gone = previous.find((item) => item.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return previous.filter((item) => item.id !== id);
    });

  const addFiles = async (files: File[], role: InputRole) => {
    const images = files.filter(isAttachableImageFile);
    await toastErrors(async () => {
      for (const file of images) await addImage(referenceImageBlob(file), role);
    });
  };

  const pickFile = (role: InputRole) => {
    pickingRole.current = role;
    fileInput.current?.click();
  };

  const addResultAsInput = async (url: string) => {
    // The visible form decides: LTX's sheet mode takes it as the sheet,
    // its other modes as a first frame; H3 as a reference or a first frame.
    let role: InputRole;
    if (family === "ltx") {
      role = ltxForm.mode === "sheet" ? "reference" : "first";
      if (ltxForm.mode === "text") setLtxForm((previous) => ({ ...previous, mode: "frames" }));
    } else {
      role = form.mode === "reference" ? "reference" : "first";
      if (form.mode === "text") setMode("frames");
    }
    const success =
      role === "first"
        ? "Set as the first frame"
        : family === "ltx"
          ? "Set as the reference sheet"
          : "Added as a reference";
    await toastErrors(async () => {
      await addImage(await imageUrlToBlob(url), role, url);
      toast.success(success);
    });
  };

  // An image sent from the API tab: switch to the mode its role needs (a frame
  // means Image → video, a reference means Reference) and attach it. An effect
  // event, so it reads the forms as they are without making them dependencies.
  const receiveHandoff = React.useEffectEvent((next: VideoHandoff) => {
    const { url, role } = next;
    // References exist only on H3 (or as LTX's one reference sheet); a frame
    // goes to whichever family is open.
    const becomesSheet = role === "reference" && family === "ltx" && ltxForm.mode === "sheet";
    if (becomesSheet) {
      // stays: the image becomes the sheet
    } else if (role === "reference") {
      setFamily("h3");
      setMode("reference");
    } else if (family === "ltx") {
      setLtxForm((previous) => ({ ...previous, mode: "frames" }));
    } else {
      setMode("frames");
    }
    const success =
      role === "reference"
        ? "Added as a reference — tag it in the prompt with @image"
        : role === "first"
          ? "Set as the start frame"
          : "Set as the last frame";
    void toastErrors(async () => {
      await addImage(await imageUrlToBlob(url), role, url);
      toast.success(success);
    }).then(() => onHandoffHandled?.());
  });
  const handledHandoff = React.useRef(0);
  React.useEffect(() => {
    if (!handoff || handledHandoff.current === handoff.seq) return;
    handledHandoff.current = handoff.seq;
    receiveHandoff(handoff);
  }, [handoff]);

  // Reproduce: the row carries every setting and, once finished, its input
  // images in B2 in the same order as h3InputRoles. All are prepared first and
  // set at once, in that order — appended as each download finished, a small
  // second reference would overtake the first and swap what @image1 means.
  const restoreSeq = React.useRef(0);
  const restoreInputs = React.useCallback(
    async (keys: string[], roles: InputRole[]): Promise<void> => {
      const seq = ++restoreSeq.current;
      setInputs((previous) => {
        for (const item of previous) URL.revokeObjectURL(item.previewUrl);
        return [];
      });
      const restored = await Promise.allSettled(
        keys.map(async (key, index) => {
          const url = mediaUrl(key);
          return prepareInput(await imageUrlToBlob(url), roles[index] ?? "reference", url);
        }),
      );
      const images = restored.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (seq !== restoreSeq.current) {
        for (const image of images) URL.revokeObjectURL(image.previewUrl);
        return;
      }
      setInputs(images);
      if (images.length < keys.length) {
        toast.error("Some input images could not be restored — check the @image tags");
      }
    },
    [],
  );
  const reproduceDoc = useQuery(
    api.grokGenerations.get,
    active && reproduceId ? { id: reproduceId } : "skip",
  );
  const restoreLtx = (settings: Parameters<typeof normalizeLtxSettings>[0]) => {
    const restored = normalizeLtxSettings(settings);
    setFamily("ltx");
    setLtxForm((previous) => ({
      ...previous,
      ...restored,
      aspect: "custom",
      shortEdge: Math.min(restored.width, restored.height),
      count: 1,
    }));
  };
  const restoreH3 = (settings: NonNullable<GenerationDoc["h3Settings"]>) => {
    setFamily("h3");
    setForm((previous) => ({
      ...previous,
      ...normalizeH3Settings(settings),
      aspect: "custom",
      shortEdge: Math.min(settings.width, settings.height),
      count: 1,
    }));
  };
  const reproduce = React.useEffectEvent((doc: GenerationDoc | null) => {
    if (doc?.ltxSettings) {
      restoreLtx(doc.ltxSettings);
      void restoreInputs(doc.referenceB2Keys ?? [], doc.h3InputRoles ?? []).finally(() =>
        onReproduceHandled?.(),
      );
      toast.success("Settings restored");
      return;
    }
    if (!doc?.h3Settings) {
      toast.error(doc ? "This clip has no settings to reproduce" : "That clip is gone");
      onReproduceHandled?.();
      return;
    }
    restoreH3(doc.h3Settings);
    void restoreInputs(doc.referenceB2Keys ?? [], doc.h3InputRoles ?? []).finally(() =>
      onReproduceHandled?.(),
    );
    toast.success("Settings restored");
  });
  const handledReproduce = React.useRef<string | null>(null);
  React.useEffect(() => {
    // The param is cleared once handled; forgetting it here lets the same clip
    // be reproduced again from a link later.
    if (!reproduceId) handledReproduce.current = null;
    if (!active || !reproduceId || reproduceDoc === undefined) return;
    if (handledReproduce.current === reproduceId) return;
    handledReproduce.current = reproduceId;
    reproduce(reproduceDoc as GenerationDoc | null);
  }, [active, reproduceId, reproduceDoc]);

  const first = inputs.find((item) => item.role === "first");
  const last = inputs.find((item) => item.role === "last");
  const references = inputs.filter((item) => item.role === "reference");
  const ltxActive = family === "ltx";
  const activeMode = ltxActive ? ltxForm.mode : form.mode;
  // LTX's sheet is one image: the latest reference added replaces the last.
  const sheet = references.at(-1);
  const visibleInputs =
    activeMode === "frames"
      ? inputs.filter((item) => item.role !== "reference")
      : activeMode === "reference"
        ? references
        : activeMode === "sheet" && sheet
          ? [sheet]
          : [];

  const frames = h3FrameCount(form.durationSeconds);
  const pinnedProblem =
    pinnedUnavailable && podReady
      ? "The pod picked in “Run on” is not ready — pick Auto or another pod"
      : null;
  const problems = [
    ...(pinnedProblem ? [pinnedProblem] : []),
    ...(ltxActive
      ? ltxProblems(ltxForm, { podReady, catalog: catalog?.ltx ?? null, first, last, sheet })
      : ([
          !podReady && "Start the video pod first",
          !form.prompt.trim() && "Write a prompt",
          form.mode === "frames" && !first && !last && "Add a first or last frame",
          form.mode === "reference" && references.length === 0 && "Add a reference image",
          form.mode === "reference" && h3ReferenceTagProblem(form.prompt, references.length),
        ].filter(Boolean) as string[])),
  ];

  // Every await below has a time limit (submit-guards), so the button always
  // comes back — an upload or a mutation stuck on a dropped connection used to
  // leave it spinning until a reload.
  const generate = async () => {
    if (problems.length > 0 || submitting) return;
    await toastErrors(async () => {
      const uploaded = [];
      for (const [index, image] of visibleInputs.entries()) {
        setSubmitting(`Uploading image ${index + 1} of ${visibleInputs.length}…`);
        const url = await withServerTimeout(uploadUrl({}));
        const storageId = await uploadToStorage(url, image.blob, "Failed to upload an input image");
        uploaded.push({
          storageId,
          role: image.role,
          sourceKey: referenceOutputKey(image.sourceUrl),
        });
      }
      setSubmitting("Queuing on the video pod…");
      let count: number;
      if (ltxActive) {
        const { aspect: _a, shortEdge: _s, count: ltxCount, ...settings } = ltxForm;
        count = ltxCount;
        await withServerTimeout(
          startLtxJob({ settings, inputs: uploaded, count, backendId: pinnedPod?._id }),
        );
      } else {
        const { aspect: _aspect, shortEdge: _shortEdge, count: h3Count, ...settings } = form;
        count = h3Count;
        await withServerTimeout(
          startJob({ settings, inputs: uploaded, count, backendId: pinnedPod?._id }),
        );
      }
      toast.success(count > 1 ? `${count} clips queued` : "Clip queued");
    });
    setSubmitting(null);
  };

  const checkpoints = catalog?.checkpoints ?? [];
  const checkpointOptions = checkpoints.map((name) => ({
    value: name,
    label: name.replace(/\.safetensors$/, ""),
    description:
      name === H3_BASE_FILES.fl2va
        ? "Official H3 · text and image to video"
        : name === H3_BASE_FILES.ref2va
          ? "Official H3 · reference to video"
          : /^minimax_h3_fl2va_pruned_fp8/.test(name)
            ? "Official H3 · fp8 · text/image to video — fastest on B300"
            : /^minimax_h3_ref2va_pruned_fp8/.test(name)
              ? "Official H3 · fp8 · reference to video — fastest on B300"
              : "Custom checkpoint",
  }));
  // The official builds in either precision: same recipe, so the green marks apply.
  const customCheckpoint =
    !/^minimax_h3_(fl2va|ref2va)_pruned_(int8_convrot|fp8_scaled)\.safetensors$/.test(
      form.checkpoint,
    );

  // What "recommended" means here, and the advice shown under each control.
  // A custom checkpoint has its own recipe on its model page, so only the
  // official model gets the green marks.
  const recommended = recommendedFor(form.mode);
  const isRecommended = <K extends keyof typeof recommended>(key: K) =>
    !customCheckpoint && form[key] === recommended[key];
  const looksTurboMerge = customCheckpoint && /turbo|distill|lightning|fast/i.test(form.checkpoint);
  const looksVsaTrained = /fasth3|vsa/i.test(form.checkpoint);
  // B300 (Blackwell Ultra) has almost no INT8 throughput: int8 checkpoints and
  // the INT8 attention run ~4× slower there than fp8 (measured 2026-10-12).
  // On Auto, warn when any running pod is a B300 — a clip may land there.
  const weakInt8 = (pinnedPod ? [pinnedPod] : readyPods).some((p) => /B300/i.test(p.gpuName));
  const advice: Record<
    "turbo" | "steps" | "shift" | "fast" | "sparse" | "easyCache",
    Advice | null
  > = {
    turbo:
      form.turbo && looksTurboMerge
        ? {
            kind: "warn",
            text: "This checkpoint looks like a turbo merge already — Turbo on top over-sharpens. Switch it off.",
          }
        : null,
    steps:
      !form.turbo && !looksTurboMerge && form.steps < 15
        ? {
            kind: "warn",
            text: `Without Turbo the model needs 20–25 steps; ${form.steps} will look unfinished.`,
          }
        : form.turbo && form.steps > H3_TURBO_STEPS[form.mode] + 4
          ? {
              kind: "tip",
              text: `Turbo is tuned for ${H3_TURBO_STEPS[form.mode]} steps — more mostly costs time.`,
            }
          : null,
    shift:
      form.shiftEnabled && !customCheckpoint
        ? {
            kind: "tip",
            text: "The official model already has its own schedule; shift is for checkpoints that ask for it.",
          }
        : customCheckpoint && !form.shiftEnabled
          ? {
              kind: "tip",
              text: "Community checkpoints usually list a shift (often 10/3) on their model page.",
            }
          : null,
    fast: weakInt8
      ? form.fastAttention
        ? {
            kind: "warn",
            text: "Turn it off on B300: this INT8 attention runs ~2× slower there than the default one.",
          }
        : null
      : form.fastAttention
        ? null
        : { kind: "tip", text: "Turn it on: about 27% faster, no visible loss." },
    sparse:
      form.sparseAttention === "vsa" && !looksVsaTrained
        ? {
            kind: "warn",
            text: "VSA only works with VSA-trained weights (FastH3). Use SOL for this checkpoint.",
          }
        : form.sparseAttention === "off" && form.durationSeconds >= 10
          ? {
              kind: "tip",
              text: "For clips of 10 s and more, SOL is 1.5–2× faster at a small cost in fine detail.",
            }
          : null,
    easyCache: form.easyCache
      ? {
          kind: "tip",
          text: "Fine for drafts; turn off for the final render if motion looks soft.",
        }
      : null,
  };
  const settingsAreRecommended =
    !customCheckpoint &&
    (Object.keys(recommended) as (keyof typeof recommended)[]).every((key) => isRecommended(key));

  const composer = (
    <div className="min-w-0 lg:flex lg:h-full lg:flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 lg:px-4">
        {tabs}
        <span className="ml-auto">
          <VideoPodStatus />
        </span>
      </div>
      <div
        className="flex-1 space-y-4 overflow-y-auto px-3 py-3 pb-24 lg:px-4 lg:pb-4"
        // A pasted image lands where an image makes sense in the current mode;
        // text pastes fall through to whichever field has focus.
        onPaste={(event) => {
          if (activeMode === "text" || event.defaultPrevented) return;
          const target = event.target;
          const intoTextField =
            target instanceof HTMLElement &&
            (target.matches("input, textarea") || target.isContentEditable);
          const files = pastedImageFiles(event.clipboardData, intoTextField);
          if (files.length === 0) return;
          event.preventDefault();
          void addFiles(
            files,
            activeMode === "reference" || activeMode === "sheet"
              ? "reference"
              : first
                ? "last"
                : "first",
          );
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void addFiles(files, pickingRole.current);
          }}
        />

        <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1">
          {(
            [
              ["h3", "MiniMax H3", "Sound + references, up to 15 s"],
              ["ltx", "LTX 2.3", "Up to 20 s, 1080p"],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFamily(value)}
              className={cn(
                "flex flex-col items-center rounded-md px-2 py-1 text-xs transition-colors",
                family === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span className="font-medium">{label}</span>
              <span
                className={cn(
                  "text-[10px]",
                  family === value ? "text-primary-foreground/80" : "text-muted-foreground",
                )}
              >
                {hint}
              </span>
            </button>
          ))}
        </div>

        {(readyPods.length > 1 || (pinnedUnavailable && podReady)) && (
          <Field
            label="Run on"
            hint={
              pinnedUnavailable
                ? "The pod picked here is not ready any more — choose Auto or a running pod."
                : pinnedPod
                  ? "Every clip from this form goes to this pod."
                  : "Each clip goes to the least busy pod that has every model it needs."
            }
          >
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant={runOn === "auto" ? "default" : "outline"}
                className="h-7 px-2 text-[11px]"
                onClick={() => setRunOn("auto")}
              >
                Auto
              </Button>
              {readyPods.map((candidate) => (
                <Button
                  key={candidate._id}
                  size="sm"
                  variant={runOn === candidate._id ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setRunOn(candidate._id)}
                >
                  {videoPodLabel(candidate)}
                </Button>
              ))}
            </div>
          </Field>
        )}

        {ltxActive ? (
          <LtxComposer
            form={ltxForm}
            setForm={setLtxForm}
            first={first}
            last={last}
            sheet={sheet}
            catalog={catalog?.ltx ?? null}
            catalogError={catalog?.error}
            podReady={podReady}
            onPick={(role) => pickFile(role)}
            onGallery={(role) => setPickerRole(role)}
            onClear={(id) => removeImage(id)}
          />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-1 rounded-md border bg-card p-0.5">
              {H3_MODES.map((mode) => (
                <Button
                  key={mode.value}
                  size="sm"
                  variant={form.mode === mode.value ? "default" : "ghost"}
                  className="h-7 text-[11px] font-normal"
                  title={mode.hint}
                  onClick={() => setMode(mode.value)}
                >
                  {mode.label}
                </Button>
              ))}
            </div>

            {form.mode === "frames" && (
              <div className="grid grid-cols-2 gap-3">
                <ImageSlot
                  label="First frame"
                  image={first}
                  onUpload={() => pickFile("first")}
                  onGallery={() => setPickerRole("first")}
                  onClear={() => first && removeImage(first.id)}
                />
                <ImageSlot
                  label="Last frame"
                  image={last}
                  onUpload={() => pickFile("last")}
                  onGallery={() => setPickerRole("last")}
                  onClear={() => last && removeImage(last.id)}
                />
              </div>
            )}
            {form.mode === "reference" && (
              <div
                className={cn(
                  "space-y-1.5 rounded-lg transition-colors",
                  dragging && "bg-primary/5 ring-2 ring-primary",
                )}
                onDragOver={(event) => {
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
                  void addFiles([...event.dataTransfer.files], "reference");
                }}
              >
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {references.map((image, index) => (
                    <ImageSlot
                      key={image.id}
                      label={`Reference ${index + 1}`}
                      badge={index + 1}
                      image={image}
                      onUpload={() => undefined}
                      onGallery={() => undefined}
                      onClear={() => removeImage(image.id)}
                    />
                  ))}
                  {references.length < H3_LIMITS.references && (
                    <ImageSlot
                      label={`Add (${references.length}/${H3_LIMITS.references})`}
                      onUpload={() => pickFile("reference")}
                      onGallery={() => setPickerRole("reference")}
                      onClear={() => undefined}
                    />
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Type @ in the prompt to tag a reference — @image1 is the first. Drop or paste
                  images here too.
                </p>
              </div>
            )}

            <Field
              label="Checkpoint"
              advice={
                weakInt8 && /int8/i.test(form.checkpoint)
                  ? {
                      kind: "warn",
                      text: "int8 models run ~4× slower on B300 — pick the _fp8_scaled one (207 s → 54 s measured).",
                    }
                  : null
              }
              hint={
                catalog?.error ??
                (customCheckpoint
                  ? "Custom checkpoints are often turbo merges already — check its model page and switch Turbo off if so."
                  : undefined)
              }
            >
              <SearchableSelect
                value={form.checkpoint}
                onValueChange={(value) => update("checkpoint", value)}
                options={checkpointOptions}
                placeholder={
                  podReady ? "Choose a checkpoint…" : "Start the video pod to list models"
                }
                emptyMessage="No H3 checkpoints on the pod"
              />
            </Field>

            <Field label="LoRAs">
              <H3LoraStack
                loras={form.loras}
                available={catalog?.loras ?? []}
                onChange={(loras) => update("loras", loras)}
              />
            </Field>

            <div className="space-y-1.5">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <Label htmlFor="h3-prompt" className="text-xs">
                  Prompt
                </Label>
                <div className="flex items-center gap-1">
                  <PromptEnhanceButton
                    value={form.prompt}
                    onReplace={(text) => update("prompt", text)}
                    context={{
                      media: "video",
                      targetModel: "MiniMax H3",
                      duration: form.durationSeconds,
                      aspectRatio: form.aspect === "custom" ? undefined : form.aspect,
                      referenceCount: form.mode === "reference" ? references.length : undefined,
                      frameInputs:
                        form.mode !== "frames"
                          ? undefined
                          : first && last
                            ? "both"
                            : first
                              ? "first"
                              : last
                                ? "last"
                                : undefined,
                    }}
                  />
                  <PromptLibrary value={form.prompt} onInsert={(text) => update("prompt", text)} />
                </div>
              </div>
              <PromptInput
                id="h3-prompt"
                className="[&_textarea]:min-h-[120px]"
                value={form.prompt}
                onChange={(value) => update("prompt", value)}
                // Tags only where H3 reads them: in the other modes a tag would be
                // highlighted as valid and then sent as literal text.
                references={form.mode === "reference" ? references : []}
                placeholder={
                  form.mode === "reference"
                    ? "Describe the action in order — type @ to tag a reference (@image1 is the first). Every motion and sound, dialogue in quotes."
                    : "Describe the action in order, every motion and every sound — H3 rewards long, literal prompts. Dialogue in quotes."
                }
              />
            </div>

            <Field
              label="Size"
              hint={`${form.width}×${form.height} · H3's native ceiling is 768×1344; larger is slower and untrained.`}
            >
              <div className="flex flex-wrap gap-1">
                {H3_ASPECTS.map((aspect) => (
                  <Button
                    key={aspect}
                    size="sm"
                    variant={form.aspect === aspect ? "default" : "outline"}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setPreset(aspect, form.shortEdge)}
                  >
                    {aspect}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant={form.aspect === "custom" ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setPreset("custom", form.shortEdge)}
                >
                  Custom
                </Button>
              </div>
              {form.aspect === "custom" ? (
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput
                    value={form.width}
                    min={H3_LIMITS.dimension.min}
                    max={H3_LIMITS.dimension.max}
                    step={32}
                    onChange={(value) => update("width", value)}
                  />
                  <NumberInput
                    value={form.height}
                    min={H3_LIMITS.dimension.min}
                    max={H3_LIMITS.dimension.max}
                    step={32}
                    onChange={(value) => update("height", value)}
                  />
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {H3_SHORT_EDGES.map((edge) => (
                    <Button
                      key={edge}
                      size="sm"
                      variant={form.shortEdge === edge ? "default" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      onClick={() => setPreset(form.aspect, edge)}
                    >
                      {edge}p
                    </Button>
                  ))}
                </div>
              )}
            </Field>

            <Field
              label={`Duration · ${form.durationSeconds} s · ${frames} frames at 24 fps`}
              hint={
                form.durationSeconds > 15
                  ? "Past 15 s is outside H3's trained range — expect drift."
                  : "Time grows faster than length: 10 s takes about three times a 5 s clip."
              }
            >
              <Slider
                value={[form.durationSeconds]}
                min={H3_LIMITS.durationSeconds.min}
                max={H3_LIMITS.durationSeconds.max}
                step={1}
                onValueChange={(value) =>
                  update("durationSeconds", Array.isArray(value) ? value[0] : (value as number))
                }
              />
            </Field>

            <div className="flex items-center justify-between gap-2 border-t pt-3">
              <div>
                <p className="text-xs font-medium">Quality and speed</p>
                <p className="text-[11px] text-muted-foreground">
                  {customCheckpoint
                    ? "Custom checkpoint: follow the settings on its model page."
                    : settingsAreRecommended
                      ? "Recommended settings for the official model."
                      : "Changed from the recommended settings."}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={settingsAreRecommended}
                title="Turbo on, fast attention on, sparse attention and EasyCache off, shift off"
                onClick={() =>
                  setForm((previous) => ({ ...previous, ...recommendedFor(previous.mode) }))
                }
              >
                <RotateCcw className="h-3 w-3" /> Recommended settings
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle
                label="Turbo"
                hint={`Speed-up LoRA: ${form.mode === "reference" ? "4" : "8"} steps instead of 20–25, about 2× faster, slightly less detail.`}
                recommended={isRecommended("turbo")}
                advice={advice.turbo}
                checked={form.turbo}
                onChange={setTurbo}
              />
              <Toggle
                label="Audio"
                hint="Off removes the soundtrack; it does not render faster."
                checked={form.audio}
                onChange={(value) => update("audio", value)}
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Steps" recommended={isRecommended("steps")}>
                <NumberInput
                  value={form.steps}
                  min={H3_LIMITS.steps.min}
                  max={H3_LIMITS.steps.max}
                  onChange={(value) => update("steps", value)}
                />
              </Field>
              <Field label="Sampler" recommended={isRecommended("sampler")}>
                <SearchableSelect
                  value={form.sampler}
                  onValueChange={(value) => update("sampler", value)}
                  options={[...H3_SAMPLERS]}
                />
              </Field>
              <Field label="Scheduler" recommended={isRecommended("scheduler")}>
                <SearchableSelect
                  value={form.scheduler}
                  onValueChange={(value) => update("scheduler", value)}
                  options={[...H3_SCHEDULERS]}
                />
              </Field>
            </div>
            <AdviceLine advice={advice.steps} />

            <div className="space-y-2 rounded-md border p-3">
              <Toggle
                label="Sigma shift"
                hint="Overrides how the noise is spread over the steps. Off = the model's own schedule."
                recommended={isRecommended("shiftEnabled")}
                advice={advice.shift}
                checked={form.shiftEnabled}
                onChange={(value) => update("shiftEnabled", value)}
              />
              {form.shiftEnabled && (
                <div className="grid grid-cols-2 gap-2">
                  <Field
                    label="Video shift"
                    hint="Higher favours overall composition and motion, lower fine detail. Usually 10–12."
                  >
                    <NumberInput
                      value={form.shiftVideo}
                      min={H3_LIMITS.shift.min}
                      max={H3_LIMITS.shift.max}
                      step={0.5}
                      onChange={(value) => update("shiftVideo", value)}
                    />
                  </Field>
                  <Field label="Audio shift" hint="The same for the soundtrack. Usually 3–5.">
                    <NumberInput
                      value={form.shiftAudio}
                      min={H3_LIMITS.shift.min}
                      max={H3_LIMITS.shift.max}
                      step={0.5}
                      onChange={(value) => update("shiftAudio", value)}
                    />
                  </Field>
                </div>
              )}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-medium">Speed</p>
              <Toggle
                label="Fast attention (Comfy Kitchen INT8)"
                hint="About 27% faster with no visible loss in our tests."
                recommended={isRecommended("fastAttention")}
                advice={advice.fast}
                checked={form.fastAttention}
                onChange={(value) => update("fastAttention", value)}
              />
              <Field
                label="Sparse attention"
                recommended={isRecommended("sparseAttention")}
                advice={advice.sparse}
                hint={
                  form.sparseAttention === "vsa"
                    ? "VSA needs FastH3-trained weights; keep % of video cubes (trained at 10)."
                    : form.sparseAttention === "sol-attn"
                      ? "Training-free; higher tau is sparser and faster (1.0 ≈ 16% exact)."
                      : "Computes only the strongest links between frames. SOL: any model. VSA: VSA-trained weights only."
                }
              >
                <div className="flex gap-1">
                  {(["off", "sol-attn", "vsa"] as const).map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={form.sparseAttention === value ? "default" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      onClick={() =>
                        setForm((previous) => ({
                          ...previous,
                          sparseAttention: value,
                          sparseValue:
                            value === "vsa"
                              ? 10
                              : value === "sol-attn"
                                ? 1.3
                                : previous.sparseValue,
                        }))
                      }
                    >
                      {value === "off" ? "Off" : value === "sol-attn" ? "SOL" : "VSA"}
                    </Button>
                  ))}
                </div>
                {form.sparseAttention !== "off" && (
                  <NumberInput
                    value={form.sparseValue}
                    min={
                      form.sparseAttention === "vsa"
                        ? H3_LIMITS.sparseKeepPercent.min
                        : H3_LIMITS.sparseTau.min
                    }
                    max={
                      form.sparseAttention === "vsa"
                        ? H3_LIMITS.sparseKeepPercent.max
                        : H3_LIMITS.sparseTau.max
                    }
                    step={form.sparseAttention === "vsa" ? 0.5 : 0.05}
                    onChange={(value) => update("sparseValue", value)}
                  />
                )}
              </Field>
              <Toggle
                label="EasyCache"
                hint="Reuses steps that barely change; faster, can soften fine motion."
                recommended={isRecommended("easyCache")}
                advice={advice.easyCache}
                checked={form.easyCache}
                onChange={(value) => update("easyCache", value)}
              />
              {form.easyCache && (
                <Field label="Reuse threshold">
                  <NumberInput
                    value={form.easyCacheThreshold}
                    min={H3_LIMITS.easyCacheThreshold.min}
                    max={H3_LIMITS.easyCacheThreshold.max}
                    step={0.05}
                    onChange={(value) => update("easyCacheThreshold", value)}
                  />
                </Field>
              )}
            </div>

            <div className="space-y-2 rounded-md border border-violet-500/30 bg-violet-500/[0.03] p-3">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-medium">Community add-ons</p>
                <CommunityMark />
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Third-party models and nodes from the H3 community — not part of official H3. Off by
                default; try them one at a time.
              </p>
              <Toggle
                label="Smooth 48 fps (RIFE)"
                hint="Doubles the frame rate after rendering — fluid motion, a few seconds extra."
                community
                checked={form.interpolate}
                disabled={!catalog?.extras?.rife && !form.interpolate}
                advice={
                  podReady && catalog && !catalog.extras?.rife
                    ? {
                        kind: "warn",
                        text: "Not on this pod — it booted before RIFE was added. Start a new pod.",
                      }
                    : null
                }
                onChange={(value) => update("interpolate", value)}
              />
              <Toggle
                label="Upscale 2× (two-pass)"
                hint="Renders at half size, upscales the latent with a trained H3 upscaler, then refines 3 steps at full size. Sharper detail; often faster too."
                community
                checked={form.upscale}
                disabled={!catalog?.extras?.upscaler && !form.upscale}
                advice={
                  podReady && catalog && !catalog.extras?.upscaler
                    ? {
                        kind: "warn",
                        text: "Not on this pod — it booted before the upscaler was added. Start a new pod.",
                      }
                    : null
                }
                onChange={(value) => update("upscale", value)}
              />
            </div>

            {form.mode === "reference" && (
              <Field
                label="Reference size"
                hint="Max keeps references at 2048 px for identity; it can be several times slower."
              >
                <div className="flex gap-1">
                  {(["match", "max"] as const).map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={form.referenceSize === value ? "default" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      onClick={() => update("referenceSize", value)}
                    >
                      {value === "match" ? "Match output" : "Max"}
                    </Button>
                  ))}
                </div>
              </Field>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Field label="Seed" hint={form.seed === -1 ? "Random each time" : undefined}>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    className="h-8"
                    value={form.seed === -1 ? "" : form.seed}
                    placeholder="random"
                    onChange={(event) =>
                      update(
                        "seed",
                        event.target.value === ""
                          ? -1
                          : Math.max(0, Math.round(Number(event.target.value))),
                      )
                    }
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label="Random seed"
                    onClick={() => update("seed", -1)}
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Field>
              <Field label="Clips">
                <div className="flex gap-1">
                  {[1, 2, 3, 4].map((count) => (
                    <Button
                      key={count}
                      size="sm"
                      variant={form.count === count ? "default" : "outline"}
                      className="h-8 flex-1 px-0 text-xs"
                      onClick={() => update("count", count)}
                    >
                      {count}
                    </Button>
                  ))}
                </div>
              </Field>
            </div>
          </>
        )}

        <div className="space-y-1">
          <Button
            size="lg"
            className="h-12 w-full text-lg font-semibold"
            disabled={problems.length > 0 || submitting !== null}
            onClick={() => void generate()}
          >
            {submitting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" /> {submitting}
              </>
            ) : (
              <>
                <Video className="h-5 w-5" /> Generate video
              </>
            )}
          </Button>
          {problems.length > 0 && (
            <p className="text-center text-[11px] text-muted-foreground">{problems[0]}</p>
          )}
        </div>
      </div>
    </div>
  );

  // Every callback here depends only on setters, mutations and the list, so
  // with the compiler memoizing this component the grid's props hold still
  // while the form is being edited — the grid re-renders when its rows do.
  const grid = (
    <div className="min-w-0 lg:h-full lg:overflow-y-auto lg:[scrollbar-gutter:stable]">
      <ApiResults
        active={active}
        generations={results}
        canLoadMore={listStatus === "CanLoadMore"}
        isLoadingMore={listStatus === "LoadingMore"}
        onLoadMore={(numItems) => latestLoadMore.current(numItems)}
        onRecreate={(gen) => {
          handledReproduce.current = null;
          if (gen.ltxSettings) {
            restoreLtx(gen.ltxSettings);
            void restoreInputs(gen.referenceB2Keys ?? [], gen.h3InputRoles ?? []);
            toast.success("Settings restored");
            return;
          }
          if (!gen.h3Settings) {
            toast.error("Legacy Wan clips cannot be reproduced on H3");
            return;
          }
          restoreH3(gen.h3Settings);
          void restoreInputs(gen.referenceB2Keys ?? [], gen.h3InputRoles ?? []);
          toast.success("Settings restored");
        }}
        onRemove={async (gen) => {
          // An unfinished clip is also taken off the pod (grokGenerations.remove).
          if (
            (gen.status === "pending" || gen.status === "processing") &&
            !window.confirm("Cancel this clip on the video pod?")
          ) {
            return false;
          }
          return toastErrors(async () => {
            await removeGeneration({ id: gen._id });
          });
        }}
        onRemoveMany={(gens) =>
          toastErrors(async () => {
            await removeMany({ ids: gens.map((gen) => gen._id) });
          })
        }
        onUseAsReference={(url) => void addResultAsInput(url)}
        // Only this tab's failures: the shared removeAllFailed would also clear
        // failed API jobs the user may still want to read.
        onRemoveAllFailed={() => {
          const failed = results.filter((gen) => gen.status === "failed");
          if (failed.length === 0) return;
          setRemovingFailed(true);
          void removeMany({ ids: failed.map((gen) => gen._id) })
            .catch((error) => toast.error(errorText(error)))
            .finally(() => setRemovingFailed(false));
        }}
        isRemovingFailed={removingFailed}
      />
    </div>
  );

  return (
    <>
      <GenerateSplit storageKey="generate-split-video" className="lg:h-[calc(100vh-3.5rem)]">
        {composer}
        {grid}
      </GenerateSplit>
      {pickerRole && (
        <ReferencePicker
          onClose={() => setPickerRole(null)}
          onPick={(url) => {
            const role = pickerRole;
            setPickerRole(null);
            void imageUrlToBlob(url)
              .then((blob) => addImage(blob, role, url))
              .catch((error) => toast.error(errorText(error)));
          }}
        />
      )}
    </>
  );
}
