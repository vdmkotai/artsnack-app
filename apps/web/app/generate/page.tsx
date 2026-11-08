"use client";

import * as React from "react";
import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RefreshCw, Dice5, ChevronRight, ChevronDown, Trash2, Copy } from "lucide-react";
import { copyText } from "@/lib/copy-text";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ImageSizePicker } from "@/components/image-size-picker";
import { LoraStack } from "@/components/lora-stack";
import { ImageLightbox } from "@/components/image-lightbox";
import { ImageGrid, ImageGridItem, ImageGridSkeleton } from "@/components/image-grid";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { BackendStatus } from "@/components/backend-status";
import { GenerateSplit } from "@/components/generate-split";
import { PreviewZoom, usePreviewZoom } from "@/components/preview-zoom";
import type { VideoHandoff } from "@/components/h3/video-panel";
import { useHeldWhileHidden } from "@/components/api/use-held-while-hidden";
import { withServerTimeout } from "@/components/api/submit-guards";
import { PromptLibrary } from "@/components/prompt-library";
import { GenerationProgress } from "@/components/generation-progress";
import {
  queueApiReference,
  readApiReproduceId,
  readVideoReproduceId,
  type GenerateTab,
  type VideoHandoffRole,
  resolveGenerateTab,
} from "@/lib/reference-handoff";
import { isApiModelId, type ApiModelId } from "@/lib/api-models";
import { Sparkles } from "lucide-react";
import { useImageSelection } from "@/hooks/use-image-selection";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useStableRows } from "@/hooks/use-stable-rows";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";

import { useAction, useMutation, type ReactAction, type ReactMutation } from "convex/react";
import {
  useQuery as useCachedQuery,
  usePaginatedQuery as useCachedPaginatedQuery,
} from "@/lib/convex-cache";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { GenerateFormState } from "@/lib/types";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { onPodCatalogChange, podCatalogUrl } from "@/lib/pod-catalog-version";

/**
 * The tab buttons, for the placeholder a composer shows while its code loads —
 * the switch lives inside each panel, and a placeholder without it would leave
 * no way back until the chunk arrived.
 */
const PanelTabsContext = React.createContext<React.ReactNode>(null);

