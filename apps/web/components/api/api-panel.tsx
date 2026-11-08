"use client";

import { referenceOutputKey } from "@/lib/reference-generation";

import * as React from "react";
import dynamic from "next/dynamic";
import { GenerateSplit } from "@/components/generate-split";
import { useAction, useMutation, useQuery } from "convex/react";
import { usePaginatedQuery as useCachedPaginatedQuery } from "@/lib/convex-cache";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GrokConnect } from "@/components/grok/grok-connect";
import { ApiForm } from "@/components/api/api-form";
import {
  ApiResults,
  isSelfHostedVideo,
  modelIdOf,
  type GenerationDoc,
} from "@/components/api/api-results";
import { ModelSwitcher } from "@/components/api/model-switcher";
import { PriceTag } from "@/components/api/price-tag";
import { CreditsBadge } from "@/components/api/credits-badge";
import { AtlasBalanceBadge } from "@/components/api/atlas-balance-badge";
import { priceForVariant, useHiggsfieldQuotes } from "@/components/api/use-api-price";
import { useHeldWhileHidden } from "@/components/api/use-held-while-hidden";
import { uploadToStorage, withServerTimeout } from "@/components/api/submit-guards";
import { useStableRows } from "@/hooks/use-stable-rows";
import type { RefImage } from "@/components/api/types";
import { isAttachableImageFile, referenceImageBlob } from "@/lib/image-file";
import { prepareReferenceImage } from "@/lib/resize-image";
import { imageUrlToBlob } from "@/lib/fetch-image";
import { mediaUrl, videoUrl } from "@/lib/media-url";
import {
  API_MODELS,
  GROK_VIDEO_MODEL_V15,
  getApiModel,
  higgsfieldVideoModel,
  imageMaxReferences,
  isGrokImageQuality,
  isGrokVideoMode,
  isGrokVideoModelId,
  maxAttachableReferences,
  modelsForProvider,
  resolveImageRatio,
  type ApiModelId,
  type MediaType,
} from "@/lib/api-models";
import {
  grokSourceResolution,
  parseGrokFrameRole,
  remapGrokFrameRoles,
  type GrokSourceVideo,
} from "@/lib/grok-imagine";
import { grokVariantFor } from "@/lib/api-price";
import { isGrokSourceVideoKey } from "@/lib/image-key";
import { probeVideo } from "@/lib/probe-video";
import { isMp4File } from "@/components/api/grok-video-controls";
import {
  atlasFamilyMaxReferences,
  atlasMaxReferences,
  atlasPromptValue,
  getAtlasModel,
  isAtlasModelId,
  type AtlasParamValue,
} from "@/lib/atlas-models";
import { buildAtlasRequest } from "@/lib/atlas-payload";
import { validateAtlasReferences } from "@/lib/atlas-reference-validation";
import { quoteAtlas } from "@/lib/atlas-price";
import { atlasDraftCompletion } from "@/lib/atlas-drafts";
import { usdPrice, type Price } from "@/lib/api-pricing";
import {
  API_FORM_STORAGE_KEY,
  DEFAULT_API_FORM,
  LEGACY_GROK_FORM_STORAGE_KEY,
  activeAtlasModelId,
  activeAtlasParams,
  atlasJobsFor,
  grokFrameCropsFor,
  grokVideoOptionsFor,
  hydrateForm,
  normalizeForm,
  withActiveAtlasModel,
  withActiveAtlasParams,
  withAtlasRow,
  withRegistryModel,
  type ApiFormState,
  type ComposerProvider,
} from "@/lib/normalize-form";
import { remapAtlasReferenceDetails } from "@/lib/atlas-records";
import {
  planReferenceBatch,
  takeQueuedReferences,
  videoReproduceHref,
  type VideoHandoffRole,
} from "@/lib/reference-handoff";
import { loadApiReferences, saveApiReferences } from "@/lib/reference-store";
import { getGrokReferenceTagIndices, restoreGrokReferenceTags } from "@/lib/grok-prompt";
import { Id } from "@/convex/_generated/dataModel";

/*
 * Closed by default, so their code waits until they are first opened: the
 * Image → Prompt tool, the gallery picker and the reference preview are three
 * of the heavier modules on what is already the largest route in the app.
 */
const ImageToPromptPanel = dynamic(
  () => import("@/components/api/image-to-prompt-panel").then((mod) => mod.ImageToPromptPanel),
  { ssr: false },
);
const ReferencePicker = dynamic(
  () => import("@/components/grok/reference-picker").then((mod) => mod.ReferencePicker),
  { ssr: false },
);
const ReferencePreview = dynamic(
  () => import("@/components/api/reference-preview").then((mod) => mod.ReferencePreview),
  { ssr: false },
);

const INITIAL_PAGE_SIZE = 30;
/** "1" while the Image → Prompt tool is showing instead of a provider's form. */
const DESCRIBE_MODE_STORAGE_KEY = "artsnack_api_describe";

function refId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * How many references the form's model takes, read from the form rather than
 * from render. The attach callbacks read it this way so that they keep one
 * identity across model switches — they are handed to every results tile.
 */
function maxReferencesFor(form: ApiFormState): number {
  return form.provider === "atlas"
    ? atlasFamilyMaxReferences(getAtlasModel(activeAtlasModelId(form)))
    : maxAttachableReferences(getApiModel(form.model));
}

/**
 * Runs `work`, reporting a rejection as a toast and resolving to `undefined`.
 *
 * Module scope is the whole point. The React Compiler cannot lower a `try` that
 * holds a finalizer or any conditional expression, and it abandons the *entire*
 * enclosing component when it meets one — this panel is 700 lines of it. Every
 * handler below therefore keeps its error handling out here instead.
 */
async function toastOnFailure<T>(work: () => Promise<T>, fallback: string): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : fallback);
    return undefined;
  }
}

/**
 * `removeMany` caps one transaction, so a long select-all is sent in turns — and
 * a failure part-way has to say how much already went. Module-level for the
 * same React Compiler reason as `toastOnFailure`.
 */
