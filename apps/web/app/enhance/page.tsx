"use client";

import * as React from "react";
import { Suspense } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Upload,
  ImageIcon,
  ArrowUpCircle,
  Sparkles,
  User,
  X,
  Dice5,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { LoraStack } from "@/components/lora-stack";
import { ImageLightbox } from "@/components/image-lightbox";
import { ImageGrid, ImageGridItem } from "@/components/image-grid";
import { BackendStatus } from "@/components/backend-status";

import { useMutation, useQuery, useConvexAuth, type ReactMutation } from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { GenerateFormState } from "@/lib/types";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { useStableRows } from "@/hooks/use-stable-rows";
import { queueApiReference, readEnhanceReproduceId } from "@/lib/reference-handoff";
import { onPodCatalogChange, podCatalogUrl } from "@/lib/pod-catalog-version";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import {
  FACE_FIX_DEFAULTS,
  type FaceFixDetail,
  type FaceFixDetector,
} from "@/lib/enhance-workflows";

/** What the Face Fix panel controls. Defaults come from the graph that runs it. */
interface FaceFixSettings {
  detail: FaceFixDetail;
  detector: FaceFixDetector;
  denoise: number;
  refineEyes: boolean;
}

const MEDIA_BASE = process.env.NEXT_PUBLIC_MEDIA_URL;
/** Rewrite CDN URLs to same-origin proxy to bypass CORS */
function proxyUrl(url: string): string {
  if (MEDIA_BASE && url.startsWith(MEDIA_BASE)) {
    return `/api/images/${url.slice(MEDIA_BASE.length + 1)}`;
  }
  return url;
}

type EnhanceMode = "img2img" | "upscale" | "refine" | "facefix";

const MODE_META: Record<EnhanceMode, { label: string; icon: React.ElementType }> = {
  img2img: { label: "Img2Img", icon: ImageIcon },
  upscale: { label: "Upscale", icon: ArrowUpCircle },
  refine: { label: "Refine", icon: Sparkles },
  facefix: { label: "Face Fix", icon: User },
};

const DEFAULT_FORM_STATE: GenerateFormState = {
  checkpoint: "",
  prompt: "",
  negativePrompt: "",
  width: 1024,
  height: 1024,
  seed: -1,
  batchSize: 1,
  steps: 20,
  cfg: 7,
  sampler: "",
  scheduler: "",
  denoise: 0.5,
  loras: [],
};

const FORM_STORAGE_KEY = "artsnack_enhance_form_state";

interface PodCatalog {
  /** null when /api/models did not answer OK — nothing to seed the form with. */
  models: { checkpoints: string[]; samplers: string[]; schedulers: string[] } | null;
  loras: string[] | null;
  /**
   * A request that never answered at all, as opposed to one that answered with
   * an error status — only the former is worth a toast, which is what the
   * sequential version did.
   */
  unreachable: boolean;
}

/**
 * The pod catalog, fetched at module scope: `||` inside a `try` is by itself
 * enough for React Compiler to give up on the enclosing component.
 */
async function fetchModels(): Promise<{ models: PodCatalog["models"]; unreachable: boolean }> {
  try {
    const res = await fetch(podCatalogUrl("/api/models"));
    if (!res.ok) return { models: null, unreachable: false };
    const data = await res.json();
    return {
      models: {
        checkpoints: data.checkpoints || [],
        samplers: data.samplers || [],
        schedulers: data.schedulers || [],
      },
      unreachable: false,
    };
  } catch (error) {
    console.error("Failed to fetch models:", error);
    return { models: null, unreachable: true };
  }
}

async function fetchLoras(): Promise<{ loras: string[] | null; unreachable: boolean }> {
  try {
    const res = await fetch(podCatalogUrl("/api/loras"));
    if (!res.ok) return { loras: null, unreachable: false };
    const data = await res.json();
    return { loras: data.loras || [], unreachable: false };
  } catch (error) {
    console.error("Failed to fetch loras:", error);
    return { loras: null, unreachable: true };
  }
}

/**
 * The two lists are independent and live on the same pod, so they go out
 * together — in series they doubled the time the dropdowns spend showing
 * "Loading checkpoints...". They settle independently as well: a failing
 * /api/loras must still leave the model dropdowns populated, which is what a
 * single rejection-propagating Promise.all took away.
 */
async function fetchPodCatalog(): Promise<PodCatalog> {
  const [models, loras] = await Promise.all([fetchModels(), fetchLoras()]);
  return {
    models: models.models,
    loras: loras.loras,
    unreachable: models.unreachable || loras.unreachable,
  };
}

interface EnhanceRequest {
  inputImage: string | null;
  inputImageFile: File | null;
  mode: EnhanceMode;
  backend: "comfyui";
  formState: GenerateFormState;
  scale: 2 | 4;
  refineDenoise: number;
  faceFix: FaceFixSettings;
  sourceFormState: GenerateFormState | null;
  sourceB2Key: string | null;
  isAuthenticated: boolean;
  saveEnhancement: ReactMutation<typeof api.enhancements.save>;
}

/**
 * The submit body runs at module scope, outside the component. React Compiler
 * cannot lower a `try` with a finalizer, nor a `throw` inside a `try`, and this
 * function has both — inside the component that cost the whole page its
 * automatic memoization, not just this handler.
 *
 * It rejects with the message to show. The pending counter belongs to the
 * component, so its reset is a `.finally()` on the returned promise instead.
 */