function PanelLoading() {
  const tabs = React.useContext(PanelTabsContext);
  return (
    <div className="flex flex-col lg:h-[calc(100vh-3.5rem)]">
      <div className="flex items-center gap-2 border-b px-3 py-2 lg:px-4">{tabs}</div>
      <div className="flex flex-1 items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

/*
 * The two hosted composers are the bulk of this route's JavaScript and most of
 * its live queries. Each is loaded and mounted the first time its tab opens —
 * and stays mounted afterwards, so coming back keeps its state — and both
 * chunks are fetched once the page is idle, so that first switch is instant
 * too. `ssr: false` is free here: the page already renders on the client only
 * (useSearchParams under Suspense), and both panels read localStorage in their
 * state initialisers.
 */
const loadApiPanel = () => import("@/components/api/api-panel");
const loadVideoPanel = () => import("@/components/h3/video-panel");
const ApiPanel = dynamic(() => loadApiPanel().then((mod) => mod.ApiPanel), {
  ssr: false,
  loading: PanelLoading,
});
const VideoPanel = dynamic(() => loadVideoPanel().then((mod) => mod.VideoPanel), {
  ssr: false,
  loading: PanelLoading,
});

type TabState = {
  /** What is on screen. Changes the moment a tab is clicked. */
  tab: GenerateTab;
  /** The tab the URL named when last read, to tell its own changes apart. */
  urlTab: GenerateTab;
  /** Panels opened at least once, which stay mounted from then on. */
  mounted: readonly GenerateTab[];
};

function showTab(state: TabState, tab: GenerateTab): TabState {
  return {
    ...state,
    tab,
    mounted: state.mounted.includes(tab) ? state.mounted : [...state.mounted, tab],
  };
}

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 7;
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_SEED = -1;
const DEFAULT_DENOISE = 1.0;

// Results grid pages through generations (infinite scroll) instead of a flat
// capped list, so older images keep loading as you scroll.
const INITIAL_PAGE_SIZE = 30;
const LOAD_MORE_SIZE = 30;
const SUBMIT_TIMEOUT_MS = 120_000;

// Everything below runs at module scope on purpose. React Compiler cannot lower
// a `try` with a finalizer, a `throw` inside a `try`, or a ternary/`||`/`?.`
// inside a `try` — and when it meets one it drops automatic memoization for the
// whole enclosing component. In here that is the 1000-line page: every keystroke
// in the prompt box would re-render the entire results grid and the API panel.

/** Resolves true when the delete succeeded, which is what gates exiting selection mode. */
async function deleteImages(
  removeImages: ReactMutation<typeof api.generations.removeImages>,
  images: Array<{ generationId: Id<"generations">; b2Key: string }>,
): Promise<boolean> {
  try {
    const removed = await removeImages({ images });
    toast.success(`Deleted ${removed} image${removed > 1 ? "s" : ""}`);
    return true;
  } catch (e) {
    console.error("Bulk delete failed:", e);
    toast.error("Failed to delete images");
    return false;
  }
}

/**
 * No confirmation, same as the API tab: a failed tile holds an error message,
 * not media, so there is no loss worth guarding against. Unlike the API tab
 * there is no "kept" arithmetic — a self-hosted failure cost GPU time, not
 * money, so the mutation deletes every failed row and the count is the count.
 */
async function removeFailedGenerations(
  removeAllFailed: ReactMutation<typeof api.generations.removeAllFailed>,
): Promise<void> {
  try {
    const removed = await removeAllFailed({});
    toast.success(`Removed ${removed} failed generation${removed === 1 ? "" : "s"}`);
  } catch (e) {
    console.error("Remove all failed failed:", e);
    toast.error("Failed to remove generations");
  }
}

type SubmitResult = { ok: true } | { ok: false; message: string };

async function submitGeneration(
  formState: GenerateFormState,
  backend: "comfyui",
  generate: ReactAction<typeof api.podSubmit.generate>,
): Promise<SubmitResult> {
  try {
    // Bounded like the hosted composers' submits: an action sent while the
    // socket is reconnecting waits for it, and the button waited with it.
    // Generous, because a cold pod can take a while to accept the job.
    await withServerTimeout(
      generate({
        backend,
        formState: {
          prompt: formState.prompt,
          negativePrompt: formState.negativePrompt,
          checkpoint: formState.checkpoint,
          width: Number(formState.width),
          height: Number(formState.height),
          seed: Number(formState.seed),
          steps: Number(formState.steps),
          cfg: Number(formState.cfg),
          sampler: formState.sampler,
          scheduler: formState.scheduler,
          denoise: Number(formState.denoise),
          batchSize: Number(formState.batchSize),
          loras: (formState.loras || [])
            .filter((l) => l.enabled)
            .map((l) => ({
              enabled: l.enabled,
              loraName: l.loraName,
              strengthModel: Number(l.strengthModel),
              strengthClip: Number(l.strengthClip),
            })),
        },
      }),
      SUBMIT_TIMEOUT_MS,
    );

    return { ok: true };
  } catch (error) {
    console.error("Generation error:", error);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to start generation",
    };
  }
}

type ModelLists = { checkpoints: string[]; samplers: string[]; schedulers: string[] };

/**
 * The last lists the pod answered with, kept for the life of the tab.
 *
 * Coming back to /generate used to start every dropdown on "Loading
 * checkpoints..." until two fresh requests had both answered. The remembered
 * lists render at once instead and the requests refresh them behind it; a
 * download landing in between is still announced by `onPodCatalogChange`.
 */
let lastModels: ModelLists | null = null;
let lastLoras: string[] | null = null;

/** One toast for the pair: either list failing to answer says the same thing. */
const CATALOG_TOAST_ID = "pod-catalog-unreachable";

/**
 * `unreachable` marks a request that never answered at all, as opposed to one
 * that answered with an error status — only the former is worth a toast.
 */
async function fetchModels(): Promise<{ models: ModelLists | null; unreachable: boolean }> {
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

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** The previous array when nothing changed, so the dropdown keeps its props. */
function keepIfSame(next: string[]) {
  return (previous: string[]) => (sameList(previous, next) ? previous : next);
}

/** Picks a model, sampler and scheduler for a form that has none yet. */
function withCatalogDefaults(models: ModelLists) {
  return (prev: GenerateFormState): GenerateFormState => {
    const checkpoint = prev.checkpoint || models.checkpoints[0] || "";
    const sampler = prev.sampler || models.samplers[0] || "";
    const scheduler = prev.scheduler || models.schedulers[0] || "";
    if (
      checkpoint === prev.checkpoint &&
      sampler === prev.sampler &&
      scheduler === prev.scheduler
    ) {
      return prev;
    }
    return { ...prev, checkpoint, sampler, scheduler };
  };
}

export default function GeneratePage() {
  return (
    <Suspense fallback={<div className="container max-w-3xl mx-auto py-6 px-4">Loading...</div>}>
      <GeneratePageContent />
    </Suspense>
  );
}

function GeneratePageContent() {
  const [previewScale, setPreviewScale] = usePreviewZoom("generate-preview-scale-models");
  const searchParams = useSearchParams();
  const router = useRouter();
  const generateOnBackend = useAction(api.podSubmit.generate);
  // ?tab=grok predates the model switcher and still arrives from older links,
  // bookmarks and the gallery hand-off — it opens the API tab on Grok.
  const tabParam = searchParams.get("tab");

  /**
   * Which composer is showing, and a reproduce beats whatever tab was remembered.
   *
   * The two reproduce entry points each know which engine made the image —
   * `?reproduce=true` carries a self-hosted formState in sessionStorage,
   * `?reproduceApi=` carries the id of a hosted row — so either one is an explicit
   * statement of intent and has to outrank `?tab=`. Without this, a `?tab=api` left
   * over from the last visit could open the hosted composer over a restored
   * self-hosted form: the settings are all there, on a panel that is not on screen,
   * which reads as "Reproduce did nothing" or "Reproduce opened Grok".
   *
   * `setTab` writes through `history.replaceState` rather than the router, so the
   * remembered value is exactly the kind of state that outlives the navigation that
   * should have cleared it.
   *
   * What is on screen is local state, though, with the URL as its mirror. Next
   * turns `history.replaceState` into a transition, and a transition is
   * interruptible and waits behind whatever else is rendering — with three
   * composers' Convex subscriptions pushing, a click on a tab could take a
   * visible beat to land. The click now switches at once; the URL follows. A
   * change the URL makes on its own (a reproduce link, `router.replace`) still
   * moves the tab, because the URL's own value is compared with the one last
   * seen rather than with what is showing.
   */
  const urlTab = resolveGenerateTab(searchParams);
  const [tabState, setTabState] = React.useState<TabState>(() => ({
    tab: urlTab,
    urlTab,
    mounted: [urlTab],
  }));
  let currentTabs = tabState;
  if (urlTab !== tabState.urlTab) {
    currentTabs = { ...showTab(tabState, urlTab), urlTab };
    setTabState(currentTabs);
  }
  const tab = currentTabs.tab;
  const modelsMounted = currentTabs.mounted.includes("models");
  const apiMounted = currentTabs.mounted.includes("api");
  const videoMounted = currentTabs.mounted.includes("video");
  const modelParam = searchParams.get("model");
  const initialModel: ApiModelId | undefined =
    modelParam && isApiModelId(modelParam) ? modelParam : tabParam === "grok" ? "grok" : undefined;

  // The composers not open yet are fetched while the page is idle, so the first
  // switch to one does not wait for its chunk.
  React.useEffect(() => {
    const warm = () => {
      void loadApiPanel();
      void loadVideoPanel();
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  const setTab = React.useCallback((next: GenerateTab) => {
    setTabState((state) => showTab(state, next));
    const params = new URLSearchParams(window.location.search);
    // Leaving the video tab abandons its pending reproduce, as below for API.
    if (next !== "video") params.delete("reproduceVideo");
    if (next === "api") {
      params.set("tab", "api");
    } else if (next === "video") {
      params.set("tab", "video");
      params.delete("model");
      params.delete("reproduceApi");
    } else {
      params.delete("tab");
      params.delete("model");
      // Leaving the API tab abandons a pending reproduce. Kept in the URL it
      // would fire whenever the tab is next opened, overwriting the form and
      // the reference images the user had attached in the meantime.
      params.delete("reproduceApi");
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/generate?${query}` : "/generate");
  }, []);

  // Consumed once by the API panel; dropped from the URL afterwards so a reload
  // doesn't overwrite whatever the user has since typed into the form.
  const reproduceApiId = readApiReproduceId(searchParams);
  const clearReproduceParam = React.useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("reproduceApi");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/generate?${query}` : "/generate");
  }, []);

  // An API result sent to the Self-hosted video tab. Both panels stay mounted,
  // so this is plain state; `seq` makes sending the same image twice count.
  const [videoHandoff, setVideoHandoff] = React.useState<VideoHandoff | null>(null);
  const sendToVideo = React.useCallback(
    (url: string, role: VideoHandoffRole) => {
      setVideoHandoff((previous) => ({ url, role, seq: (previous?.seq ?? 0) + 1 }));
      setTab("video");
    },
    [setTab],
  );
  const clearVideoHandoff = React.useCallback(() => setVideoHandoff(null), []);

  const reproduceVideoId = readVideoReproduceId(searchParams);
  const clearVideoReproduceParam = React.useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("reproduceVideo");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/generate?${query}` : "/generate");
  }, []);

  const setModelParam = React.useCallback((model: ApiModelId) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "api");
    params.set("model", model);
    window.history.replaceState(null, "", `/generate?${params.toString()}`);
  }, []);
  // Not subscribed until the Self-hosted tab is first opened: landing on the API
  // tab should not pay for a list it is not showing.
  const {
    results: liveGenerations,
    status: generationsStatus,
    loadMore,
  } = useCachedPaginatedQuery(api.generations.listPaginated, modelsMounted ? {} : "skip", {
    initialNumItems: INITIAL_PAGE_SIZE,
  });
  /*
   * A running job rewrites its row about once a second (progress, lease), and
   * every push is a new array of new objects. Unchanged rows keep their
   * identity, and while another tab is showing the list is held as it was, so
   * nothing below recomputes for a grid nobody can see.
   */
  const recentGenerations = useHeldWhileHidden(useStableRows(liveGenerations), tab === "models");
  const canLoadMore = generationsStatus === "CanLoadMore";
  const isLoadingMore = generationsStatus === "LoadingMore";

  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [checkpoints, setCheckpoints] = React.useState<string[]>(
    () => lastModels?.checkpoints ?? [],
  );
  const [samplers, setSamplers] = React.useState<string[]>(() => lastModels?.samplers ?? []);
  const [schedulers, setSchedulers] = React.useState<string[]>(() => lastModels?.schedulers ?? []);
  const [loras, setLoras] = React.useState<string[]>(() => lastLoras ?? []);

  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [showLoras, setShowLoras] = React.useState(false);

  const [lightboxIndex, setLightboxIndex] = React.useState(0);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);

  const [formState, setFormState] = React.useState<GenerateFormState>({
    checkpoint: "",
    prompt: "",
    negativePrompt: "",
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    seed: DEFAULT_SEED,
    batchSize: DEFAULT_BATCH_SIZE,
    steps: DEFAULT_STEPS,
    cfg: DEFAULT_CFG,
    sampler: "",
    scheduler: "",
    denoise: DEFAULT_DENOISE,
    loras: [],
  });

  const [isHydrated, setIsHydrated] = React.useState(false);
  /** ComfyUI on the ready provider selected in the self-hosted backend manager. */
  const backend = "comfyui" as const;

  const pendingGenerations = React.useMemo(() => {
    if (!recentGenerations) return [];
    return recentGenerations.filter((g) => g.status === "pending" || g.status === "processing");
  }, [recentGenerations]);

  const failedGenerations = React.useMemo(() => {
    if (!recentGenerations) return [];
    return recentGenerations.filter((g) => g.status === "failed");
  }, [recentGenerations]);

  const completedImages = React.useMemo(() => {
    if (!recentGenerations) return [];
    return recentGenerations.flatMap((g) => {
      if (g.status === "pending" || g.status === "processing") return [];
      if (g.status === "failed") return [];
      if (g.b2Keys && g.b2Keys.length > 0) {
        return g.b2Keys.map((key) => mediaUrl(key));
      }
      return [];
    });
  }, [recentGenerations]);

  // Optimized thumbnail URLs + known aspect ratios, parallel to completedImages
  // (same order/index): fast previews + no layout shift while they load.
  const completedThumbs = React.useMemo(() => {
    if (!recentGenerations) return [];
    return recentGenerations.flatMap((g) => {
      if (g.status === "pending" || g.status === "processing" || g.status === "failed") return [];
      if (g.b2Keys && g.b2Keys.length > 0) {
        return g.b2Keys.map((key) => thumbUrl(key));
      }
      return [];
    });
  }, [recentGenerations]);

  const completedAspects = React.useMemo(() => {
    if (!recentGenerations) return [];
    return recentGenerations.flatMap((g) => {
      if (g.status === "pending" || g.status === "processing" || g.status === "failed") return [];
      if (!(g.b2Keys && g.b2Keys.length > 0)) return [];
      const ar = (Number(g.formState?.width) || 1) / (Number(g.formState?.height) || 1);
      return g.b2Keys.map(() => ar);
    });
  }, [recentGenerations]);

  // { generationId, b2Key } per completed image, parallel to completedImages — for favoriting.
  const completedMeta = React.useMemo(() => {
    if (!recentGenerations) return [];
    return recentGenerations.flatMap((g) => {
      if (g.status === "pending" || g.status === "processing" || g.status === "failed") return [];
      if (!(g.b2Keys && g.b2Keys.length > 0)) return [];
      return g.b2Keys.map((key) => ({ generationId: g._id, b2Key: key }));
    });
  }, [recentGenerations]);

  const favKeys = useCachedQuery(api.favorites.myKeys, modelsMounted ? {} : "skip");
  const favSet = React.useMemo(() => new Set(favKeys ?? []), [favKeys]);
  const toggleFavorite = useToggleFavorite();
  const removeImages = useMutation(api.generations.removeImages);
  const removeAllFailed = useMutation(api.generations.removeAllFailed);
  const [isRemovingFailed, setIsRemovingFailed] = React.useState(false);

  const handleRemoveAllFailed = React.useCallback(async () => {
    if (isRemovingFailed) return;
    setIsRemovingFailed(true);
    await removeFailedGenerations(removeAllFailed);
    setIsRemovingFailed(false);
  }, [isRemovingFailed, removeAllFailed]);

  // Stable per-image identity, parallel to completedImages. Selection is keyed
  // by this (never by array index) so live prepends can't retarget it.
  const completedKeys = React.useMemo(
    () => completedMeta.map((m) => `${m.generationId}:${m.b2Key}`),
    [completedMeta],
  );
  const metaByKey = React.useMemo(() => {
    const map = new Map<string, (typeof completedMeta)[number]>();
    completedMeta.forEach((m, idx) => map.set(completedKeys[idx], m));
    return map;
  }, [completedMeta, completedKeys]);

  const { selectedKeys, selectionActive, handleSelect, enterSelection, exitSelection } =
    useImageSelection(completedKeys);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const handleBulkDelete = React.useCallback(async () => {
    if (selectedKeys.size === 0 || isDeleting) return;
    if (!window.confirm(`Delete ${selectedKeys.size} image${selectedKeys.size > 1 ? "s" : ""}?`))
      return;
    const images = [...selectedKeys].flatMap((key) => {
      const meta = metaByKey.get(key);
      return meta ? [meta] : [];
    });
    setIsDeleting(true);
    const ok = await deleteImages(removeImages, images);
    setIsDeleting(false);
    if (ok) exitSelection();
  }, [selectedKeys, isDeleting, metaByKey, removeImages, exitSelection]);

  React.useEffect(() => {
    if (tab !== "models" || !selectionActive || lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        exitSelection();
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
        return;
      e.preventDefault();
      void handleBulkDelete();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, selectionActive, lightboxOpen, handleBulkDelete, exitSelection]);

  const favoritedUrls = React.useMemo(() => {
    const s = new Set<string>();
    completedImages.forEach((url, idx) => {
      if (favSet.has(completedMeta[idx]?.b2Key)) s.add(url);
    });
    return s;
  }, [completedImages, completedMeta, favSet]);

  // Map image URLs to their formState for reproduce functionality
  const imageFormStateMap = React.useMemo(() => {
    const map = new Map<string, GenerateFormState>();
    if (!recentGenerations) return map;

    for (const g of recentGenerations) {
      if (g.status === "pending" || g.status === "processing" || g.status === "failed") continue;
      const urls = g.b2Keys && g.b2Keys.length > 0 ? g.b2Keys.map((key) => mediaUrl(key)) : [];

      for (const url of urls) {
        map.set(url, g.formState as GenerateFormState);
      }
    }
    return map;
  }, [recentGenerations]);

  /*
   * What the tile callbacks look things up in, read at click time.
   *
   * Every tile is handed the same few callbacks, keyed by the image URL it
   * passes back. Closing over the arrays instead gave the callbacks a new
   * identity whenever the list moved — once a second while a job is running —
   * and with them a re-render of every tile in the grid.
   */
  const tileLookup = React.useRef({
    urls: completedImages,
    keys: completedKeys,
    meta: completedMeta,
    formStates: imageFormStateMap,
  });
  React.useLayoutEffect(() => {
    tileLookup.current = {
      urls: completedImages,
      keys: completedKeys,
      meta: completedMeta,
      formStates: imageFormStateMap,
    };
  });

  const handleToggleFavorite = (url: string) => {
    const { urls, meta } = tileLookup.current;
    const entry = meta[urls.indexOf(url)];
    if (entry) void toggleFavorite({ generationId: entry.generationId, b2Key: entry.b2Key });
  };

  const handleReproduce = (imageUrl: string) => {
    const savedFormState = tileLookup.current.formStates.get(imageUrl);
    if (savedFormState) {
      setFormState(savedFormState);
      toast.success("Settings restored");
    }
  };

  const handleSendToApi = React.useCallback(
    (imageUrl: string) => {
      queueApiReference(imageUrl);
      setTab("api");
    },
    [setTab],
  );

  const handleSendToEnhance = (imageUrl: string) => {
    const formState = tileLookup.current.formStates.get(imageUrl);
    sessionStorage.setItem(
      "enhance_source",
      JSON.stringify({
        imageUrl,
        formState: formState || null,
      }),
    );
    router.push("/enhance");
  };

  React.useEffect(() => {
    // Load form state from localStorage
    const saved = localStorage.getItem("artsnack_form_state");
    if (saved) {
      try {
        setFormState(JSON.parse(saved) as GenerateFormState);
      } catch (e) {
        console.error("Failed to parse saved form state:", e);
      }
    }

    setIsHydrated(true);
  }, []);

  React.useEffect(() => {
    if (isHydrated) {
      localStorage.setItem("artsnack_form_state", JSON.stringify(formState));
    }
  }, [formState, isHydrated]);

  /*
   * The two lists are independent and live on the same pod, so each goes out on
   * its own and lands on its own: a slow /api/loras no longer holds the model
   * dropdowns back, and a failing one leaves them populated. The lists from the
   * last visit are already on screen (see `lastModels`); these refresh them.
   */
  React.useEffect(() => {
    if (!modelsMounted) return;
    let disposed = false;
    const applyModels = (models: ModelLists) => {
      setCheckpoints(keepIfSame(models.checkpoints));
      setSamplers(keepIfSame(models.samplers));
      setSchedulers(keepIfSame(models.schedulers));
      setFormState(withCatalogDefaults(models));
    };
    if (lastModels) applyModels(lastModels);

    const refresh = () => {
      void fetchModels().then(({ models, unreachable }) => {
        if (disposed) return;
        if (unreachable) {
          toast.error("Failed to load models. Please check the server.", { id: CATALOG_TOAST_ID });
        }
        if (!models) return;
        lastModels = models;
        applyModels(models);
      });
      void fetchLoras().then(({ loras: next, unreachable }) => {
        if (disposed) return;
        if (unreachable) {
          toast.error("Failed to load models. Please check the server.", { id: CATALOG_TOAST_ID });
        }
        if (!next) return;
        lastLoras = next;
        setLoras(keepIfSame(next));
      });
    };

    refresh();
    // A model that lands on the pod while this page is open — announced from
    // this tab or another one — should reach the dropdowns without a reload.
    const stopWatching = onPodCatalogChange(refresh);
    return () => {
      disposed = true;
      stopWatching();
    };
  }, [modelsMounted]);

  /**
   * Consumes a self-hosted reproduce, then drops the flag from the URL.
   *
   * Dropping it is the load-bearing half. `reproduce=true` outranks `?tab=` in
   * the tab decision — deliberately, so a stale `tab=api` cannot open the hosted
   * composer over a restored self-hosted form — but nothing ever removed it. It
   * therefore kept outranking `?tab=` forever: after one Reproduce from the
   * gallery or Favourites, pressing the API tab wrote `tab=api` into the URL and
   * the page stayed on the self-hosted composer, with no way back short of
   * editing the address bar.
   */
  React.useEffect(() => {
    const isReproduce = searchParams.get("reproduce") === "true";
    if (!isReproduce || typeof window === "undefined") return;

    const stored = sessionStorage.getItem("reproduce_state");
    if (stored) {
      try {
        // Merged over the current form, not assigned. History rows are complete
        // and merge to the same result; a partial hand-off carries only some
        // fields, and assignment used to blank every field it could not fill —
        // checkpoint included.
        const restoredState = JSON.parse(stored) as Partial<GenerateFormState>;
        setFormState((prev) => ({ ...prev, ...restoredState }));
        sessionStorage.removeItem("reproduce_state");
        toast.success("Settings restored from history");
      } catch (e) {
        console.error("Failed to restore settings:", e);
      }
    }

    const params = new URLSearchParams(window.location.search);
    params.delete("reproduce");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/generate?${query}` : "/generate");
  }, [searchParams]);

  const handleGenerate = React.useCallback(async () => {
    if (!formState.prompt.trim()) {
      toast.error("Please enter a prompt");
      return;
    }
    if (isSubmitting) return;

    setIsSubmitting(true);
    const result = await submitGeneration(formState, backend, generateOnBackend);
    setIsSubmitting(false);

    if (result.ok) {
      toast.success("Generation started");
    } else {
      toast.error(result.message);
    }
  }, [formState, isSubmitting, generateOnBackend, backend]);

  const randomizeSeed = () => {
    setFormState((prev) => ({
      ...prev,
      seed: Math.floor(Math.random() * 1000000000),
    }));
  };

  const openLightbox = (index: number) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  /** One handler for every tile; the tile hands back its image URL. */
  const handleTileClick = (event: React.MouseEvent, url: string) => {
    const { urls, keys } = tileLookup.current;
    const index = urls.indexOf(url);
    if (index === -1) return;
    if (selectionActive || event.shiftKey) {
      handleSelect(keys[index], event.shiftKey);
    } else {
      openLightbox(index);
    }
  };

  const updateField = <K extends keyof GenerateFormState>(
    field: K,
    value: GenerateFormState[K],
  ) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  React.useEffect(() => {
    if (tab !== "models") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleGenerate();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tab, handleGenerate]);

  /**
   * Infinite scroll, through the shared hook rather than a fourth hand-rolled
   * observer. The one that used to live here had the two faults that hook was
   * written to fix — it never attached on a cold load, because its effect ran once
   * against a null ref before the sentinel existed, and one intersection bought
   * exactly one page — plus a root of the viewport while the results sit in an
   * `overflow-y-auto` column, which quietly cancelled its own 300px prefetch.
   */
  const loadMoreRef = useInfiniteScroll({
    onLoadMore: () => loadMore(LOAD_MORE_SIZE),
    hasMore: canLoadMore,
    busy: isLoadingMore,
    revision: completedImages.length,
    // A Convex history, which ends: with the end of the list on screen, keep
    // looking until it does.
    maxIdlePagesOnScreen: Infinity,
    // A screen and a half ahead at any zoom, as on the API tab.
    rootMargin: "150%",
  });

  const generateButton = (
    <Button
      size="lg"
      className="w-full text-lg font-semibold h-12"
      onClick={handleGenerate}
      disabled={isSubmitting}
    >
      {isSubmitting ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Starting...
        </>
      ) : (
        "Generate"
      )}
    </Button>
  );

  // Not gated on `isHydrated`: that only says the saved form has been read, and
  // holding the grid back for it delayed a list that may already be cached.
  const hasResults =
    completedImages.length > 0 || pendingGenerations.length > 0 || failedGenerations.length > 0;

  /**
   * Self-hosted / API, as two buttons rather than a band.
   *
   * This used to be an `h-16` row spanning the whole page, which put 64px of
   * chrome above the results grid as well as above the composer — and the grid
   * is the thing the page is for. Each panel now renders it inside its own left
   * column, so the gallery on the right starts directly under the nav bar and
   * the switch is still one click from anywhere.
   */
  const backendTabs = (
    <div
      role="group"
      aria-label="Backend"
      className="inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5"
    >
      <Button
        variant={tab === "models" ? "default" : "ghost"}
        size="sm"
        className="h-6 px-2 text-[11px] font-normal"
        aria-pressed={tab === "models"}
        onClick={() => setTab("models")}
      >
        Self-hosted
      </Button>
      <Button
        variant={tab === "video" ? "default" : "ghost"}
        size="sm"
        className="h-6 px-2 text-[11px] font-normal"
        aria-pressed={tab === "video"}
        onClick={() => setTab("video")}
      >
        Self-hosted video
      </Button>
      <Button
        variant={tab === "api" ? "default" : "ghost"}
        size="sm"
        className="h-6 px-2 text-[11px] font-normal"
        aria-pressed={tab === "api"}
        onClick={() => setTab("api")}
      >
        API
      </Button>
    </div>
  );

  // Each panel mounts the first time its tab opens and stays mounted after. A
  // hand-off to one not opened yet — Send to video, a reproduce link, Send to
  // API — opens its tab, which mounts it, and the panel picks the hand-off up
  // on mount: `videoHandoff` is state here until the panel reports it handled,
  // and the API panel reads its queue and the reproduce id once it is active.
  return (
    <PanelTabsContext.Provider value={backendTabs}>
      {apiMounted && (
        <div hidden={tab !== "api"}>
          <ApiPanel
            active={tab === "api"}
            tabs={backendTabs}
            initialModel={initialModel}
            onModelChange={setModelParam}
            reproduceId={reproduceApiId ?? undefined}
            onReproduceHandled={clearReproduceParam}
            onSendToVideo={sendToVideo}
          />
        </div>
      )}
      {videoMounted && (
        <div hidden={tab !== "video"}>
          <VideoPanel
            active={tab === "video"}
            tabs={backendTabs}
            reproduceId={reproduceVideoId ?? undefined}
            onReproduceHandled={clearVideoReproduceParam}
            handoff={videoHandoff}
            onHandoffHandled={clearVideoHandoff}
          />
        </div>
      )}
      {modelsMounted && (
        <div hidden={tab !== "models"}>
          <>
            <GenerateSplit storageKey="generate-split-models" className="lg:h-[calc(100vh-3.5rem)]">
              <div className="min-w-0 lg:flex lg:flex-col lg:h-full">
                <div className="flex items-center gap-2 border-b px-3 py-2 lg:px-4">
                  {backendTabs}
                  <span className="ml-auto">
                    <BackendStatus />
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-3 pb-24 lg:px-4 lg:pb-4">
                  <div className="max-w-3xl mx-auto lg:max-w-none space-y-4">
                    <div className="space-y-2">
                      <Label>Checkpoint</Label>
                      <SearchableSelect
                        value={formState.checkpoint}
                        onValueChange={(val) => updateField("checkpoint", val)}
                        options={checkpoints}
                        placeholder={
                          checkpoints.length > 0
                            ? "Select a checkpoint..."
                            : "Loading checkpoints..."
                        }
                        emptyMessage="No checkpoints found"
                      />
                    </div>

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
                          availableLoras={loras}
                          onChange={(newLoras) => updateField("loras", newLoras)}
                        />
                      </CollapsibleContent>
                    </Collapsible>

                    <div className="space-y-2">
                      <div className="flex min-h-7 items-center justify-between gap-2">
                        <Label htmlFor="prompt">Prompt</Label>
                        <PromptLibrary
                          value={formState.prompt}
                          onInsert={(text) => updateField("prompt", text)}
                        />
                      </div>
                      <Textarea
                        id="prompt"
                        placeholder="Describe what you want to see..."
                        className="min-h-[100px] resize-y"
                        value={formState.prompt}
                        onChange={(e) => updateField("prompt", e.target.value)}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="negative-prompt">Negative Prompt</Label>
                      <Textarea
                        id="negative-prompt"
                        placeholder="Describe what you want to avoid..."
                        className="min-h-[60px] resize-y"
                        value={formState.negativePrompt}
                        onChange={(e) => updateField("negativePrompt", e.target.value)}
                      />
                    </div>

                    <ImageSizePicker
                      width={Number(formState.width)}
                      height={Number(formState.height)}
                      onChange={(size) => setFormState((previous) => ({ ...previous, ...size }))}
                    />

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
                      <div className="space-y-2">
                        <Label>Batch Size</Label>
                        <div className="flex gap-2">
                          {[1, 2, 4, 8, 12].map((size) => (
                            <Button
                              key={size}
                              variant={Number(formState.batchSize) === size ? "default" : "outline"}
                              className="flex-1"
                              onClick={() => updateField("batchSize", size)}
                            >
                              {size}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </div>

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

                    <Collapsible
                      open={showAdvanced}
                      onOpenChange={setShowAdvanced}
                      className="border rounded-lg p-4"
                    >
                      <CollapsibleTrigger className="flex items-center justify-between w-full">
                        <span className="font-medium text-sm">Advanced Settings</span>
                        {showAdvanced ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-4 space-y-4">
                        <div className="space-y-3">
                          <div className="flex justify-between items-center">
                            <Label>Denoising Strength</Label>
                            <Input
                              type="number"
                              value={formState.denoise}
                              onChange={(e) => updateField("denoise", Number(e.target.value) || 0)}
                              onBlur={(e) =>
                                updateField(
                                  "denoise",
                                  Math.min(1, Math.max(0, Number(e.target.value) || 1)),
                                )
                              }
                              className="w-20 h-8 text-xs font-mono text-right"
                              min={0}
                              max={1}
                              step={0.01}
                            />
                          </div>
                          <Slider
                            value={[Number(formState.denoise)]}
                            min={0}
                            max={1}
                            step={0.01}
                            onValueChange={(vals) =>
                              updateField("denoise", Array.isArray(vals) ? vals[0] : vals)
                            }
                          />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                </div>

                <div className="hidden lg:block border-t bg-background px-3 py-2 lg:px-4">
                  {generateButton}
                </div>
              </div>

              <div className="min-w-0 lg:h-full lg:overflow-y-auto lg:[scrollbar-gutter:stable]">
                {hasResults ? (
                  <div className="py-6 px-4 lg:px-6">
                    <div className="max-w-3xl mx-auto lg:max-w-none">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                        <h2 className="text-2xl font-bold">Results</h2>
                        <div className="flex flex-wrap items-center gap-3">
                          <PreviewZoom scale={previewScale} onChange={setPreviewScale} />
                          {pendingGenerations.length > 0 && (
                            <span className="text-sm text-muted-foreground flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {pendingGenerations.length} generating...
                            </span>
                          )}
                          {failedGenerations.length > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              disabled={isRemovingFailed}
                              onClick={() => void handleRemoveAllFailed()}
                            >
                              {isRemovingFailed ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                              Remove all failed
                            </Button>
                          )}
                          {completedImages.length > 0 && (
                            <Button
                              variant={selectionActive ? "secondary" : "outline"}
                              size="sm"
                              onClick={selectionActive ? exitSelection : enterSelection}
                            >
                              {selectionActive ? "Cancel" : "Select"}
                            </Button>
                          )}
                        </div>
                      </div>

                      <ImageGrid responsive previewScale={previewScale}>
                        {pendingGenerations.map((gen) => (
                          <ImageGridSkeleton
                            key={gen._id}
                            aspectRatio={
                              (Number(gen.formState?.width) || 1) /
                              (Number(gen.formState?.height) || 1)
                            }
                            className="animate-pulse bg-muted/30"
                          >
                            <div className="w-full space-y-3 px-4 text-center">
                              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                              <GenerationProgress value={{ ...gen, mediaType: "image" }} />
                            </div>
                          </ImageGridSkeleton>
                        ))}
                        {failedGenerations.slice(0, 3).map((gen) => (
                          <ImageGridSkeleton
                            key={gen._id}
                            aspectRatio={
                              (Number(gen.formState?.width) || 1) /
                              (Number(gen.formState?.height) || 1)
                            }
                            className="bg-destructive/10 border-destructive/30"
                          >
                            <div className="text-center space-y-2 px-4">
                              <p className="text-sm font-medium text-destructive">Failed</p>
                              <p className="text-xs text-muted-foreground line-clamp-2">
                                {gen.error || "Unknown error"}
                              </p>
                            </div>
                          </ImageGridSkeleton>
                        ))}
                        {completedImages.map((url, idx) => {
                          // Key by the image's stable identity, NOT the array
                          // position. New results prepend to this list, so positional
                          // keys would make React reuse the previous image's tile
                          // instance and feed it a new `src` — the tile briefly renders
                          // its stale internal `currentSrc` (the previous image) before
                          // the sync effect catches up. Identity keys mount new images
                          // fresh and leave existing tiles untouched → no flicker.
                          //
                          // Every prop is a primitive or one of the shared handlers
                          // above, which take the URL back as `itemKey` — so the memo
                          // on ImageGridItem holds and a progress write re-renders no
                          // finished tile. The label is the prompt rather than the
                          // position for the same reason: a position shifts on every
                          // new result.
                          const key = completedKeys[idx];
                          const prompt = imageFormStateMap.get(url)?.prompt;
                          return (
                            <ImageGridItem
                              key={key}
                              itemKey={url}
                              src={completedThumbs[idx]}
                              fallbackSrc={url}
                              aspectRatio={completedAspects[idx]}
                              alt={prompt || "Generated image"}
                              onClick={handleTileClick}
                              selectionActive={selectionActive}
                              selected={selectedKeys.has(key)}
                              onReproduce={imageFormStateMap.has(url) ? handleReproduce : undefined}
                              onSendToEnhance={handleSendToEnhance}
                              onSendToApi={handleSendToApi}
                              copyPrompt={prompt}
                              isFavorited={favSet.has(completedMeta[idx]?.b2Key)}
                              onToggleFavorite={handleToggleFavorite}
                            />
                          );
                        })}
                      </ImageGrid>

                      <div ref={loadMoreRef} className="flex justify-center py-8">
                        {isLoadingMore && (
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <span>Loading more...</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="hidden lg:flex h-full items-center justify-center text-muted-foreground">
                    <div className="text-center space-y-2">
                      <p className="text-lg">No results yet</p>
                      <p className="text-sm">Generated images will appear here</p>
                    </div>
                  </div>
                )}
              </div>
            </GenerateSplit>

            <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-background/80 backdrop-blur-md border-t z-40">
              <div className="max-w-3xl mx-auto">{generateButton}</div>
            </div>

            <SelectionToolbar
              count={selectedKeys.size}
              onDelete={() => void handleBulkDelete()}
              onClear={exitSelection}
              isDeleting={isDeleting}
            />

            <ImageLightbox
              images={completedImages}
              initialIndex={lightboxIndex}
              isOpen={lightboxOpen}
              onClose={() => setLightboxOpen(false)}
              onReproduce={handleReproduce}
              onSendToEnhance={handleSendToEnhance}
              onToggleFavorite={handleToggleFavorite}
              favoritedUrls={favoritedUrls}
              renderActions={(url) => (
                <>
                  {imageFormStateMap.get(url)?.prompt && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-white/70 hover:text-white hover:bg-white/10"
                      title="Copy prompt"
                      onClick={() => {
                        void copyText(imageFormStateMap.get(url)!.prompt).then((ok) => {
                          if (ok) toast.success("Prompt copied");
                        });
                      }}
                    >
                      <Copy className="h-6 w-6" />
                      <span className="sr-only">Copy prompt</span>
                    </Button>
                  )}
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
                </>
              )}
            />
          </>
        </div>
      )}
    </PanelTabsContext.Provider>
  );
}