async function removeInChunks(
  removeMany: (args: { ids: Id<"grokGenerations">[] }) => Promise<number>,
  gens: GenerationDoc[],
): Promise<number> {
  const ids = gens.map((gen) => gen._id);
  let removed = 0;
  try {
    for (let start = 0; start < ids.length; start += 200) {
      removed += await removeMany({ ids: ids.slice(start, start + 200) });
    }
  } catch (error) {
    if (removed === 0) throw error;
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Deleted ${removed}, then stopped: ${reason}`);
  }
  return removed;
}

interface ApiPanelProps {
  active: boolean;
  /** The Self-hosted / API switch, rendered inside this panel's own toolbar. */
  tabs?: React.ReactNode;
  initialModel?: ApiModelId;
  onModelChange?: (model: ApiModelId) => void;
  /** Generation whose settings to restore on arrival, from the gallery. */
  reproduceId?: string;
  /** Called once the id above has been dealt with, so the URL can be tidied. */
  onReproduceHandled?: () => void;
  /** Hands a result to the Self-hosted video tab as a frame or reference. */
  onSendToVideo?: (url: string, role: VideoHandoffRole) => void;
}

export function ApiPanel({
  active,
  tabs,
  initialModel,
  onModelChange,
  reproduceId,
  onReproduceHandled,
  onSendToVideo,
}: ApiPanelProps) {
  const router = useRouter();
  const connection = useQuery(api.grokAuth.getConnection);
  const disconnect = useMutation(api.grokAuth.disconnect);
  const generateRefUploadUrl = useMutation(api.grokGenerations.generateRefUploadUrl);
  const startImage = useMutation(api.grokGenerations.startImage);
  const startVideo = useMutation(api.grokGenerations.startVideo);
  const startAtlas = useMutation(api.atlas.start);
  const uploadSourceVideo = useAction(api.grokProcessor.uploadSourceVideo);
  const removeGeneration = useMutation(api.grokGenerations.remove);
  const removeAllFailed = useMutation(api.grokGenerations.removeAllFailed);
  const removeManyGenerations = useMutation(api.grokGenerations.removeMany);
  const featureFlags = useQuery(api.featureFlags.mine);
  // Until the flags load, nothing is hidden: a tab appearing late is better
  // than one flashing out of a row the owner is about to click.
  const hiddenProviders: ComposerProvider[] = [
    ...(featureFlags?.higgsfield === false ? (["higgsfield"] as const) : []),
    ...(featureFlags?.fal === false ? (["fal"] as const) : []),
  ];

  const {
    results: liveGenerations,
    status: generationsStatus,
    loadMore,
  } = useCachedPaginatedQuery(api.grokGenerations.list, {}, { initialNumItems: INITIAL_PAGE_SIZE });
  /*
   * Every push is a new array of new rows, and a running self-hosted clip pushes
   * every second or two just to renew its lease. Unchanged rows keep their
   * identity, so the memoized tiles hold — and while this tab is hidden the list
   * is held outright, so nothing downstream of it runs at all.
   */
  const generations = useHeldWhileHidden(useStableRows(liveGenerations as GenerationDoc[]), active);
  // Convex rebuilds `loadMore` whenever the last page changes — on every push —
  // so it is read through a ref, and the grid is handed one function for good.
  const latestLoadMore = React.useRef(loadMore);
  React.useLayoutEffect(() => {
    latestLoadMore.current = loadMore;
  });

  // Saved settings are restored in the initialiser rather than a mount effect.
  // The effect needed an exhaustive-deps suppression, and a single
  // eslint-disable anywhere in a component switches the React Compiler off for
  // all 700 lines of it. Reading here is safe because the panel never renders
  // on the server: /generate bails to the client for useSearchParams.
  const [form, setForm] = React.useState<ApiFormState>(() => {
    if (typeof window === "undefined") return DEFAULT_API_FORM;
    const restored = hydrateForm(
      localStorage.getItem(API_FORM_STORAGE_KEY),
      // Settings saved before the model switcher shipped; read once so a
      // returning user doesn't find their form reset to defaults.
      localStorage.getItem(LEGACY_GROK_FORM_STORAGE_KEY),
    );
    // A ?model= in the URL wins over whatever was last used here.
    // withRegistryModel, not a bare `model:` — the provider has to move with it
    // or the switcher highlights one provider while the button runs another.
    return initialModel ? normalizeForm(withRegistryModel(restored, initialModel)).form : restored;
  });
  // A reproduce link means "show me the generator", whatever was open last.
  const [describing, setDescribingState] = React.useState(
    () =>
      typeof window !== "undefined" &&
      !reproduceId &&
      localStorage.getItem(DESCRIBE_MODE_STORAGE_KEY) === "1",
  );
  // The tool is mounted the first time it is opened and kept from then on, so
  // its results survive a trip to a provider and back.
  const [describeMounted, setDescribeMounted] = React.useState(describing);
  const setDescribing = React.useCallback((next: boolean) => {
    localStorage.setItem(DESCRIBE_MODE_STORAGE_KEY, next ? "1" : "0");
    setDescribingState(next);
    if (next) setDescribeMounted(true);
  }, []);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submissionStatus, setSubmissionStatus] = React.useState<string | null>(null);
  const [isRestoringReferences, setIsRestoringReferences] = React.useState(false);
  const [sourceVideoBusy, setSourceVideoBusy] = React.useState(false);
  const [isRemovingFailed, setIsRemovingFailed] = React.useState(false);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  // Bumped after every submission so the Atlas balance badge re-reads. It is an
  // action, not a query, so nothing tells it the number moved.
  const [spendEpoch, setSpendEpoch] = React.useState(0);

  const [refImages, setRefImages] = React.useState<RefImage[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [previewRef, setPreviewRef] = React.useState<RefImage | null>(null);
  // Prompt Studio takes the results pane while open. The host is state, not a
  // ref, so the form re-renders into it once it exists.
  const [studioOpen, setStudioOpen] = React.useState(false);
  const [studioHost, setStudioHost] = React.useState<HTMLDivElement | null>(null);

  // Both mirrors are written through the setters below rather than during
  // render: a ref assignment in the render body is a Rules-of-React violation
  // that makes the React Compiler bail out of this component entirely, and it
  // is also wrong for the loop in handleRefFiles, where several images are
  // added before React commits.
  const formRef = React.useRef(form);
  const applyForm = React.useCallback((next: ApiFormState) => {
    formRef.current = next;
    setForm(next);
  }, []);

  const refImagesRef = React.useRef(refImages);
  const applyRefImages = React.useCallback(
    (update: (prev: RefImage[]) => RefImage[]) => {
      const previous = refImagesRef.current;
      const next = update(previous);
      const current = formRef.current;
      if (current.provider === "atlas" && previous.length > 0) {
        applyForm(
          withActiveAtlasParams(
            current,
            remapAtlasReferenceDetails(
              getAtlasModel(activeAtlasModelId(current)),
              activeAtlasParams(current),
              previous.filter((ref) => ref.selected).map((ref) => ref.id),
              next.filter((ref) => ref.selected).map((ref) => ref.id),
            ),
          ),
        );
      }
      // Grok's roles are per selected image, by position — so they are moved
      // with their images whenever the selection changes, or deselecting the
      // first of three would make the second the new first frame. Skipped when
      // nothing was attached before: that is a reload or a reproduce putting a
      // set in place, and the roles that go with it arrive with the form.
      const previousSelected = previous.filter((ref) => ref.selected).map((ref) => ref.id);
      const nextSelected = next.filter((ref) => ref.selected).map((ref) => ref.id);
      const grokRoles = formRef.current.grokFrameRoles;
      if (
        previous.length > 0 &&
        grokRoles.length > 0 &&
        previousSelected.join("\n") !== nextSelected.join("\n")
      ) {
        applyForm({
          ...formRef.current,
          grokFrameRoles: remapGrokFrameRoles(grokRoles, previousSelected, nextSelected),
        });
      }
      refImagesRef.current = next;
      setRefImages(next);
      // Persisted here rather than in an effect because this callback is the only
      // place refImages ever changes — attach, remove, toggle and the reproduce
      // path all funnel through it. Fire-and-forget: a failed write costs the user
      // persistence on the next reload, never the attachment they just made.
      void saveApiReferences(
        next.map((ref) => ({
          id: ref.id,
          blob: ref.blob,
          aspect: ref.aspect,
          width: ref.width,
          height: ref.height,
          selected: ref.selected,
          sourceUrl: ref.sourceUrl,
        })),
      );

      // Reference count is what routes an Atlas family from first-frame input
      // to its reference-list endpoint. Reconcile on the attachment itself, not
      // on the next prompt keystroke, so the third Seedance image is enough to
      // switch the active endpoint immediately.
      const normalized = normalizeForm(
        formRef.current,
        next.filter((reference) => reference.selected).length,
      );
      applyForm(normalized.form);
      if (normalized.adjustments.length > 0) toast.info(normalized.adjustments.join(" · "));
    },
    [applyForm],
  );

  const model = getApiModel(form.model);
  const isAtlas = form.provider === "atlas";
  /**
   * The Atlas model driving the form, or null for the other three.
   *
   * There is one per media type rather than one overall, because Atlas has no
   * model that does both — text-to-video and image-to-video are separate
   * entries in its catalogue, let alone image and video.
   */
  const atlasModel = React.useMemo(
    () => (isAtlas ? getAtlasModel(activeAtlasModelId(form)) : null),
    [isAtlas, form],
  );
  const selectedRefs = React.useMemo(() => refImages.filter((ref) => ref.selected), [refImages]);
  const refCount = selectedRefs.length;
  const maxReferences = atlasModel
    ? atlasFamilyMaxReferences(atlasModel)
    : maxAttachableReferences(model);
  const referenceIssues = React.useMemo(
    () =>
      atlasModel
        ? validateAtlasReferences(
            atlasModel,
            selectedRefs.map((reference) => ({
              width: reference.width,
              height: reference.height,
              aspect: reference.aspect,
              bytes: reference.blob.size,
            })),
          )
        : [],
    [atlasModel, selectedRefs],
  );

  React.useEffect(() => {
    localStorage.setItem(API_FORM_STORAGE_KEY, JSON.stringify(form));
  }, [form]);

  // Restore the references a reload threw away.
  //
  // An effect, and unavoidably so: IndexedDB is asynchronous, which rules out
  // the lazy useState initialiser the form itself uses. It runs once and gives
  // up the moment anything else has already put references in place — the
  // reproduce path and the gallery hand-off both land during mount too, and
  // they are a deliberate choice by the user, where this is only a recovery.
  // Deliberately no "already ran" ref guard: StrictMode mounts, cleans up and
  // remounts, so a ref latched on the first pass would leave the restore
  // cancelled and never retried in development. `cancelled` plus the emptiness
  // check below is what makes a second pass safe — and idempotent.
  React.useEffect(() => {
    let cancelled = false;
    void loadApiReferences().then((stored) => {
      if (cancelled || stored.length === 0) return;
      if (refImagesRef.current.length > 0) return;
      applyRefImages(() =>
        stored.map((ref) => ({
          id: ref.id,
          blob: ref.blob,
          // Object URLs die with the document that created them, so the handle
          // is minted fresh rather than persisted.
          previewUrl: URL.createObjectURL(ref.blob),
          aspect: ref.aspect,
          width: ref.width,
          height: ref.height,
          selected: ref.selected,
          sourceUrl: ref.sourceUrl,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [applyRefImages]);

  // References stay mounted across tab switches; revoke URLs only on a real
  // unmount (leaving the page).
  React.useEffect(() => {
    return () => {
      for (const ref of refImagesRef.current) URL.revokeObjectURL(ref.previewUrl);
    };
  }, []);

  // Stray drops outside the drop zone must never navigate the page away.
  React.useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  /**
   * Every edit goes through normalizeForm, so the state is never momentarily
   * illegal for the selected model. That matters beyond tidiness: the price
   * shown on the button is computed from these fields, and an impossible
   * combination (1080p on the Mini tier, say) has no price to show.
   */
  const updateField = React.useCallback(
    <K extends keyof ApiFormState>(field: K, value: ApiFormState[K]) => {
      const { form: normalized, adjustments } = normalizeForm(
        { ...formRef.current, [field]: value },
        refImagesRef.current.filter((ref) => ref.selected).length,
      );
      applyForm(normalized);
      if (adjustments.length > 0) toast.info(adjustments.join(" · "));
    },
    [applyForm],
  );

  const changeModel = React.useCallback(
    (next: ApiModelId) => {
      updateField("model", next);
      onModelChange?.(next);
    },
    [updateField, onModelChange],
  );

  /**
   * Switching provider.
   *
   * Leaving Atlas restores whichever registry model this provider was last on,
   * and arriving at Atlas leaves the registry model alone — both halves of the
   * form are kept legal at all times by normalizeForm, so a round trip is
   * lossless rather than a reset.
   */
  const changeProvider = React.useCallback(
    (next: ComposerProvider) => {
      if (next === formRef.current.provider) return;
      if (next === "atlas") {
        updateField("provider", next);
        return;
      }
      // Keep the model name across providers where both offer it, so switching
      // backends does not silently change the model too.
      const candidates = modelsForProvider(next);
      const current = API_MODELS[formRef.current.model];
      const sameLabel = candidates.find((candidate) => candidate.label === current?.label);
      const target = (sameLabel ?? candidates[0]).id;
      const { form: normalized, adjustments } = normalizeForm(
        { ...formRef.current, provider: next, model: target },
        refImagesRef.current.filter((ref) => ref.selected).length,
      );
      applyForm(normalized);
      if (adjustments.length > 0) toast.info(adjustments.join(" · "));
      onModelChange?.(target);
    },
    [updateField, applyForm, onModelChange],
  );

  const changeAtlasModel = React.useCallback(
    (next: string) => {
      const { form: normalized, adjustments } = normalizeForm(
        withActiveAtlasModel(formRef.current, next),
        refImagesRef.current.filter((ref) => ref.selected).length,
      );
      applyForm(normalized);
      if (adjustments.length > 0) toast.info(adjustments.join(" · "));
    },
    [applyForm],
  );

  const changeAtlasParam = React.useCallback(
    (name: string, value: AtlasParamValue) => {
      const current = formRef.current;
      const { form: normalized, adjustments } = normalizeForm(
        withActiveAtlasParams(current, { ...activeAtlasParams(current), [name]: value }),
        refImagesRef.current.filter((ref) => ref.selected).length,
      );
      applyForm(normalized);
      if (adjustments.length > 0) toast.info(adjustments.join(" · "));
    },
    [applyForm],
  );

  /**
   * Attaches one image, and decides what "full" means.
   *
   * A hand-off — "Send to API" from the gallery, Favourites or Enhance — is a
   * request to work on *this* image, so hitting the cap has to make room rather
   * than refuse. Several models take exactly one reference, and there the old
   * behaviour turned a deliberate action into "Maximum 1 reference images" and
   * left the user to hunt for the X on a thumbnail they had forgotten about.
   *
   * Picking files by hand is the opposite case and keeps the refusal: dropping
   * five images on a one-slot model and silently keeping the last would throw
   * away four the user had just chosen.
   */
  const addBlob = React.useCallback(
    async (raw: Blob, options?: { replaceWhenFull?: boolean; sourceUrl?: string }) => {
      const limit = maxReferencesFor(formRef.current);
      // A model that takes no references at all is never "make room" — there is
      // no room to make. 97 of Atlas's 264 models are in this position, and
      // their reference block is hidden entirely, so an attachment made here
      // would be invisible, unremovable, and refused at submit.
      if (limit === 0) {
        toast.error("This model does not take reference images");
        return { replaced: 0 };
      }
      if (refImagesRef.current.length >= limit && !options?.replaceWhenFull) {
        toast.error(`Maximum ${limit} reference images`);
        return { replaced: 0 };
      }
      // Prepared at fal's ceiling; Grok's tighter limits are applied at submit,
      // so switching models never needs the original file again.
      const prepared = await prepareReferenceImage(raw, "fal");

      /*
       * Capacity — and every check made on it above — is re-read after the
       * await, not trusted from before it.
       *
       * `prepareReferenceImage` waits its turn in a queue and re-encodes, and a
       * hand-off fetches over the network first, so both the list and the model
       * can change while this is in flight. A drag-and-drop landing during a
       * slow "Send to API" saw the pre-await count, and dropped a reference on
       * the path that is supposed to refuse rather than drop. A switch to a
       * model that takes no references at all was worse: "make room" then
       * removed every attachment and added the new one to a reference block
       * that is hidden for that model. Nothing has been changed or created yet
       * at this point, so refusing here leaves no trace.
       */
      const current = refImagesRef.current;
      const capacity = maxReferencesFor(formRef.current);
      if (capacity === 0) {
        toast.error("This model does not take reference images");
        return { replaced: 0 };
      }
      if (current.length >= capacity && !options?.replaceWhenFull) {
        toast.error(`Maximum ${capacity} reference images`);
        return { replaced: 0 };
      }
      const surplus = options?.replaceWhenFull ? Math.max(0, current.length - (capacity - 1)) : 0;

      /*
       * The *newest* attachments give way, never the oldest.
       *
       * References are positional: assignAtlasMedia fills a model's media
       * parameters in order, and atlasFrameSlots labels them Start/End or
       * Image/Mask. Dropping from the front shifts every survivor into the
       * previous slot — on flux-dev a full strip promoted the mask into the
       * image slot and filed the new picture as the mask, then billed for it;
       * on a nine-slot Seedream every `@imageN` in the prompt came to name a
       * different picture. Dropping from the back cannot re-assign a role that
       * is already meant.
       */
      const dropped = surplus > 0 ? current.slice(current.length - surplus) : [];
      // Revoked for the same reason removeRef revokes: nothing else will.
      for (const ref of dropped) URL.revokeObjectURL(ref.previewUrl);

      applyRefImages((prev) => [
        ...(surplus > 0 ? prev.slice(0, Math.max(0, prev.length - surplus)) : prev),
        {
          id: refId(),
          blob: prepared.blob,
          previewUrl: URL.createObjectURL(prepared.blob),
          sourceUrl: options?.sourceUrl,
          aspect: prepared.aspect,
          width: prepared.width,
          height: prepared.height,
          selected: true,
        },
      ]);
      return { replaced: dropped.length };
    },
    [applyRefImages],
  );

  const handleRefFiles = React.useCallback(
    async (files: File[] | FileList) => {
      for (const file of [...files]) {
        if (!isAttachableImageFile(file)) continue;
        await toastOnFailure(() => addBlob(referenceImageBlob(file)), "Failed to process image");
      }
    },
    [addBlob],
  );

  /**
   * `switchToVideo` is three-way: `true` is "Make video", `false` is "use for a
   * new image" and moves a form sitting in video mode back to images, and
   * absent leaves the media type alone — the gallery picker attaches to
   * whichever mode is already showing.
   */
  const addReferenceFromUrl = React.useCallback(
    async (url: string, switchToVideo?: boolean) => {
      await toastOnFailure(async () => {
        // A hand-off makes room rather than refusing — see addBlob.
        const { replaced } = await addBlob(await imageUrlToBlob(url), {
          replaceWhenFull: true,
          sourceUrl: url,
        });
        const switchedToImage = switchToVideo === false && formRef.current.mediaType === "video";
        if (switchToVideo) {
          updateField("mediaType", "video");
          // "Make video" means animate this image: a Grok form left on Edit or
          // Extend would file it in a strip those modes do not show.
          if (formRef.current.provider === "grok" && formRef.current.grokVideoMode !== "generate") {
            updateField("grokVideoMode", "generate");
          }
        } else if (switchedToImage) updateField("mediaType", "image");
        // Replacing is said out loud. Silently dropping an image someone
        // attached earlier is the kind of thing that is only noticed after a
        // paid generation comes back wrong.
        const what =
          replaced === 0
            ? "Reference attached"
            : replaced === 1
              ? "Reference attached — replaced the last one"
              : `Reference attached — replaced the last ${replaced}`;
        toast.success(
          switchToVideo ? `${what} — video mode` : switchedToImage ? `${what} — image mode` : what,
        );
      }, "Failed to attach reference");
    },
    [addBlob, updateField],
  );

  const addReferencesFromUrls = React.useCallback(
    async (urls: string[], switchToVideo?: boolean) => {
      const limit = maxReferencesFor(formRef.current);
      if (limit === 0) {
        toast.error("This model does not take reference images");
        return;
      }

      const acceptedUrls = urls.slice(0, limit);
      const settled = await Promise.allSettled(
        acceptedUrls.map(async (url) => ({
          ...(await prepareReferenceImage(await imageUrlToBlob(url), "fal")),
          sourceUrl: url,
        })),
      );
      const ready = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (ready.length === 0) {
        toast.error("Failed to attach selected references");
        return;
      }

      // Re-read after the awaits, for the same reason as in addBlob: the model
      // may have changed while the batch downloaded. Only what still fits gets
      // an object URL, so nothing is minted for an image that will not show.
      const capacity = maxReferencesFor(formRef.current);
      if (capacity === 0) {
        toast.error("This model does not take reference images");
        return;
      }
      const prepared = ready.slice(0, capacity);
      const current = refImagesRef.current;
      const incoming = prepared.map((image) => ({
        id: refId(),
        blob: image.blob,
        previewUrl: URL.createObjectURL(image.blob),
        sourceUrl: image.sourceUrl,
        aspect: image.aspect,
        width: image.width,
        height: image.height,
        selected: true,
      }));
      const plan = planReferenceBatch(current, incoming, capacity);
      for (const ref of plan.dropped) URL.revokeObjectURL(ref.previewUrl);

      applyRefImages(() => plan.next);
      if (switchToVideo) {
        updateField("mediaType", "video");
        if (formRef.current.provider === "grok" && formRef.current.grokVideoMode !== "generate") {
          updateField("grokVideoMode", "generate");
        }
      }

      // Over capacity either before the downloads or, after a model switch, after.
      const skippedForCapacity =
        urls.length - acceptedUrls.length + (ready.length - prepared.length);
      const failed = acceptedUrls.length - ready.length;
      const replacementNotice =
        plan.dropped.length === 0
          ? ""
          : ` — replaced the last ${plan.dropped.length} existing reference${plan.dropped.length === 1 ? "" : "s"}`;
      toast.success(
        `${prepared.length} reference${prepared.length === 1 ? "" : "s"} attached${replacementNotice}${switchToVideo ? " — video mode" : ""}`,
      );
      if (skippedForCapacity > 0 || failed > 0) {
        toast.warning(
          `${skippedForCapacity + failed} selected image${skippedForCapacity + failed === 1 ? " was" : "s were"} not attached${skippedForCapacity > 0 ? ` — this model accepts ${capacity}` : ""}`,
        );
      }
    },
    [applyRefImages, updateField],
  );

  /**
   * Makes a clip the source of a Grok Edit or Extend, moving the form to Grok
   * video. `mode` comes from the tile's menu; an upload made from the form
   * leaves the mode the form is already in.
   */
  const applySourceVideo = React.useCallback(
    (source: GrokSourceVideo, mode?: "edit" | "extend") => {
      const current = formRef.current;
      const nextMode =
        mode ?? (current.grokVideoMode === "generate" ? "edit" : current.grokVideoMode);
      const { form: normalized, adjustments } = normalizeForm(
        {
          ...withRegistryModel(current, "grok"),
          mediaType: "video",
          grokVideoMode: nextMode,
          grokSourceVideo: source,
        },
        refImagesRef.current.filter((ref) => ref.selected).length,
      );
      applyForm(normalized);
      if (current.model !== "grok" || current.provider !== "grok") onModelChange?.("grok");
      if (adjustments.length > 0) toast.info(adjustments.join(" · "));
    },
    [applyForm, onModelChange],
  );

  /**
   * "Edit/Extend with Grok" on a result. The clip is already in B2 under an
   * mp4 key, so nothing is uploaded: its length and size are read from the
   * CDN's metadata, which is what Edit's 8.7 s and Extend's 2–15 s rules need.
   */
  const setSourceFromResult = React.useCallback(
    async (key: string, mode: "edit" | "extend") => {
      if (!isGrokSourceVideoKey(key)) {
        toast.error("Grok edits and extends mp4 clips only");
        return;
      }
      await toastOnFailure(async () => {
        const probe = await probeVideo(videoUrl(key));
        setDescribing(false);
        applySourceVideo(
          {
            key,
            seconds: probe.seconds,
            resolution: grokSourceResolution(probe.width, probe.height),
          },
          mode,
        );
        toast.success(
          mode === "edit"
            ? `Clip set as the source — Grok Edit (${probe.seconds} s)`
            : `Clip set as the source — Grok Extend (${probe.seconds} s)`,
        );
      }, "Could not read that clip");
    },
    [applySourceVideo, setDescribing],
  );

  /**
   * An mp4 picked or dropped on the source slot. It goes to Convex storage,
   * then through `uploadSourceVideo`, which checks it is an MP4, measures it
   * and parks it in B2 — so it is uploaded once, however many edits follow.
   */
  const pickSourceVideo = React.useCallback(
    async (file: File) => {
      if (!isMp4File(file)) {
        toast.error("Grok edits and extends MP4 video only");
        return;
      }
      setSourceVideoBusy(true);
      await toastOnFailure(async () => {
        const uploadUrl = await withServerTimeout(generateRefUploadUrl({}));
        // Typed as video, so the server can tell the upload from a reference
        // image if it has to clean up after a refusal.
        const upload = file.type ? file : new File([file], file.name, { type: "video/mp4" });
        const storageId = await uploadToStorage(uploadUrl, upload, "Failed to upload the video");
        const stored = await withServerTimeout(uploadSourceVideo({ storageId }), 120_000);
        // The length is the server's, read from the file itself — the same
        // figure the processor checks again before sending the job.
        if (stored.seconds === null) {
          throw new Error(
            "This MP4 does not say how long it is (a fragmented stream) — re-export it as a regular MP4",
          );
        }
        // The browser is asked for the size only where the file did not say,
        // and a codec it cannot play (H.265 without support) is not an error.
        let resolution = stored.resolution;
        if (!resolution) {
          const preview = URL.createObjectURL(file);
          const probe = await probeVideo(preview)
            .catch(() => null)
            .finally(() => URL.revokeObjectURL(preview));
          resolution = probe ? grokSourceResolution(probe.width, probe.height) : "720p";
        }
        applySourceVideo({ key: stored.key, seconds: stored.seconds, resolution });
        toast.success("Source video uploaded");
      }, "Failed to upload the video");
      setSourceVideoBusy(false);
    },
    [generateRefUploadUrl, uploadSourceVideo, applySourceVideo],
  );

  // References handed over from the self-hosted tab or another page. Search
  // can send a whole ordered selection, avoiding a route round-trip per image.
  React.useEffect(() => {
    if (!active) return;
    const queued = takeQueuedReferences();
    if (!queued) return;
    // Handed-over references are for generating with; they would attach
    // unseen behind the Image → Prompt tool.
    setDescribing(false);
    if (queued.urls.length === 1) {
      // Only an explicit mode moves the form; a plain hand-off from the gallery
      // attaches to whichever media type is already showing.
      void addReferenceFromUrl(
        queued.urls[0],
        queued.mode === "video" ? true : queued.mode === "image" ? false : undefined,
      );
      return;
    }
    void addReferencesFromUrls(queued.urls, queued.mode === "video");
  }, [active, addReferenceFromUrl, addReferencesFromUrls, setDescribing]);

  const toggleRefSelected = React.useCallback(
    (id: string) => {
      applyRefImages((prev) =>
        prev.map((ref) => (ref.id === id ? { ...ref, selected: !ref.selected } : ref)),
      );
    },
    [applyRefImages],
  );

  const removeRef = React.useCallback(
    (id: string) => {
      applyRefImages((prev) => {
        const target = prev.find((ref) => ref.id === id);
        if (target) URL.revokeObjectURL(target.previewUrl);
        return prev.filter((ref) => ref.id !== id);
      });
    },
    [applyRefImages],
  );

  /**
   * Grok caps references at ~400KB / 768px, so they are re-encoded from the
   * stored fal-quality blob at the boundary. Cached per reference: without it
   * a seven-image batch re-ran seven canvas encodes on the main thread on every
   * single submit. A pinned frame cropped to the clip's ratio (`crop`) is
   * cached apart, under that ratio.
   */
  const grokBlobFor = React.useCallback(
    async (ref: RefImage, crop: string | null): Promise<Blob> => {
      if (crop === null && ref.grokBlob) return ref.grokBlob;
      if (crop !== null && ref.grokCrop?.ratio === crop) return ref.grokCrop.blob;
      const prepared = await prepareReferenceImage(ref.blob, "grok", crop ?? undefined);
      const cached =
        crop === null
          ? { grokBlob: prepared.blob }
          : { grokCrop: { ratio: crop, blob: prepared.blob } };
      applyRefImages((prev) =>
        prev.map((candidate) =>
          candidate.id === ref.id ? { ...candidate, ...cached } : candidate,
        ),
      );
      return prepared.blob;
    },
    [applyRefImages],
  );

  /** `crops`: the ratio each selected image is cut to first, by position (Grok video). */
  const uploadReferences = React.useCallback(
    async (
      crops: readonly (string | null)[] = [],
    ): Promise<{
      referenceStorageIds?: Id<"_storage">[];
      referenceSourceKeys?: (string | null)[];
    }> => {
      if (selectedRefs.length === 0) return {};
      const ids: Id<"_storage">[] = [];
      // Keyed on the provider the form is actually on, not on the registry entry.
      // `model` is whatever legacy model was last selected and stays put while
      // Atlas is active, so reading its provider here downsized every Atlas
      // reference to Grok's 768px / 400KB ceiling for anyone who had been on Grok
      // beforehand — silently, since the thumbnail looks identical.
      const downsizeForGrok = form.provider === "grok";
      for (const [index, ref] of selectedRefs.entries()) {
        setSubmissionStatus(`Uploading reference ${index + 1} of ${selectedRefs.length}...`);
        const blob = downsizeForGrok ? await grokBlobFor(ref, crops[index] ?? null) : ref.blob;
        const uploadUrl = await withServerTimeout(generateRefUploadUrl({}));
        ids.push(await uploadToStorage(uploadUrl, blob));
      }
      return {
        referenceStorageIds: ids,
        referenceSourceKeys: selectedRefs.map((ref) => referenceOutputKey(ref.sourceUrl)),
      };
    },
    [selectedRefs, generateRefUploadUrl, form.provider, grokBlobFor],
  );

  const imageCaps = model.image;
  const videoCaps = model.video;
  const isImage = form.mediaType === "image";
  // Atlas states its own capacity per model; the other three split it by media
  // type across one registry entry. Grok's depends on more than the model: the
  // image quality (2.0 takes five), and the video mode and model (Lite takes
  // one, Edit and Extend none).
  const grokVideoOptions =
    !atlasModel && !isImage && videoCaps.kind === "grok"
      ? grokVideoOptionsFor(form, refCount)
      : null;
  const activeMaxReferences = atlasModel
    ? atlasMaxReferences(atlasModel)
    : isImage
      ? imageMaxReferences(imageCaps, form.quality)
      : (grokVideoOptions?.maxImages ?? videoCaps.maxReferences);
  // Grok video says it itself: Lite's one image is in the form's own issue
  // list, and Edit and Extend ignore attached images rather than refusing
  // them, where a "deselect" would ask for a step that changes nothing.
  const grokOwnsReferenceWarning = grokVideoOptions !== null;

  const quotes = useHiggsfieldQuotes(model, form, refCount);

  /**
   * Price of exactly what the button is about to submit.
   *
   * Every field the submission carries has to be here. Leaving the Higgsfield
   * video model and mode out priced every clip against the default model, so
   * Wan showed Seedance's number — three times the real one — while the charge
   * recorded on the row was correct.
   */
  const legacyPrice = priceForVariant(
    model,
    {
      mediaType: form.mediaType,
      aspectRatio: form.aspectRatio,
      duration: form.duration,
      resolution: form.resolution,
      videoTier: form.videoTier,
      videoJobType: form.videoJobType,
      videoMode: form.videoMode,
      generateAudio: form.generateAudio,
      sizeTier: form.imageSizeTier,
      count: form.count,
      videoCount: form.videoCount,
      // Grok's metered quota depends on the quality, mode, model and source.
      quality: form.quality,
      grok: grokVariantFor(form, refCount),
    },
    refCount,
    quotes,
  );

  /**
   * Atlas prices from its published per-second (video) or per-image rate, and
   * says so plainly when the settings do not determine one — a source-clip
   * length or an "auto" duration has no figure to show before the run.
   */
  // Images fan out too when the model has no batch parameter of its own — 82 of
  // the 109 do not, so "one image per tap" was the only reachable count.
  const atlasJobs = atlasModel ? atlasJobsFor(atlasModel, form) : 1;
  const currentPrice: Price | null = React.useMemo(() => {
    if (!atlasModel) return legacyPrice;
    const quote = quoteAtlas({
      model: atlasModel.id,
      params: activeAtlasParams(form),
      jobs: atlasJobs,
      referenceCount: refCount,
    });
    return quote.usd === null
      ? { currency: "unknown", reason: quote.reason ?? "" }
      : usdPrice(quote.usd);
  }, [atlasModel, form, atlasJobs, legacyPrice, refCount]);

  /**
   * Atlas submissions go through their own mutation.
   *
   * They share nothing with the other three beyond the prompt and the
   * references: there is no aspect ratio to resolve, no size tier and no video
   * tier, just the parameter bag the selected model declared. Trying to route
   * both through one call is what would have forced every existing validation
   * to become conditional.
   */
  const generateAtlas = React.useCallback(async () => {
    const current = formRef.current;
    const active = getAtlasModel(activeAtlasModelId(current));
    const rawPrompt = current.prompt.trim();

    const promptRequired = active.params.some((param) => param.name === "prompt" && param.required);
    if (promptRequired && !rawPrompt) {
      toast.error("Please enter a prompt");
      return;
    }

    const capacity = atlasMaxReferences(active);
    const selected = refImagesRef.current.filter((ref) => ref.selected).length;
    if (selected > capacity) {
      toast.error(
        capacity === 0
          ? `${active.label} does not accept reference images — deselect them`
          : `${active.label} takes up to ${capacity} reference${capacity === 1 ? "" : "s"} — deselect some`,
      );
      return;
    }

    const invalidReference = validateAtlasReferences(
      active,
      refImagesRef.current
        .filter((reference) => reference.selected)
        .map((reference) => ({
          width: reference.width,
          height: reference.height,
          aspect: reference.aspect,
          bytes: reference.blob.size,
        })),
    )[0];
    if (invalidReference) {
      toast.error(invalidReference.message);
      return;
    }

    const jobs = atlasJobsFor(active, current);
    setIsSubmitting(true);
    setSubmissionStatus(selected > 0 ? "Preparing reference uploads..." : "Creating Atlas job...");
    await toastOnFailure(async () => {
      const promptValue = atlasPromptValue(active, rawPrompt);
      buildAtlasRequest({
        model: active.id,
        params: {
          ...activeAtlasParams(current),
          ...(promptValue === undefined ? {} : { prompt: promptValue }),
        },
        referenceUrls: Array.from({ length: selected }, (_, index) => `pending://${index}`),
      });
      const references = await uploadReferences();
      setSubmissionStatus("Creating Atlas job...");
      await withServerTimeout(
        startAtlas({
          model: active.id,
          prompt: rawPrompt,
          params: activeAtlasParams(current),
          ...references,
          jobs,
        }),
      );
      setSpendEpoch((epoch) => epoch + 1);
      toast.success(
        jobs === 1
          ? `${active.media === "video" ? "Video" : "Image"} generation started`
          : `${jobs} generations started`,
      );
    }, "Failed to start generation");
    setIsSubmitting(false);
    setSubmissionStatus(null);
  }, [uploadReferences, startAtlas]);

  const handleGenerate = React.useCallback(async () => {
    const current = formRef.current;
    if (isSubmitting) return;
    if (current.provider === "atlas") {
      if (getAtlasModel(activeAtlasModelId(current)).retired) {
        toast.error("Atlas no longer lists this model. Choose an available model to generate.");
        return;
      }
      await generateAtlas();
      return;
    }

    const activeModel = getApiModel(current.model);
    const rawPrompt = current.prompt.trim();
    if (!rawPrompt) {
      toast.error("Please enter a prompt");
      return;
    }
    // The button is disabled in this state, but ⌘⏎ reaches here regardless and
    // would queue a Grok job that can only fail server-side.
    if (activeModel.provider === "grok" && connection?.connected === false) {
      toast.error("Connect your Grok account first, or pick a Seedream model");
      return;
    }

    // @imageN tags → ordinal references the model understands; validate that
    // every tag points at an attached & selected reference.
    const tagIndices = getGrokReferenceTagIndices(rawPrompt);
    const maxTag = tagIndices.length > 0 ? Math.max(...tagIndices) : 0;
    if (tagIndices.some((index) => index < 1)) {
      toast.error("Image tags start at @image1");
      return;
    }
    if (maxTag > refCount) {
      toast.error(
        `Prompt references @image${maxTag} but only ${refCount} reference${refCount === 1 ? " is" : "s are"} selected`,
      );
      return;
    }

    // Grok video's own rules — pins, keyframes, Lite's single image, the source
    // clip's length — from the same list the form shows and the mutation checks.
    const grokVideo =
      current.mediaType === "video" && activeModel.video.kind === "grok"
        ? grokVideoOptionsFor(current, refCount)
        : null;
    const grokIssue = grokVideo?.issues[0];
    if (grokIssue) {
      toast.error(grokIssue);
      return;
    }
    // Edit and Extend send no images, so attached ones are left out rather
    // than refused.
    const grokEditing = grokVideo !== null && grokVideo.plan.mode !== "generate";

    // Per selected video model: a frame model takes one media input per slot,
    // so the aggregate cap of 9 would let three references upload before the
    // mutation rejects them.
    const caps = current.mediaType === "image" ? activeModel.image : activeModel.video;
    const hfVideo =
      current.mediaType === "video" && activeModel.video.kind === "higgsfield-video"
        ? higgsfieldVideoModel(activeModel.video, current.videoJobType)
        : null;
    const maxRefs = hfVideo
      ? hfVideo.supportsReferences
        ? hfVideo.maxReferences
        : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
      : grokVideo
        ? grokVideo.maxImages
        : current.mediaType === "image"
          ? imageMaxReferences(activeModel.image, current.quality)
          : caps.maxReferences;
    if (refCount > maxRefs && !grokEditing) {
      const label = hfVideo?.label ?? activeModel.label;
      toast.error(
        maxRefs === 0
          ? `${label} does not accept reference images — deselect them`
          : `${label} supports up to ${maxRefs} selected reference${maxRefs === 1 ? "" : "s"} — deselect some`,
      );
      return;
    }

    setIsSubmitting(true);
    setSubmissionStatus(
      refCount > 0 && !grokEditing
        ? "Preparing reference uploads..."
        : "Creating generation job...",
    );
    await toastOnFailure(async () => {
      // A pinned first frame sets a Grok clip's shape, so the chosen ratio
      // is cut into the frames here; xAI ignores `aspect_ratio` beside one.
      const references = grokEditing
        ? {}
        : await uploadReferences(grokVideo ? grokFrameCropsFor(current, refCount) : []);
      setSubmissionStatus("Creating generation job...");
      if (current.mediaType === "image") {
        const job = startImage({
          model: current.model,
          prompt: rawPrompt,
          // fal is sent explicit pixels, so "auto" is settled here where the
          // reference dimensions are known. Grok resolves it server-side.
          aspectRatio:
            activeModel.provider === "fal"
              ? resolveImageRatio(
                  current.aspectRatio,
                  activeModel.image.aspectRatios,
                  selectedRefs[0]?.aspect,
                )
              : current.aspectRatio,
          count: current.count,
          quality: current.quality,
          resolution: current.imageSizeTier,
          ...references,
        });
        await withServerTimeout(job);
      } else {
        const seedance = activeModel.video.kind === "seedance";
        const higgsfieldVideo = activeModel.video.kind === "higgsfield-video";
        const source = grokEditing ? current.grokSourceVideo : null;
        // Only roles the person actually chose are sent: an all-automatic list
        // is what the server assumes anyway, and leaving it out keeps a plain
        // request byte-for-byte what a backend from before roles accepts.
        const frameRoles = current.grokFrameRoles
          .slice(0, refCount)
          .map((role) => parseGrokFrameRole(role));
        const sendRoles =
          grokVideo !== null &&
          !grokEditing &&
          grokVideo.frameRoleChoices !== null &&
          frameRoles.some((role) => role !== null);
        const job = startVideo({
          model: current.model,
          prompt: rawPrompt,
          duration: current.duration,
          // Edit and Extend follow the source, capped at 720p.
          resolution: source ? source.resolution : current.resolution,
          aspectRatio: grokVideo
            ? grokVideo.aspectRatios === null
              ? undefined
              : grokVideo.aspectRatios.includes(current.aspectRatio)
                ? current.aspectRatio
                : "16:9"
            : refCount === 1
              ? undefined
              : activeModel.video.aspectRatios.includes(current.aspectRatio)
                ? current.aspectRatio
                : "16:9",
          videoTier: seedance ? current.videoTier : undefined,
          videoJobType: higgsfieldVideo ? current.videoJobType : undefined,
          videoMode: higgsfieldVideo ? current.videoMode : undefined,
          generateAudio: seedance || higgsfieldVideo ? current.generateAudio : undefined,
          bitrateMode: seedance ? current.bitrateMode : undefined,
          count: current.videoCount,
          ...references,
          referenceVoices:
            grokVideo?.voices && current.videoVoices.length > 0 ? current.videoVoices : undefined,
          // Each new field only where it says something, for the same reason
          // as the roles: Generate on 1.5 is the request it always was.
          grokVideoMode:
            grokVideo && grokVideo.plan.mode !== "generate" ? grokVideo.plan.mode : undefined,
          grokVideoModel:
            grokVideo && !grokEditing && current.grokVideoModel !== GROK_VIDEO_MODEL_V15
              ? current.grokVideoModel
              : undefined,
          frameRoles: sendRoles ? frameRoles : undefined,
          sourceVideoKey: source?.key,
          sourceVideoSeconds: source?.seconds,
          extendDuration:
            grokVideo?.plan.mode === "extend" ? current.grokExtendDuration : undefined,
        });
        await withServerTimeout(job);
      }
      const started = current.mediaType === "image" ? current.count : current.videoCount;
      const noun = current.mediaType === "image" ? "image" : "video";
      toast.success(
        started === 1
          ? `${noun === "image" ? "Image" : "Video"} generation started`
          : `${started} ${noun} generations started`,
      );
    }, "Failed to start generation");
    setIsSubmitting(false);
    setSubmissionStatus(null);
  }, [
    isSubmitting,
    generateAtlas,
    uploadReferences,
    startImage,
    startVideo,
    refCount,
    selectedRefs,
    connection,
  ]);

  const handleDisconnect = React.useCallback(async () => {
    if (!window.confirm("Disconnect your Grok account?")) return;
    await toastOnFailure(async () => {
      await disconnect({});
      toast.success("Grok account disconnected");
    }, "Failed to disconnect");
  }, [disconnect]);

  React.useEffect(() => {
    // Not behind the Image → Prompt tool: the form is still in state there, and
    // Cmd+Enter in its instructions box would submit a paid generation unseen.
    if (!active || describing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handleGenerate();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, describing, handleGenerate]);

  // No confirmation: what these tiles hold is an error message, and the media
  // they never produced is not at risk, so a dialog guards against no loss worth
  // guarding against. The mutation keeps rows that were actually charged for —
  // deleting those would quietly shrink our own record of money already spent —
  // so the toast has to account for the tiles that stay put, or a deliberate
  // keep reads as a delete that silently failed.
  const handleRemoveAllFailed = React.useCallback(async () => {
    if (isRemovingFailed) return;

    const failedBefore = generations.filter((gen) => gen.status === "failed").length;
    setIsRemovingFailed(true);
    await toastOnFailure(async () => {
      const removed = await removeAllFailed({});
      // `failedBefore` counts the loaded page only, so this can undercount when
      // older failures are still unpaged — never overcount, which would name
      // kept rows that don't exist.
      const kept = Math.max(0, failedBefore - removed);
      toast.success(
        `Removed ${removed} failed generation${removed === 1 ? "" : "s"}` +
          (kept > 0 ? ` · kept ${kept} you were already charged for` : ""),
      );
    }, "Failed to remove generations");
    setIsRemovingFailed(false);
  }, [isRemovingFailed, removeAllFailed, generations]);

  /**
   * A finished row is media that has already been paid for and is deleted from
   * B2 along with it, so it asks first. A failed row produced nothing, which is
   * why its own tile button still removes it outright.
   *
   * An unfinished row asks too, and for a sharper reason: nothing here cancels
   * the job. The vendor keeps it, finishes it and bills for it — this only takes
   * the tile away, so the one thing that is actually lost is the result you are
   * paying for either way. Saying that plainly is the difference between a
   * dismissal and an accident.
   *
   * Resolves to whether the row is gone: the confirmation lives here, so a caller
   * that closes UI around the deletion — the lightbox — has no other way to tell
   * a cancelled prompt from a completed delete.
   */
  const handleRemoveGeneration = React.useCallback(
    async (gen: GenerationDoc): Promise<boolean> => {
      const question =
        gen.status === "completed"
          ? "Delete this generation? The media goes with it."
          : gen.status === "pending" || gen.status === "processing"
            ? "Remove this from the results? The job cannot be cancelled — it will still run and still be charged for, you just won't get the result."
            : null;
      if (question !== null && !window.confirm(question)) return false;
      const outcome = await toastOnFailure(async () => {
        await removeGeneration({ id: gen._id });
        toast.success("Generation deleted");
        return true;
      }, "Failed to delete generation");
      return outcome === true;
    },
    [removeGeneration],
  );

  /**
   * The results grid's multi-select delete. One question for the whole
   * selection, worded by what is in it: finished media goes with its rows, and
   * a job still running keeps running and billing — the same two warnings the
   * single-tile delete gives, said once.
   */
  const handleRemoveMany = React.useCallback(
    async (gens: GenerationDoc[]): Promise<boolean> => {
      if (gens.length === 0) return false;
      const running = gens.filter((gen) => gen.status === "pending" || gen.status === "processing");
      const noun = `${gens.length} generation${gens.length === 1 ? "" : "s"}`;
      const question =
        `Delete ${noun}? Finished media goes with them.` +
        (running.length > 0
          ? ` ${running.length} still running cannot be cancelled — they will still be charged for, you just won't get the results.`
          : "");
      if (!window.confirm(question)) return false;
      const outcome = await toastOnFailure(async () => {
        const removed = await removeInChunks(removeManyGenerations, gens);
        toast.success(`Deleted ${removed} generation${removed === 1 ? "" : "s"}`);
        return true;
      }, "Failed to delete generations");
      return outcome === true;
    },
    [removeManyGenerations],
  );

  const recreate = React.useCallback(
    async (gen: GenerationDoc) => {
      setIsRestoringReferences(true);
      const outcome = await toastOnFailure(async () => {
        const referenceB2Keys = gen.referenceB2Keys ?? [];
        const restored = await Promise.all(
          referenceB2Keys.map(async (key) =>
            prepareReferenceImage(await imageUrlToBlob(mediaUrl(key)), "fal"),
          ),
        );

        for (const ref of refImagesRef.current) URL.revokeObjectURL(ref.previewUrl);
        applyRefImages(() =>
          restored.map((prepared, index) => ({
            sourceUrl: mediaUrl(gen.referenceSourceKeys?.[index] ?? referenceB2Keys[index]),
            id: refId(),
            blob: prepared.blob,
            previewUrl: URL.createObjectURL(prepared.blob),
            aspect: prepared.aspect,
            width: prepared.width,
            height: prepared.height,
            selected: true,
          })),
        );

        const restoredModel = modelIdOf(gen);
        const isAtlas = gen.provider === "atlas" && !!gen.apiModel && isAtlasModelId(gen.apiModel);
        /**
         * Reproducing a row has to restore the provider, not only the settings.
         *
         * For the three registry providers that is `withRegistryModel`, which
         * moves `provider` with `model` — without it, reproducing a fal clip
         * while sitting on Atlas restored every setting and then generated an
         * Atlas job off the same button.
         *
         * Atlas needs its own branch because its models are vendor slugs, not
         * registry ids: `modelIdOf` cannot name one and falls back to "grok",
         * so the generic path restored an Atlas row as Grok and left the Atlas
         * model on whatever the form happened to hold.
         */
        const base = isAtlas
          ? // Provider, media type, model slot and the bag that media type owns,
            // plus the image count where the model batches (see withAtlasRow).
            withAtlasRow(formRef.current, getAtlasModel(gen.apiModel!), gen.atlasParams ?? {})
          : withRegistryModel(formRef.current, restoredModel);
        // Grok video rows carry their mode, model, roles and source clip. A row
        // from before those existed has none, and means Generate on 1.5 with
        // the automatic roles — exactly what absent fields restore to.
        const grokVideoRow = gen.mediaType === "video" && (gen.provider ?? "grok") === "grok";
        const grokMode =
          grokVideoRow && isGrokVideoMode(gen.grokVideoMode) ? gen.grokVideoMode : "generate";
        const editingRow = grokVideoRow && grokMode !== "generate";
        const sourceKey = editingRow ? gen.sourceVideoKey : undefined;
        const sourceSeconds = sourceKey
          ? (gen.sourceVideoSeconds ??
            (await probeVideo(videoUrl(sourceKey)).catch(() => null))?.seconds)
          : undefined;
        const next: ApiFormState = {
          ...base,
          // Left alone under Atlas: `model` is the dormant registry entry there,
          // and "grok" is what modelIdOf returns for a slug it cannot parse.
          model: isAtlas ? base.model : restoredModel,
          // Reproducing one tile means one clip. Carrying a 4 over from the
          // form would arm the next click for four charges off a button the
          // user pressed to repeat a single result.
          videoCount: 1,
          mediaType: gen.mediaType as MediaType,
          prompt: restoreGrokReferenceTags(gen.prompt, referenceB2Keys.length),
          aspectRatio: gen.aspectRatio ?? (gen.mediaType === "video" ? "16:9" : "auto"),
          count: gen.count ?? base.count,
          quality: isGrokImageQuality(gen.quality) ? gen.quality : formRef.current.quality,
          // On a Grok video row an absent list means none were chosen, and
          // falling back to the form's own voices would reproduce a different
          // clip. Rows from providers without voices say nothing about them,
          // so the current selection survives those. Absent provider ⇒ Grok,
          // as everywhere on this table.
          videoVoices:
            gen.mediaType === "video" && (gen.provider ?? "grok") === "grok"
              ? (gen.referenceVoices ?? [])
              : formRef.current.videoVoices,
          imageSizeTier:
            gen.mediaType === "image"
              ? (gen.resolution ?? formRef.current.imageSizeTier)
              : formRef.current.imageSizeTier,
          // An edit's resolution is its source's and an extension's duration
          // is the added length — neither is Generate's setting.
          duration:
            gen.mediaType === "video" && !editingRow
              ? (gen.duration ?? formRef.current.duration)
              : formRef.current.duration,
          resolution:
            gen.mediaType === "video" && !editingRow
              ? (gen.resolution ?? formRef.current.resolution)
              : formRef.current.resolution,
          grokVideoMode: grokVideoRow ? grokMode : formRef.current.grokVideoMode,
          grokVideoModel:
            grokVideoRow && !editingRow
              ? isGrokVideoModelId(gen.grokVideoModel)
                ? gen.grokVideoModel
                : GROK_VIDEO_MODEL_V15
              : formRef.current.grokVideoModel,
          // The references are replaced wholesale, so roles kept from the old
          // set would describe pictures that are gone.
          grokFrameRoles: grokVideoRow && !editingRow ? (gen.grokFrameRoles ?? []) : [],
          // The restored references are the bytes that were sent, already
          // cropped, so cutting them again could only change the clip.
          grokFrameAspectRatio: grokVideoRow ? "auto" : formRef.current.grokFrameAspectRatio,
          grokExtendDuration:
            grokMode === "extend"
              ? (gen.duration ?? formRef.current.grokExtendDuration)
              : formRef.current.grokExtendDuration,
          grokSourceVideo:
            sourceKey && sourceSeconds !== undefined
              ? {
                  key: sourceKey,
                  seconds: sourceSeconds,
                  resolution: gen.resolution === "480p" ? "480p" : "720p",
                }
              : formRef.current.grokSourceVideo,
          videoTier: (gen.videoTier as ApiFormState["videoTier"]) ?? formRef.current.videoTier,
          // Which Higgsfield video model, and its speed/quality mode. Without
          // these the clip comes back as whatever the form happened to hold —
          // a Wan record reproduced as Seedance, at a different price.
          videoJobType:
            gen.mediaType === "video"
              ? ((gen.videoJobType as ApiFormState["videoJobType"]) ?? formRef.current.videoJobType)
              : formRef.current.videoJobType,
          videoMode:
            gen.mediaType === "video"
              ? ((gen.videoMode as ApiFormState["videoMode"]) ?? formRef.current.videoMode)
              : formRef.current.videoMode,
          generateAudio: gen.generateAudio ?? formRef.current.generateAudio,
          // The backend stores nothing for the standard bitrate, so on a fal
          // clip an absent value means "standard" — not "unknown". Falling back
          // to the current form there would reproduce the wrong setting.
          bitrateMode:
            gen.provider === "fal" && gen.mediaType === "video"
              ? gen.bitrateMode === "high"
                ? "high"
                : "standard"
              : formRef.current.bitrateMode,
        };
        applyForm(normalizeForm(next, referenceB2Keys.length).form);
        // Only for a registry model. Under Atlas this writes `?model=grok` into
        // the URL — a model that is not the one running, and one the next visit
        // would restore.
        if (!isAtlas) onModelChange?.(restoredModel);

        if (gen.hasReferenceImage && referenceB2Keys.length === 0) {
          toast.warning(
            "Settings restored, but references are unavailable for this older generation",
          );
        } else if (referenceB2Keys.length > 0) {
          toast.success(
            `Settings and ${referenceB2Keys.length} reference image${referenceB2Keys.length === 1 ? "" : "s"} restored`,
          );
        } else {
          toast.success("Settings restored");
        }
        return true;
      }, "Failed to restore generation settings");
      setIsRestoringReferences(false);
      // `undefined` is the failure case toastOnFailure resolves to.
      return outcome === true;
    },
    [onModelChange, applyForm, applyRefImages],
  );

  // Reproduce from the gallery: the row is fetched fresh rather than carried
  // through sessionStorage, so what is restored is what the record actually says.
  const reproduceDoc = useQuery(
    api.grokGenerations.get,
    active && reproduceId ? { id: reproduceId } : "skip",
  );
  const handledReproduce = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!active || !reproduceId || reproduceDoc === undefined) return;
    if (handledReproduce.current === reproduceId) return;
    handledReproduce.current = reproduceId;
    if (!reproduceDoc) {
      onReproduceHandled?.();
      toast.error("That generation is no longer available");
      return;
    }
    // Favourites, gallery and search all send hosted rows here; a self-hosted
    // clip belongs to the video tab's composer, not this one.
    if (isSelfHostedVideo(reproduceDoc)) {
      router.replace(videoReproduceHref(reproduceDoc._id));
      return;
    }
    // The restored settings are for the generator, not the tool in front of it.
    setDescribing(false);
    // The param is dropped only once the settings are in: restoring fetches the
    // reference images, and if that fails the link should still be reloadable.
    void recreate(reproduceDoc).then((restored) => {
      if (restored) onReproduceHandled?.();
    });
  }, [active, reproduceId, reproduceDoc, recreate, onReproduceHandled, setDescribing, router]);

  // A Seedance 2.5 draft finished at 1080p: one Atlas job on the completion
  // endpoint, which re-renders from the draft itself — nothing in the form is
  // read or changed.
  const completeDraft = (gen: GenerationDoc) => {
    const request = atlasDraftCompletion(gen, Date.now());
    if (!request) {
      toast.error("This draft can no longer be finished — Atlas keeps drafts for seven days.");
      return;
    }
    void toastOnFailure(async () => {
      await withServerTimeout(startAtlas(request));
      setSpendEpoch((epoch) => epoch + 1);
      toast.success("Rendering the draft at 1080p");
    }, "Failed to finish the draft");
  };

  // A self-hosted clip in this grid reproduces in the video tab's composer.
  const recreateOrOpen = (gen: GenerationDoc) => {
    if (isSelfHostedVideo(gen)) router.push(videoReproduceHref(gen._id));
    else void recreate(gen);
  };

  const needsGrokConnection = form.provider === "grok" && connection?.connected === false;
  // Only Grok needs the connection known before it can submit.
  const grokConnectionPending = form.provider === "grok" && connection === undefined;

  const generateButton = (
    <Button
      size="lg"
      className="w-full text-lg font-semibold h-12"
      onClick={() => void handleGenerate()}
      disabled={
        isSubmitting ||
        isRestoringReferences ||
        needsGrokConnection ||
        grokConnectionPending ||
        referenceIssues.length > 0 ||
        Boolean(atlasModel?.retired)
      }
    >
      {isSubmitting || isRestoringReferences ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          {isRestoringReferences ? "Restoring..." : (submissionStatus ?? "Starting...")}
        </>
      ) : (
        <>
          {isImage ? "Generate Image" : "Generate Video"}
          <span className="ml-2 font-normal opacity-80">·</span>
          <PriceTag price={currentPrice} className="ml-1 text-sm text-current opacity-80" />
        </>
      )}
    </Button>
  );

  // Built here, outside the return, on purpose. Inside it the React Compiler
  // folds this element into the one memo block that the whole layout shares,
  // and that block depends on `form` — so every keystroke in the prompt made a
  // new <ApiResults> and re-rendered every tile on the page. As its own
  // variable it gets its own block, keyed only on what the grid reads.
  const resultsGrid = (
    <ApiResults
      active={active && !studioOpen}
      generations={generations}
      canLoadMore={generationsStatus === "CanLoadMore"}
      isLoadingMore={generationsStatus === "LoadingMore"}
      onLoadMore={(numItems) => latestLoadMore.current(numItems)}
      onRecreate={recreateOrOpen}
      onCompleteDraft={completeDraft}
      onRemove={handleRemoveGeneration}
      onRemoveMany={handleRemoveMany}
      onUseAsReference={(url, asVideo) => void addReferenceFromUrl(url, asVideo)}
      onSendToVideo={onSendToVideo}
      onUseAsSourceVideo={(key, mode) => void setSourceFromResult(key, mode)}
      onRemoveAllFailed={() => void handleRemoveAllFailed()}
      isRemovingFailed={isRemovingFailed}
    />
  );

  const switcherRow = (
    <div className="border-b px-3 py-2 lg:px-4">
      <ModelSwitcher
        form={form}
        tabs={tabs}
        onSelectProvider={(next) => {
          setDescribing(false);
          changeProvider(next);
        }}
        describeActive={describing}
        onSelectDescribe={() => setDescribing(true)}
        hiddenProviders={hiddenProviders}
        onSelectModel={changeModel}
        onSelectAtlasModel={changeAtlasModel}
        onSelectMediaType={(media) => updateField("mediaType", media)}
        // Not disabled while submitting: a submission reads the form once, when
        // it starts, so changing model mid-upload cannot reach it — and an upload
        // stuck on a dead connection used to lock every control on the panel.
        accessory={
          describing ? null : form.provider === "higgsfield" ? (
            <CreditsBadge />
          ) : form.provider === "atlas" ? (
            <AtlasBalanceBadge refreshKey={spendEpoch} />
          ) : null
        }
      />
    </div>
  );

  // Mounted, and only hidden, while a provider is showing: its results live in
  // its own state, and switching to Grok and back should not throw them away.
  // The switcher goes in only while it is visible — two live copies would each
  // fetch the Atlas balance.
  const describePanel = (
    <div hidden={!describing}>
      {describeMounted && <ImageToPromptPanel header={describing ? switcherRow : null} />}
    </div>
  );

  // Every return below keeps the panel as the first of two children, so React
  // sees the same element in the same slot and keeps its state.
  if (describing) {
    return (
      <>
        {describePanel}
        {null}
      </>
    );
  }

  // No gate on the Grok auth query: the form and the results render while it
  // loads, and only a Grok form waits for it (`grokConnectionPending`).
  return (
    <>
      {describePanel}
      <div className="flex flex-col lg:h-[calc(100vh-3.5rem)] lg:min-h-0">
        {needsGrokConnection ? (
          <>
            {switcherRow}
            <div className="py-6 px-4 lg:px-6">
              <div className="max-w-md mx-auto" key={connectionEpoch}>
                <GrokConnect onConnected={() => setConnectionEpoch((epoch) => epoch + 1)} />
                <p className="mt-4 text-center text-sm text-muted-foreground">
                  Or pick another provider above — none of them needs you to sign in here.
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            <GenerateSplit storageKey="generate-split-api" className="lg:flex-1">
              <div className="min-w-0 lg:flex lg:flex-col lg:h-full">
                {switcherRow}
                <div className="flex-1 overflow-y-auto px-3 py-3 pb-24 lg:px-4 lg:pb-4">
                  <div className="max-w-3xl mx-auto lg:max-w-none space-y-3">
                    {form.provider === "grok" && connection?.connected && (
                      <div className="flex items-center justify-between gap-2 border rounded-lg p-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {connection?.email ?? "Grok account"}
                          </p>
                          <p className="text-xs text-muted-foreground">Connected via SuperGrok</p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => void handleDisconnect()}>
                          Disconnect
                        </Button>
                      </div>
                    )}

                    <ApiForm
                      model={model}
                      atlas={
                        atlasModel
                          ? {
                              model: atlasModel,
                              params: activeAtlasParams(form),
                              onParamChange: changeAtlasParam,
                              jobs: atlasJobs,
                            }
                          : undefined
                      }
                      form={form}
                      updateField={updateField}
                      refImages={refImages}
                      selectedRefs={selectedRefs}
                      referenceIssues={referenceIssues}
                      maxReferences={maxReferences}
                      onPreviewRef={setPreviewRef}
                      onToggleRef={toggleRefSelected}
                      onRemoveRef={removeRef}
                      onPickFiles={(files) => void handleRefFiles(files)}
                      onOpenGallery={() => setPickerOpen(true)}
                      quotes={quotes}
                      onPickSourceVideo={(file) => void pickSourceVideo(file)}
                      sourceVideoBusy={sourceVideoBusy}
                      studio={{ open: studioOpen, host: studioHost, onOpenChange: setStudioOpen }}
                    />

                    {refCount > activeMaxReferences && !grokOwnsReferenceWarning && (
                      <p className="text-xs text-destructive">
                        {atlasModel?.label ?? model.label} accepts {activeMaxReferences} references
                        for {isImage ? "images" : "video"} — deselect{" "}
                        {refCount - activeMaxReferences}.
                      </p>
                    )}
                  </div>
                </div>

                <div className="hidden lg:block border-t bg-background px-3 py-2 lg:px-4">
                  {generateButton}
                </div>
              </div>

              {/* A stable gutter: a scrollbar appearing narrows the masonry, which
                  can shorten it enough to drop the scrollbar again — and round. */}
              <div className="min-w-0 lg:h-full pb-24 lg:pb-0">
                {/* Hidden, not unmounted, under the studio: the grid keeps its
                    pages and scroll position for when the studio closes. */}
                <div
                  hidden={studioOpen}
                  className="px-3 py-3 lg:h-full lg:overflow-y-auto lg:[scrollbar-gutter:stable] lg:px-4"
                >
                  {resultsGrid}
                </div>
                <div ref={setStudioHost} hidden={!studioOpen} className="lg:h-full" />
              </div>
            </GenerateSplit>

            <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-background/80 backdrop-blur-md border-t z-40">
              <div className="max-w-3xl mx-auto">{generateButton}</div>
            </div>
          </>
        )}

        {previewRef && (
          <ReferencePreview
            key={previewRef.id}
            reference={previewRef}
            onClose={() => setPreviewRef(null)}
            onRecreate={recreateOrOpen}
            onRemove={handleRemoveGeneration}
            onUseAsReference={(url, asVideo) => void addReferenceFromUrl(url, asVideo)}
          />
        )}

        {pickerOpen && (
          <ReferencePicker
            onClose={() => setPickerOpen(false)}
            onPick={(url) => {
              setPickerOpen(false);
              void addReferenceFromUrl(url);
            }}
          />
        )}
      </div>
    </>
  );
}