async function runEnhancement(req: EnhanceRequest): Promise<void> {
  const formData = new FormData();
  formData.append("mode", req.mode);
  formData.append("backend", req.backend);

  if (req.inputImageFile) {
    formData.append("inputImage", req.inputImageFile);
  } else if (req.inputImage) {
    const response = await fetch(proxyUrl(req.inputImage));
    const blob = await response.blob();
    formData.append("inputImage", new File([blob], "input.png", { type: "image/png" }));
  }
  // Mode-specific params
  if (req.mode === "img2img") {
    formData.append("prompt", req.formState.prompt);
    formData.append("negativePrompt", req.formState.negativePrompt);
    formData.append("checkpoint", req.formState.checkpoint);
    formData.append("sampler", req.formState.sampler);
    formData.append("scheduler", req.formState.scheduler);
    formData.append("steps", String(req.formState.steps));
    formData.append("cfg", String(req.formState.cfg));
    formData.append("seed", String(req.formState.seed));
    formData.append("denoise", String(req.formState.denoise));
    formData.append("loras", JSON.stringify(req.formState.loras?.filter((l) => l.enabled) || []));
  }
  if (req.mode === "upscale") formData.append("scale", String(req.scale));
  if (req.mode === "refine") formData.append("denoise", String(req.refineDenoise));
  if (req.mode === "facefix") {
    formData.append("denoise", String(req.faceFix.denoise));
    formData.append("faceDetail", req.faceFix.detail);
    formData.append("faceDetector", req.faceFix.detector);
    formData.append("refineEyes", String(req.faceFix.refineEyes));
  }
  if (req.sourceFormState) formData.append("sourceFormState", JSON.stringify(req.sourceFormState));
  const res = await fetch("/api/enhance", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Enhancement failed");

  if (data.warning) toast.warning(data.warning);
  // Save to Convex
  if (req.isAuthenticated && data.b2Keys?.[0]) {
    try {
      await req.saveEnhancement({
        timestamp: Date.now(),
        mode: req.mode,
        // Only store HTTP URLs (from "Send to Enhance"), never data URLs
        sourceImageUrl: req.inputImage && req.inputImage.startsWith("http") ? req.inputImage : "",
        sourceB2Key: req.sourceB2Key || undefined,
        resultB2Key: data.b2Keys[0],
        params: {
          ...req.formState,
          scale: req.scale,
          denoise: req.mode === "img2img" ? Number(req.formState.denoise) : req.refineDenoise,
        },
        backend: req.backend,
        warning: data.warning || undefined,
      });
    } catch (saveError) {
      console.error("Failed to save enhancement to Convex:", saveError);
    }
  }
  toast.success("Enhancement complete!");
}

/**
 * The prompt an enhancement was run with, when it had one.
 *
 * Only img2img takes a prompt; upscale, refine and facefix have none, and an
 * empty string would render a "copy prompt" action that copies nothing.
 */
function promptOf(enhancement: { mode: string; params?: unknown }): string | undefined {
  // Only img2img takes a prompt. `runEnhancement` spreads the whole form state
  // into `params` for every mode, so an upscale carries whatever happened to be
  // typed at the time — offering that as this image's prompt attaches text that
  // had nothing to do with producing it.
  if (enhancement.mode !== "img2img") return undefined;
  const params = enhancement.params as { prompt?: unknown } | undefined;
  return typeof params?.prompt === "string" && params.prompt.trim() ? params.prompt : undefined;
}

const ENHANCE_MODES: EnhanceMode[] = ["img2img", "upscale", "refine", "facefix"];

function isEnhanceMode(value: string): value is EnhanceMode {
  return (ENHANCE_MODES as string[]).includes(value);
}

/**
 * The form fields of a stored `params`, for the mode that produced them.
 *
 * Two fields are not form fields and cannot be spread blindly. `scale` never
 * is. `denoise` is written by runEnhancement as "whichever of the two denoise
 * controls this mode used" — so on an img2img run the stored value *is* the
 * form's denoise and must be restored, while on refine it is the slider's and
 * on upscale and facefix it is a leftover slider value that means nothing.
 * Restoring it into the form in those cases would silently change how much of
 * the source survives the next run.
 */
function stripEnhanceOnlyParams(
  params: Partial<GenerateFormState> & { scale?: unknown; denoise?: number },
  mode: string,
): Partial<GenerateFormState> {
  /*
   * Nothing at all outside img2img.
   *
   * It is the only mode with a form. The web writes its whole form state into
   * `params` regardless of mode, and the phone's processor writes its own
   * fallbacks — a default checkpoint, 20 steps, cfg 7, seed -1 — on every mode
   * too. Spreading either into the img2img form after reproducing an *upscale*
   * replaces settings the user chose with values nothing chose.
   */
  if (mode !== "img2img") return {};
  const { scale: _scale, denoise, ...formFields } = params;
  return typeof denoise === "number" ? { ...formFields, denoise } : formFields;
}

/**
 * The upscale factor, whichever shape it was stored in.
 *
 * The web writes a number and the phone writes `"2"` / `"4"` — see
 * enhanceProcessor, whose validator is a string literal union. Both land in the
 * same table and both show up in this grid.
 */
function readScale(value: unknown): 2 | 4 | null {
  const scale = typeof value === "string" ? Number(value) : value;
  return scale === 2 || scale === 4 ? scale : null;
}

/**
 * Enhancements in flight, at module scope.
 *
 * A run outlives the page that started it: its request keeps going when the
 * user navigates away, and its `.finally()` still fires. The count used to live
 * in component state, seeded from a sessionStorage list — so coming back
 * mid-run seeded a fresh counter with the run, while the run's completion
 * decremented the unmounted instance, and the "Enhancing…" placeholder stayed
 * until a five-minute expiry on some later visit. Module state survives client
 * navigation and is what the completion actually updates. A reload, which the
 * old storage list also survived, aborts the request — the result is saved by
 * this page, after the response — so a placeholder after one was always a
 * phantom.
 */
const pendingRuns = new Set<number>();
const pendingListeners = new Set<() => void>();
let nextRunId = 0;

function subscribePendingRuns(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

const pendingRunCount = () => pendingRuns.size;
const noPendingRuns = () => 0;

function notifyPendingRuns() {
  for (const listener of pendingListeners) listener();
}

/** Registers a run and returns its id. */
function startRun(): number {
  const id = ++nextRunId;
  pendingRuns.add(id);
  notifyPendingRuns();
  return id;
}

function finishRun(id: number) {
  pendingRuns.delete(id);
  notifyPendingRuns();
}

/**
 * Writes the form at most once per pause in typing, rather than serialising the
 * whole form into localStorage on every keystroke. Takes the ref, not the form,
 * so a flush on the way out writes whatever is newest. Module scope keeps the
 * `try` out of the component.
 */
function flushFormState(pending: { current: GenerateFormState | null }) {
  const form = pending.current;
  if (!form) return;
  pending.current = null;
  try {
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(form));
  } catch {
    // Storage full or blocked: the form still works for this visit.
  }
}

const FORM_SAVE_DELAY_MS = 400;
const NO_ENHANCEMENTS: Doc<"enhancements">[] = [];

/**
 * One result tile, memoised on its row and on callbacks that never change. The
 * page re-renders on every keystroke in the prompt box, and every tile used to
 * re-render with it.
 *
 * The tile shows a 512px transform of the result; the lightbox, Send to Enhance
 * and favouriting all keep the original. A 4× upscale is tens of megabytes, and
 * this grid can hold a hundred of them.
 */
const EnhanceResultTile = React.memo(function EnhanceResultTile({
  enhancement,
  index,
  favorited,
  onOpen,
  onSendToEnhance,
  onSendToApi,
  onReproduce,
  onToggleFavorite,
}: {
  enhancement: Doc<"enhancements">;
  index: number;
  favorited: boolean;
  onOpen: (index: number) => void;
  onSendToEnhance: (url: string) => void;
  onSendToApi: (url: string) => void;
  onReproduce: (enhancement: Doc<"enhancements">) => void;
  onToggleFavorite: (enhancement: Doc<"enhancements">) => void;
}) {
  const url = mediaUrl(enhancement.resultB2Key);
  const prompt = promptOf(enhancement);
  return (
    <ImageGridItem
      src={thumbUrl(enhancement.resultB2Key)}
      fallbackSrc={url}
      alt={prompt ?? `Enhanced image ${index + 1}`}
      onClick={() => onOpen(index)}
      onSendToEnhance={() => onSendToEnhance(url)}
      onSendToApi={() => onSendToApi(url)}
      onReproduce={() => onReproduce(enhancement)}
      copyPrompt={prompt}
      isFavorited={favorited}
      onToggleFavorite={() => onToggleFavorite(enhancement)}
    />
  );
});

export default function EnhancePage() {
  return (
    <Suspense fallback={<div className="container max-w-3xl mx-auto py-6 px-4">Loading...</div>}>
      <EnhancePageContent />
    </Suspense>
  );
}

function EnhancePageContent() {
  const { isAuthenticated } = useConvexAuth();
  const saveEnhancement = useMutation(api.enhancements.save);
  const removeEnhancement = useMutation(api.enhancements.remove);
  const enhancements = useCachedQuery(api.enhancements.list);
  const favoriteKeys = useCachedQuery(api.favorites.myKeys);
  const toggleFavorite = useToggleFavorite();
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * An enhancement handed over from Favourites, which has the id and not the row.
   *
   * "skip" until one arrives, so the ordinary visit costs no query.
   */
  const reproduceId = readEnhanceReproduceId(searchParams);
  const handedOver = useQuery(api.enhancements.getById, reproduceId ? { id: reproduceId } : "skip");

  // ── Mode & image state ─────────────────────────────────────
  const [mode, setMode] = React.useState<EnhanceMode>("img2img");
  const [inputImage, setInputImage] = React.useState<string | null>(null);
  const [inputImageFile, setInputImageFile] = React.useState<File | null>(null);
  const [sourceB2Key, setSourceB2Key] = React.useState<string | null>(null);
  const [sourceFormState, setSourceFormState] = React.useState<GenerateFormState | null>(null);
  const [isButtonLoading, setIsButtonLoading] = React.useState(false);
  /** Set for the half second after a submit; see handleEnhance. */
  const submitting = React.useRef(false);
  // The server snapshot is 0, so hydration never disagrees with the client.
  const pendingEnhancements = React.useSyncExternalStore(
    subscribePendingRuns,
    pendingRunCount,
    noPendingRuns,
  );
  const [isDragging, setIsDragging] = React.useState(false);

  // ── Mode-specific state ─────────────────────────────────────
  const [scale, setScale] = React.useState<2 | 4>(4);
  const [refineDenoise, setRefineDenoise] = React.useState(0.3);
  const [faceFix, setFaceFix] = React.useState<FaceFixSettings>({
    detail: FACE_FIX_DEFAULTS.detail,
    detector: FACE_FIX_DEFAULTS.detector,
    denoise: FACE_FIX_DEFAULTS.denoise,
    refineEyes: FACE_FIX_DEFAULTS.refineEyes,
  });
  const updateFaceFix = React.useCallback(
    <K extends keyof FaceFixSettings>(key: K, value: FaceFixSettings[K]) =>
      setFaceFix((prev) => ({ ...prev, [key]: value })),
    [],
  );

  // ── Img2Img form state ──────────────────────────────────────
  const [formState, setFormState] = React.useState<GenerateFormState>(DEFAULT_FORM_STATE);
  const [checkpoints, setCheckpoints] = React.useState<string[]>([]);
  const [samplers, setSamplers] = React.useState<string[]>([]);
  const [schedulers, setSchedulers] = React.useState<string[]>([]);
  const [availableLoras, setAvailableLoras] = React.useState<string[]>([]);
  const [showLoras, setShowLoras] = React.useState(false);

  // ── Backend ─────────────────────────────────────────────────
  /** The self-hosted backend: ComfyUI on the active Vast.ai instance. */
  const backend = "comfyui" as const;
  const [isHydrated, setIsHydrated] = React.useState(false);

  // ── Lightbox ────────────────────────────────────────────────
  const [lightboxIndex, setLightboxIndex] = React.useState(0);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ── Results ─────────────────────────────────────────────────
  /**
   * Every result with the row that produced it.
   *
   * The grid used to map straight to URLs, which is why it could only offer
   * "Send to Enhance" — that is the one action a bare URL is enough for.
   * Favouriting needs the enhancement id, reproducing needs its mode and
   * params, and deleting needs both.
   */
  // Rows whose content did not change keep their identity, so the memoised
  // tiles below skip when the list is re-delivered.
  const enhancementRows = useStableRows(enhancements ?? NO_ENHANCEMENTS);
  const results = React.useMemo(
    () => enhancementRows.map((e) => ({ url: mediaUrl(e.resultB2Key), enhancement: e })),
    [enhancementRows],
  );
  const resultImages = React.useMemo(() => results.map((r) => r.url), [results]);
  const byUrl = React.useMemo(() => {
    const map = new Map<string, (typeof results)[number]>();
    for (const entry of results) map.set(entry.url, entry);
    return map;
  }, [results]);
  const favoritedUrls = React.useMemo(() => {
    const keys = new Set(favoriteKeys ?? []);
    return new Set(results.filter((r) => keys.has(r.enhancement.resultB2Key)).map((r) => r.url));
  }, [results, favoriteKeys]);

  // ── Hydration: restore localStorage / sessionStorage ───────
  React.useEffect(() => {
    // Form state
    const savedForm = localStorage.getItem(FORM_STORAGE_KEY);
    if (savedForm) {
      try {
        setFormState(JSON.parse(savedForm) as GenerateFormState);
      } catch (e) {
        console.error("Failed to parse saved enhance form state:", e);
      }
    }

    setIsHydrated(true);
  }, []);

  // Persist form state — debounced, and flushed when the page goes away so the
  // last keystrokes before a navigation or reload are not lost.
  const unsavedForm = React.useRef<GenerateFormState | null>(null);
  React.useEffect(() => {
    if (!isHydrated) return;
    unsavedForm.current = formState;
    const timer = setTimeout(() => flushFormState(unsavedForm), FORM_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [formState, isHydrated]);
  React.useEffect(() => {
    const flush = () => flushFormState(unsavedForm);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // ── sessionStorage: enhance_source restore ─────────────────
  React.useEffect(() => {
    const stored = sessionStorage.getItem("enhance_source");
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (data.imageUrl) {
          setInputImage(data.imageUrl);
          fetch(proxyUrl(data.imageUrl))
            .then((r) => r.blob())
            .then((blob) => {
              const file = new File([blob], "input.png", { type: blob.type });
              setInputImageFile(file);
            })
            .catch(console.error);
        }
        if (data.b2Key) setSourceB2Key(data.b2Key);
        if (data.formState) {
          setSourceFormState(data.formState);
          setFormState((prev) => ({ ...prev, ...data.formState }));
        }
      } catch (e) {
        console.error("Failed to parse enhance_source:", e);
      }
      sessionStorage.removeItem("enhance_source");
    }
  }, []);

  // ── Fetch models / loras ───────────────────────────────────
  React.useEffect(() => {
    const fetchData = async () => {
      const catalog = await fetchPodCatalog();
      if (catalog.unreachable) {
        toast.error("Failed to load models. Please check the server.");
      }

      const models = catalog.models;
      if (models) {
        setCheckpoints(models.checkpoints);
        setSamplers(models.samplers);
        setSchedulers(models.schedulers);

        setFormState((prev) => ({
          ...prev,
          checkpoint: prev.checkpoint || models.checkpoints[0] || "",
          sampler: prev.sampler || models.samplers[0] || "",
          scheduler: prev.scheduler || models.schedulers[0] || "",
        }));
      }

      if (catalog.loras) setAvailableLoras(catalog.loras);
    };

    fetchData();
    // A model that lands on the pod while this page is open — announced from
    // this tab or another one — should reach the dropdowns without a reload.
    return onPodCatalogChange(() => void fetchData());
  }, []);

  // ── Helpers ─────────────────────────────────────────────────
  const updateField = <K extends keyof GenerateFormState>(
    field: K,
    value: GenerateFormState[K],
  ) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  const randomizeSeed = () => {
    setFormState((prev) => ({
      ...prev,
      seed: Math.floor(Math.random() * 1000000000),
    }));
  };

  const openLightbox = React.useCallback((index: number) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  // ── Image drop / upload ─────────────────────────────────────
  /**
   * An object URL for the preview rather than a base64 data URL: a data URL of a
   * large PNG is a third bigger than the file, sits in state as one enormous
   * string, and is copied into every render's props. The URL is revoked below
   * once the preview moves on.
   */
  const handleFileSelect = (file: File) => {
    setInputImageFile(file);
    setInputImage(URL.createObjectURL(file));
  };

  React.useEffect(() => {
    if (!inputImage?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(inputImage);
  }, [inputImage]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      handleFileSelect(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const removeImage = () => {
    setInputImage(null);
    setInputImageFile(null);
    setSourceB2Key(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Send result back to enhance (re-enhance) ───────────────
  const handleSendToEnhance = React.useCallback((imageUrl: string) => {
    setInputImage(imageUrl);
    fetch(proxyUrl(imageUrl))
      .then((r) => r.blob())
      .then((blob) => {
        const file = new File([blob], "input.png", { type: blob.type });
        setInputImageFile(file);
      })
      .catch(console.error);
    toast.success("Image set as input");
  }, []);

  // ── Result actions ──────────────────────────────────────────
  /** Attach a result to the API composer as a reference image. */
  const handleSendToApi = React.useCallback(
    (imageUrl: string) => {
      queueApiReference(imageUrl);
      router.push("/generate?tab=api");
    },
    [router],
  );

  const handleToggleFavorite = React.useCallback(
    (imageUrl: string) => {
      const entry = byUrl.get(imageUrl);
      // Only reachable if the grid and `byUrl` disagree; silence would be
      // indistinguishable from a dead heart.
      if (!entry) {
        toast.error("Could not find that result");
        return;
      }
      void toggleFavorite({
        enhancementId: entry.enhancement._id,
        b2Key: entry.enhancement.resultB2Key,
      });
    },
    [byUrl, toggleFavorite],
  );

  /**
   * Put the settings that produced a result back on the form.
   *
   * `params` is the whole form state the run was submitted with, plus `scale`
   * and the resolved `denoise` — see runEnhancement. Restoring the mode too is
   * what makes this useful: an upscale and a refine share a page but not a
   * single control.
   *
   * The source image is deliberately not restored. The URL is only stored for
   * runs that started from "Send to Enhance", so it is absent about as often as
   * it is present, and silently leaving the previous input attached would be
   * worse than leaving the user to attach one.
   */
  const applyEnhancementSettings = React.useCallback(
    (enhancement: { mode: string; params?: unknown }) => {
      const settings = (enhancement.params ?? {}) as Partial<GenerateFormState> & {
        scale?: unknown;
        denoise?: number;
      };

      if (isEnhanceMode(enhancement.mode)) setMode(enhancement.mode);
      setFormState((current) => ({
        ...current,
        ...stripEnhanceOnlyParams(settings, enhancement.mode),
      }));

      const scale = readScale(settings.scale);
      if (scale) setScale(scale);
      // On a refine run the stored `denoise` is the slider's, so it goes there.
      if (enhancement.mode === "refine" && typeof settings.denoise === "number") {
        setRefineDenoise(settings.denoise);
      }
    },
    [],
  );

  const handleReproduce = React.useCallback(
    (imageUrl: string) => {
      const entry = byUrl.get(imageUrl);
      if (!entry) {
        toast.error("Could not find that result");
        return;
      }
      applyEnhancementSettings(entry.enhancement);
      toast.success("Settings restored");
    },
    [byUrl, applyEnhancementSettings],
  );

  // The tiles' versions take the row itself, so they need no lookup and never
  // change identity.
  const reproduceEnhancement = React.useCallback(
    (enhancement: Doc<"enhancements">) => {
      applyEnhancementSettings(enhancement);
      toast.success("Settings restored");
    },
    [applyEnhancementSettings],
  );

  const toggleEnhancementFavorite = React.useCallback(
    (enhancement: Doc<"enhancements">) => {
      void toggleFavorite({ enhancementId: enhancement._id, b2Key: enhancement.resultB2Key });
    },
    [toggleFavorite],
  );

  /**
   * Applies an enhancement handed over from Favourites, then drops the id from
   * the URL.
   *
   * Dropping it is what stops the restore firing again on every later render,
   * and what stops a reload overwriting whatever has been typed since. Clearing
   * it also switches the query above back to "skip", so the effect cannot run
   * twice for one hand-off.
   */
  const handledReproduce = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!reproduceId || !isAuthenticated) return;
    // `undefined` is the query still in flight; `null` is a real answer —
    // deleted, someone else's, or a malformed id. Treating the two the same
    // left a dead `?reproduce=` in the URL forever with no toast and no
    // restore, which reads as the button having done nothing.
    if (handedOver === undefined) return;
    if (handledReproduce.current === reproduceId) return;
    handledReproduce.current = reproduceId;

    if (handedOver === null) {
      toast.error("That enhancement is no longer available");
    } else {
      applyEnhancementSettings(handedOver);
      toast.success("Settings restored");
    }

    const params = new URLSearchParams(window.location.search);
    params.delete("reproduce");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/enhance?${query}` : "/enhance");
  }, [reproduceId, isAuthenticated, handedOver, applyEnhancementSettings]);

  const handleDeleteResult = React.useCallback(
    async (imageUrl: string) => {
      const entry = byUrl.get(imageUrl);
      if (!entry) return;
      if (!window.confirm("Delete this enhanced image? The result goes with it.")) return;
      try {
        await removeEnhancement({ id: entry.enhancement._id });
        toast.success("Enhancement deleted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not delete that result");
      }
    },
    [byUrl, removeEnhancement],
  );

  // ── Submit ──────────────────────────────────────────────────
  const handleEnhance = React.useCallback(() => {
    if (!inputImage && !inputImageFile) {
      toast.error("Please upload an image first");
      return;
    }
    // The button is disabled for this half second, but Cmd+Enter is not a
    // button: a double press (or a held key) used to start two identical runs.
    if (submitting.current) return;
    submitting.current = true;

    setIsButtonLoading(true);
    setTimeout(() => {
      submitting.current = false;
      setIsButtonLoading(false);
    }, 500);

    const runId = startRun();

    // The request object is built now, so it captures the state the user
    // pressed Enhance with even though the work finishes much later.
    void runEnhancement({
      inputImage,
      inputImageFile,
      mode,
      backend,
      formState: { ...formState },
      scale,
      refineDenoise,
      faceFix: { ...faceFix },
      sourceFormState,
      sourceB2Key,
      isAuthenticated,
      saveEnhancement,
    })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Enhancement failed");
      })
      .finally(() => finishRun(runId));
  }, [
    inputImage,
    inputImageFile,
    mode,
    backend,
    formState,
    scale,
    refineDenoise,
    faceFix,
    sourceFormState,
    sourceB2Key,
    isAuthenticated,
    saveEnhancement,
  ]);

  // ── Cmd+Enter shortcut ─────────────────────────────────────
  // An Effect Event, so the listener is bound once rather than re-bound on every
  // keystroke — `handleEnhance` changes with the form.
  const onShortcut = React.useEffectEvent((e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
    e.preventDefault();
    if (e.repeat) return;
    handleEnhance();
  });
  React.useEffect(() => {
    const listener = (e: KeyboardEvent) => onShortcut(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ── Enhance button ──────────────────────────────────────────
  const enhanceButton = (
    <Button
      size="lg"
      className="w-full text-lg font-semibold h-12"
      onClick={handleEnhance}
      disabled={isButtonLoading}
    >
      {isButtonLoading ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Sending...
        </>
      ) : (
        "Enhance"
      )}
    </Button>
  );

  const hasResults = resultImages.length > 0 || pendingEnhancements > 0;

  return (
    <>
      <div className="lg:flex lg:h-[calc(100vh-4rem)]">
        {/* ── Left Panel: Form ─────────────────────────────── */}
        <div className="lg:w-[40%] lg:flex lg:flex-col lg:h-full lg:border-r">
          <div className="flex-1 overflow-y-auto py-6 px-4 lg:px-6 pb-24 lg:pb-6">
            <div className="max-w-3xl mx-auto lg:max-w-none space-y-6">
              {/* Backend status */}
              <div className="flex justify-end mb-4">
                <BackendStatus />
              </div>

              {/* Image Drop Zone */}
              <div className="space-y-2">
                <Label>Input Image</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleImageUpload}
                  className="hidden"
                />
                {inputImage ? (
                  <div className="relative">
                    <img
                      src={inputImage}
                      alt="Input preview"
                      className="w-full max-h-64 object-contain rounded-lg border"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="absolute top-2 right-2 h-8 w-8 bg-background/80 backdrop-blur-sm"
                      onClick={removeImage}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Card
                    className={`p-8 text-center cursor-pointer transition-colors border-dashed border-2 ${
                      isDragging
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                  >
                    <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click or drag to upload</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">PNG, JPG, or WEBP</p>
                  </Card>
                )}
              </div>

              {/* Mode Selector — visually separate from drop zone */}
              <div className="space-y-2">
                <Label>Enhancement Mode</Label>
                <div className="flex gap-2">
                  {(["img2img", "upscale", "refine", "facefix"] as const).map((m) => {
                    const meta = MODE_META[m];
                    const Icon = meta.icon;
                    return (
                      <Button
                        key={m}
                        variant={mode === m ? "default" : "outline"}
                        onClick={() => setMode(m)}
                        className="flex-1"
                        size="sm"
                      >
                        <Icon className="h-4 w-4 mr-1.5" />
                        {meta.label}
                      </Button>
                    );
                  })}
                </div>
              </div>

              {/* ── Mode-specific controls ─────────────────── */}

              {mode === "img2img" && (
                <div className="space-y-6">
                  {/* Checkpoint */}
                  <div className="space-y-2">
                    <Label>Checkpoint</Label>
                    <SearchableSelect
                      value={formState.checkpoint}
                      onValueChange={(val) => updateField("checkpoint", val)}
                      options={checkpoints}
                      placeholder={
                        checkpoints.length > 0 ? "Select a checkpoint..." : "Loading checkpoints..."
                      }
                      emptyMessage="No checkpoints found"
                    />
                  </div>

                  {/* LoRA Stack */}
                  <Collapsible
                    open={showLoras}
                    onOpenChange={setShowLoras}
                    className="border rounded-lg p-4"
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <span className="font-medium text-sm">LoRA Stack</span>
                      {showLoras ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-4">
                      <LoraStack
                        loras={Array.isArray(formState.loras) ? formState.loras : []}
                        availableLoras={availableLoras}
                        onChange={(newLoras) => updateField("loras", newLoras)}
                      />
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Prompt */}
                  <div className="space-y-2">
                    <Label htmlFor="enhance-prompt">Prompt</Label>
                    <Textarea
                      id="enhance-prompt"
                      placeholder="Describe what you want to see..."
                      className="min-h-[100px] resize-y"
                      value={formState.prompt}
                      onChange={(e) => updateField("prompt", e.target.value)}
                    />
                  </div>

                  {/* Negative Prompt */}
                  <div className="space-y-2">
                    <Label htmlFor="enhance-neg-prompt">Negative Prompt</Label>
                    <Textarea
                      id="enhance-neg-prompt"
                      placeholder="Describe what you want to avoid..."
                      className="min-h-[60px] resize-y"
                      value={formState.negativePrompt}
                      onChange={(e) => updateField("negativePrompt", e.target.value)}
                    />
                  </div>

                  {/* Denoise */}
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <Label>Denoise Strength</Label>
                      <Input
                        type="number"
                        value={formState.denoise}
                        onChange={(e) => updateField("denoise", Number(e.target.value) || 0)}
                        onBlur={(e) =>
                          updateField(
                            "denoise",
                            Math.min(1, Math.max(0.1, Number(e.target.value) || 0.5)),
                          )
                        }
                        className="w-20 h-8 text-xs font-mono text-right"
                        min={0.1}
                        max={1}
                        step={0.05}
                      />
                    </div>
                    <Slider
                      value={[Number(formState.denoise)]}
                      min={0.1}
                      max={1}
                      step={0.05}
                      onValueChange={(vals) =>
                        updateField("denoise", Array.isArray(vals) ? vals[0] : vals)
                      }
                    />
                  </div>

                  {/* Steps + CFG */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <Label>Steps</Label>
                        <Input
                          type="number"
                          value={formState.steps}
                          onChange={(e) => updateField("steps", Number(e.target.value) || 0)}
                          onBlur={(e) =>
                            updateField(
                              "steps",
                              Math.min(100, Math.max(1, Number(e.target.value) || 20)),
                            )
                          }
                          className="w-20 h-8 text-xs font-mono text-right"
                          min={1}
                          max={100}
                        />
                      </div>
                      <Slider
                        value={[Number(formState.steps)]}
                        min={1}
                        max={100}
                        step={1}
                        onValueChange={(vals) =>
                          updateField("steps", Array.isArray(vals) ? vals[0] : vals)
                        }
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <Label>CFG Scale</Label>
                        <Input
                          type="number"
                          value={formState.cfg}
                          onChange={(e) => updateField("cfg", Number(e.target.value) || 0)}
                          onBlur={(e) =>
                            updateField(
                              "cfg",
                              Math.min(20, Math.max(1, Number(e.target.value) || 7)),
                            )
                          }
                          className="w-20 h-8 text-xs font-mono text-right"
                          min={1}
                          max={20}
                          step={0.5}
                        />
                      </div>
                      <Slider
                        value={[Number(formState.cfg)]}
                        min={1}
                        max={20}
                        step={0.5}
                        onValueChange={(vals) =>
                          updateField("cfg", Array.isArray(vals) ? vals[0] : vals)
                        }
                      />
                    </div>
                  </div>

                  {/* Sampler + Scheduler */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label>Sampler</Label>
                      <SearchableSelect
                        value={formState.sampler}
                        onValueChange={(val) => updateField("sampler", val)}
                        options={samplers}
                        placeholder="Select sampler..."
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Scheduler</Label>
                      <SearchableSelect
                        value={formState.scheduler}
                        onValueChange={(val) => updateField("scheduler", val)}
                        options={schedulers}
                        placeholder="Select scheduler..."
                      />
                    </div>
                  </div>

                  {/* Seed */}
                  <div className="space-y-2">
                    <Label>Seed</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={formState.seed}
                        onChange={(e) => updateField("seed", Number(e.target.value))}
                        className="font-mono"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={randomizeSeed}
                        title="Randomize Seed"
                      >
                        <Dice5 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => updateField("seed", -1)}
                        title="Set to Random (-1)"
                        className={Number(formState.seed) === -1 ? "bg-accent" : ""}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {mode === "upscale" && (
                <div className="space-y-2">
                  <Label>Upscale Factor</Label>
                  <div className="flex gap-2">
                    {([2, 4] as const).map((s) => (
                      <Button
                        key={s}
                        variant={scale === s ? "default" : "outline"}
                        className="flex-1"
                        onClick={() => setScale(s)}
                      >
                        {s}x
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {mode === "refine" && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label>Denoise Strength</Label>
                    <Input
                      type="number"
                      value={refineDenoise}
                      onChange={(e) => setRefineDenoise(Number(e.target.value) || 0)}
                      onBlur={(e) =>
                        setRefineDenoise(
                          Math.min(1.0, Math.max(0.1, Number(e.target.value) || 0.3)),
                        )
                      }
                      className="w-20 h-8 text-xs font-mono text-right"
                      min={0.1}
                      max={1.0}
                      step={0.05}
                    />
                  </div>
                  <Slider
                    value={[refineDenoise]}
                    min={0.1}
                    max={1.0}
                    step={0.05}
                    onValueChange={(vals) => setRefineDenoise(Array.isArray(vals) ? vals[0] : vals)}
                  />
                </div>
              )}

              {mode === "facefix" && (
                <div className="space-y-5">
                  <Card className="p-4 bg-muted/30">
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Finds every face, re-renders each one much larger with the checkpoint, prompt
                      and LoRAs that drew the picture, and composites it back. It is not a photo
                      restorer — nothing here imposes a &ldquo;generic human face&rdquo; on your
                      image, so anime and stylised work keep their style.
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      The gain is in small and distant faces, where there is resolution to add. A
                      face that already fills the frame has none, so it re-rolls rather than repairs
                      and fine skin texture can go with it — drop Strength to around 0.25 for those,
                      or use the eye pass on its own.
                    </p>
                    {sourceFormState?.checkpoint ? (
                      <p className="text-xs text-muted-foreground mt-2">
                        Re-rendering with{" "}
                        <span className="font-mono">{sourceFormState.checkpoint}</span> — the
                        source&rsquo;s own model.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-2">
                        No source settings attached, so it falls back to a general realism
                        checkpoint. Send an image here from Generate to keep its style exactly.
                      </p>
                    )}
                  </Card>

                  <div className="space-y-2">
                    <Label>Face Resolution</Label>
                    <div className="flex gap-2">
                      {(
                        [
                          ["standard", "Standard", "512px per face — quickest"],
                          ["high", "High", "640px per face — the default"],
                          ["max", "Max", "768px per face — slowest, most detail"],
                        ] as const
                      ).map(([value, label, hint]) => (
                        <Button
                          key={value}
                          variant={faceFix.detail === value ? "default" : "outline"}
                          className="flex-1"
                          title={hint}
                          onClick={() => updateFaceFix("detail", value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      How large each detected face is drawn before it goes back into the image. This
                      is where most of the visible improvement comes from.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <Label>Strength</Label>
                      <Input
                        type="number"
                        value={faceFix.denoise}
                        onChange={(e) => updateFaceFix("denoise", Number(e.target.value) || 0)}
                        onBlur={(e) =>
                          updateFaceFix(
                            "denoise",
                            Math.min(0.8, Math.max(0.15, Number(e.target.value) || 0.4)),
                          )
                        }
                        className="w-20 h-8 text-xs font-mono text-right"
                        min={0.15}
                        max={0.8}
                        step={0.05}
                      />
                    </div>
                    <Slider
                      value={[faceFix.denoise]}
                      min={0.15}
                      max={0.8}
                      step={0.05}
                      onValueChange={(vals) =>
                        updateFaceFix("denoise", Array.isArray(vals) ? vals[0] : vals)
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      How far the face may move from the original. Below 0.3 only cleans up; above
                      0.6 it will draw a different person.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Detector</Label>
                    <div className="flex gap-2">
                      {(
                        [
                          ["accurate", "Accurate"],
                          ["fast", "Fast"],
                        ] as const
                      ).map(([value, label]) => (
                        <Button
                          key={value}
                          variant={faceFix.detector === value ? "default" : "outline"}
                          className="flex-1"
                          onClick={() => updateFaceFix("detector", value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Accurate</span> runs
                      <span className="font-mono"> face_yolov9c</span>, which finds small, profile
                      and partly-hidden faces the older detector misses.{" "}
                      <span className="font-medium text-foreground">Fast</span> runs
                      <span className="font-mono"> face_yolov8m</span> — a shade quicker, and what
                      this mode used before.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="refine-eyes">Second pass on the eyes</Label>
                      <Switch
                        id="refine-eyes"
                        checked={faceFix.refineEyes}
                        onCheckedChange={(checked) => updateFaceFix("refineEyes", checked)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      After the face pass, <span className="font-mono">Anzhc Eyes seg</span> finds
                      the eyes on their own and re-renders them at high resolution with a gentler
                      strength. For close-ups and half-length shots, where the eyes are already big
                      enough to be found — on a distant figure it detects nothing and costs a
                      second. Adds roughly the time of the face pass again.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Desktop enhance button */}
          <div className="hidden lg:block p-4 lg:px-6 border-t bg-background">{enhanceButton}</div>
        </div>

        {/* ── Right Panel: Results ──────────────────────────── */}
        <div className="lg:w-[60%] lg:h-full lg:overflow-y-auto">
          {hasResults ? (
            <div className="py-6 px-4 lg:px-6">
              <div className="max-w-3xl mx-auto lg:max-w-none">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-bold">Results</h2>
                  {pendingEnhancements > 0 && (
                    <span className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {pendingEnhancements} enhancing...
                    </span>
                  )}
                </div>

                <ImageGrid>
                  {pendingEnhancements > 0 &&
                    Array.from({ length: pendingEnhancements }).map((_, idx) => (
                      <Card
                        key={`pending-${idx}`}
                        className="overflow-hidden bg-muted/30 flex items-center justify-center"
                        style={{ width: 280, height: 280 }}
                      >
                        <div className="text-center space-y-2">
                          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                          <p className="text-sm text-muted-foreground">Enhancing...</p>
                        </div>
                      </Card>
                    ))}
                  {results.map(({ url, enhancement }, idx) => (
                    <EnhanceResultTile
                      // The row id is the stable identity; an index would
                      // remount every tile below a deletion and re-download it.
                      key={enhancement._id}
                      enhancement={enhancement}
                      index={idx}
                      favorited={favoritedUrls.has(url)}
                      onOpen={openLightbox}
                      onSendToEnhance={handleSendToEnhance}
                      onSendToApi={handleSendToApi}
                      onReproduce={reproduceEnhancement}
                      onToggleFavorite={toggleEnhancementFavorite}
                    />
                  ))}
                </ImageGrid>
              </div>
            </div>
          ) : (
            <div className="hidden lg:flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center space-y-2">
                <p className="text-lg">No results yet</p>
                <p className="text-sm">Enhanced images will appear here</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mobile bottom button */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-background/80 backdrop-blur-md border-t z-40">
        <div className="max-w-3xl mx-auto">{enhanceButton}</div>
      </div>

      <ImageLightbox
        getSource={(url) => {
          const enhancement = results.find((result) => result.url === url)?.enhancement;
          return enhancement ? { kind: "enhancement", id: enhancement._id } : undefined;
        }}
        images={resultImages}
        initialIndex={lightboxIndex}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onSendToEnhance={handleSendToEnhance}
        onReproduce={handleReproduce}
        onToggleFavorite={handleToggleFavorite}
        favoritedUrls={favoritedUrls}
        // Delete has no slot of its own on the lightbox, and `renderActions` is
        // the extension point for exactly that — the Favorites page uses it for
        // "send to API". Here it carries both, because neither is worth a new
        // prop on a component four pages share.
        renderActions={(url) => (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="text-white/70 hover:text-white hover:bg-white/10"
              title="Send to API models as reference"
              onClick={() => handleSendToApi(url)}
            >
              <Sparkles className="h-6 w-6" />
              <span className="sr-only">Send to API models as reference</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-white/70 hover:text-white hover:bg-white/10"
              title="Delete this enhancement"
              onClick={() => void handleDeleteResult(url)}
            >
              <Trash2 className="h-6 w-6" />
              <span className="sr-only">Delete this enhancement</span>
            </Button>
          </>
        )}
      />
    </>
  );
}
