import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { createMMKV } from "react-native-mmkv";

import { api } from "@/convex/_generated/api";
import {
  getApiModel,
  higgsfieldVideoModel,
  isApiModelId,
  isGrokImageQuality,
  type ApiModelId,
} from "@/lib/api-models";
import {
  atlasFamilyMaxReferences,
  atlasMaxReferences,
  atlasPromptParam,
  getAtlasModel,
  isAtlasModelId,
} from "@/lib/atlas-models";
import { validateAtlasReferences } from "@/lib/atlas-reference-validation";
import { hasAtlasPrice, quoteAtlas } from "@/lib/atlas-price";
import { getGrokReferenceTagIndices, restoreGrokReferenceTags } from "@/lib/grok-prompt";
import { mediaUrl } from "@/lib/media-url";
import { referenceProfileFor } from "@/lib/reference-profile";
import { referenceDimensions } from "@/lib/reference-dimensions";
import { priceForVariant, variantFor, variantSignature, variantsToQuote } from "@/lib/api-price";
import { formatPrice, usdPrice, type Price } from "@/lib/api-pricing";
import {
  activeAtlasModelId,
  activeAtlasParams,
  atlasJobsFor,
  DEFAULT_API_FORM,
  normalizeForm,
  withActiveAtlasParams,
  migrateStoredForm,
  withAtlasRow,
  withRegistryModel,
  type ApiFormState,
} from "@/lib/normalize-form";

import { uploadReference } from "./upload-reference";
import { loadReferences, retainReference, type Reference } from "./reference-files";
export type { Reference } from "./reference-files";

const store = createMMKV({ id: "artsnack.composer" });
const FORM_KEY = "api-form";
const REFERENCES_KEY = "references";
const selectedReferences = (references: Reference[]) =>
  references.filter((reference) => reference.selected !== false);

/**
 * The row fields a faithful restore reads. Structural rather than the Convex
 * `Doc` so the composer stays decoupled from the schema module — the query
 * result satisfies it as-is.
 */
export type ReproduceSource = {
  prompt: string;
  mediaType: "image" | "video";
  provider?: string;
  apiModel?: string;
  atlasParams?: Record<string, string | number | boolean | string[]>;
  aspectRatio?: string;
  count?: number;
  quality?: string;
  duration?: number;
  resolution?: string;
  videoTier?: string;
  videoJobType?: string;
  videoMode?: string;
  generateAudio?: boolean;
  bitrateMode?: string;
  hasReferenceImage?: boolean;
  referenceB2Keys?: string[];
  referenceVoices?: string[];
};

function loadForm(): ApiFormState {
  // The web app persists the same state under its own key, and for the same
  // reason: a prompt is expensive to retype and cheap to keep.
  const raw = store.getString(FORM_KEY);
  if (!raw) return DEFAULT_API_FORM;
  try {
    // Normalized at load, exactly like the web's parseForm: the stored blob can
    // predate a field or carry a shape no current writer produces, and the
    // guards for that live in normalizeForm, not here.
    return normalizeForm(
      { ...DEFAULT_API_FORM, ...migrateStoredForm(JSON.parse(raw) as Partial<ApiFormState>) },
      selectedReferences(loadReferences(store.getString(REFERENCES_KEY))).length,
    ).form;
  } catch {
    return DEFAULT_API_FORM;
  }
}

/**
 * The API composer's state, clamped the same way the web app clamps it.
 *
 * Every write goes through `normalizeForm`, which is shared code: switching
 * model, media type or reference count can strand a setting the new target does
 * not accept, and it moves each one to the nearest legal value and says what
 * moved. Doing that here rather than in the UI is what keeps the phone and the
 * browser from disagreeing about what a form means.
 */
export function useComposer() {
  const [form, setFormState] = useState<ApiFormState>(loadForm);
  const [references, setReferencesState] = useState<Reference[]>(() =>
    loadReferences(store.getString(REFERENCES_KEY)),
  );
  const selected = useMemo(() => selectedReferences(references), [references]);
  const [adjustments, setAdjustments] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const model = useMemo(
    () =>
      getApiModel(isApiModelId(form.model) ? (form.model as ApiModelId) : DEFAULT_API_FORM.model),
    [form.model],
  );

  /**
   * Mirror of `form`, written through the setter below rather than during render.
   *
   * `setForm` used to normalise inside the `setFormState` updater and, from in
   * there, write MMKV and call `setAdjustments`. An updater has to be pure: React
   * may invoke it more than once for a single update, which made both a duplicate
   * disk write and a nested state update, and a side effect in an updater is also
   * one of the things that makes the React Compiler abandon the component. The web
   * composer keeps the same mirror for the same reason.
   */
  const formRef = useRef(form);

  /**
   * The reference mirror, written through this setter and never in the render body.
   * Assigning a ref during render is the other half of the same rule, and the web
   * composer carries a comment saying exactly that.
   */
  const referencesRef = useRef(references);
  const applyReferences = useCallback((next: Reference[]) => {
    referencesRef.current = next;
    store.set(REFERENCES_KEY, JSON.stringify(next));
    setReferencesState(next);
  }, []);

  const setForm = useCallback(
    (
      patch: Partial<ApiFormState>,
      referenceCount = selectedReferences(referencesRef.current).length,
    ) => {
      const result = normalizeForm({ ...formRef.current, ...patch }, referenceCount);
      formRef.current = result.form;
      store.set(FORM_KEY, JSON.stringify(result.form));
      setFormState(result.form);
      setAdjustments(result.adjustments);
    },
    [],
  );

  // Attaching or removing a reference can make the current settings illegal —
  // Grok's 1080p is the live example — so the same normalizer runs on it.
  const setReferencesChecked = useCallback(
    (update: Reference[] | ((current: Reference[]) => Reference[])) => {
      const next = typeof update === "function" ? update(referencesRef.current) : update;
      applyReferences(next);
      setForm({}, selectedReferences(next).length);
    },
    [applyReferences, setForm],
  );

  /**
   * The Atlas model driving the form, or null for the other three.
   *
   * One per media type, because Atlas has no model that does both: picking
   * "video" genuinely changes which model runs rather than flipping a switch
   * inside one. `model` above stays on whichever registry model was last chosen
   * and is dormant while this is set.
   */
  const atlasModel = useMemo(
    () => (form.provider === "atlas" ? getAtlasModel(activeAtlasModelId(form)) : null),
    [form],
  );
  const referenceIssues = useMemo(() => {
    if (!atlasModel) return [];
    const metadata = selected.map((reference) =>
      reference.width && reference.height
        ? {
            ...referenceDimensions(reference.width, reference.height, "fal"),
            aspect: reference.width / reference.height,
          }
        : reference,
    );
    return validateAtlasReferences(atlasModel, metadata).map((issue) => ({
      ...issue,
      referenceIndex: references.indexOf(selected[issue.referenceIndex]),
    }));
  }, [atlasModel, references, selected]);

  /** How many separate submissions one tap makes, and therefore charges for. */
  const jobs = atlasModel ? atlasJobsFor(atlasModel, form) : 1;

  const quotes = useHiggsfieldQuotes(model, form, selected.length);

  const price: Price | null = useMemo(() => {
    if (atlasModel) {
      const quote = quoteAtlas({
        model: atlasModel.id,
        params: activeAtlasParams(form),
        jobs: atlasJobsFor(atlasModel, form),
      });
      // Atlas says plainly when the settings do not determine a price — an auto
      // length, or a duration taken from a source clip.
      return hasAtlasPrice(quote)
        ? usdPrice(quote.usd)
        : { currency: "unknown", reason: quote.reason ?? "" };
    }
    return priceForVariant(model, variantFor(form, {}, selected.length), selected.length, quotes);
  }, [atlasModel, model, form, selected.length, quotes]);

  /** Sets one Atlas parameter on the bag belonging to the active media type. */
  const setAtlasParam = useCallback(
    (name: string, value: string | number | boolean | string[]) => {
      const current = formRef.current;
      setForm(withActiveAtlasParams(current, { ...activeAtlasParams(current), [name]: value }));
    },
    [setForm],
  );

  const savePromptMutation = useMutation(api.savedPrompts.save);

  /**
   * File whatever is typed. The title is derived rather than asked for: a
   * dialogue would stop this being one press, and `by_user_hash` already makes
   * saving the same wording twice a point lookup that reports instead of
   * duplicating.
   */
  const savePrompt = useCallback(async () => {
    const text = form.prompt.trim();
    if (text.length === 0) return;
    await savePromptMutation({ text });
  }, [form.prompt, savePromptMutation]);

  const generateUploadUrl = useMutation(api.grokGenerations.generateRefUploadUrl);

  /**
   * "Use as reference" from the viewer.
   *
   * A generated image on the CDN and a photo from the library are the same thing
   * by the time they reach `uploadReference`, so this is the picker's path with
   * a different starting URI — no second code path to keep in step.
   */
  /**
   * Append one already-uploaded reference, read from the mirror rather than from a
   * captured array.
   *
   * The composer's focus effect picks up a reference handed over from the viewer and
   * has an empty dependency list — it must, or it would re-consume the handoff every
   * time anything changed. Building the next array from `composer.references` there
   * therefore appended to whatever the list was on the *first* render, so a second
   * "Use as reference" replaced the first one instead of joining it. Composed outside
   * an updater for the same reason as `setForm`: an updater may not call another
   * setter.
   */
  const addReference = useCallback(
    (reference: Reference) => {
      const next = [...referencesRef.current, reference];
      applyReferences(next);
      setForm({}, selectedReferences(next).length);
    },
    [applyReferences, setForm],
  );

  const attachReference = useCallback(
    async (uri: string) => {
      // Keyed on the provider the form is actually on. `model` is whichever
      // registry model was last chosen and stays put while Atlas drives the
      // form, so reading its provider would squeeze Atlas references into
      // Grok's 768px box for anyone who had been on Grok beforehand.
      addReference(await retainReference(uri));
    },
    [addReference],
  );

  /**
   * Reproduce: restore a finished generation faithfully — provider and model
   * included, references re-attached — mirroring the web composer.
   *
   * This used to restore only the scalar settings and leave the model alone,
   * which meant an Atlas row re-ran as a Grok/fal job with the Atlas parameter
   * bag untouched, an edit reproduced as text-to-image, and a ×4 fan-out left
   * armed on the form charged four times for a button pressed to repeat one
   * result. The web treats the gesture as a faithful restore; now both do.
   */
  const reproduce = useCallback(
    async (source: ReproduceSource) => {
      // Self-hosted H3 clips run on the video pod, which only the web tab drives;
      // restored here they would silently re-run as a Grok job.
      if (source.provider === "comfy") {
        Alert.alert(
          "Not on iOS yet",
          "Self-hosted video clips can be reproduced on the web: Generate → Self-hosted video.",
        );
        return;
      }
      const keys = source.referenceB2Keys ?? [];
      const isAtlas =
        source.provider === "atlas" && !!source.apiModel && isAtlasModelId(source.apiModel);
      const restoredModel: ApiModelId =
        source.apiModel && isApiModelId(source.apiModel) ? (source.apiModel as ApiModelId) : "grok";

      // References first, so the form below normalizes against the real count.
      // Re-uploaded from the CDN exactly like "Use as reference" — same path,
      // same per-provider size box. A failure aborts the whole restore, as on
      // web: applying the form anyway would leave `@image2` in the prompt with
      // nothing attached.
      let restored: Reference[] = [];
      try {
        restored = await Promise.all(keys.map((key) => retainReference(mediaUrl(key))));
      } catch (cause) {
        Alert.alert(
          "Not restored",
          cause instanceof Error
            ? `${cause.message} — the settings were left as they were.`
            : "Could not re-attach the reference images, so the settings were left as they were.",
        );
        return;
      }
      applyReferences(restored);

      const current = formRef.current;
      // Atlas models are vendor slugs, not registry ids, so they need their own
      // branch: withAtlasRow moves provider, media type and the model slot,
      // puts the parameter bag into whichever bag that media type owns, and
      // turns a batching model's batch size into the image count. The registry
      // path moves provider with model the same way.
      const base = isAtlas
        ? withAtlasRow(current, getAtlasModel(source.apiModel!), source.atlasParams ?? {})
        : withRegistryModel(current, restoredModel);
      const next: ApiFormState = {
        ...base,
        model: isAtlas ? base.model : restoredModel,
        // Reproducing one tile means one clip; carrying a 4 over would arm the
        // next tap for four charges.
        videoCount: 1,
        mediaType: source.mediaType,
        prompt: restoreGrokReferenceTags(source.prompt, keys.length),
        aspectRatio: source.aspectRatio ?? (source.mediaType === "video" ? "16:9" : "auto"),
        count: source.count ?? base.count,
        quality: isGrokImageQuality(source.quality) ? source.quality : current.quality,
        // On a Grok video row an absent list means none were chosen, and
        // falling back to the form's own voices would reproduce a different
        // clip. Rows from providers without voices say nothing about them, so
        // the current selection survives those. Absent provider ⇒ Grok, as
        // everywhere on this table.
        videoVoices:
          source.mediaType === "video" && (source.provider ?? "grok") === "grok"
            ? (source.referenceVoices ?? [])
            : current.videoVoices,
        imageSizeTier:
          source.mediaType === "image"
            ? (source.resolution ?? current.imageSizeTier)
            : current.imageSizeTier,
        duration:
          source.mediaType === "video" ? (source.duration ?? current.duration) : current.duration,
        resolution:
          source.mediaType === "video"
            ? (source.resolution ?? current.resolution)
            : current.resolution,
        videoTier: (source.videoTier as ApiFormState["videoTier"]) ?? current.videoTier,
        videoJobType:
          source.mediaType === "video"
            ? ((source.videoJobType as ApiFormState["videoJobType"]) ?? current.videoJobType)
            : current.videoJobType,
        videoMode:
          source.mediaType === "video"
            ? ((source.videoMode as ApiFormState["videoMode"]) ?? current.videoMode)
            : current.videoMode,
        generateAudio: source.generateAudio ?? current.generateAudio,
        // The backend stores nothing for the standard bitrate, so on a fal clip
        // an absent value means "standard" — not "unknown".
        bitrateMode:
          source.provider === "fal" && source.mediaType === "video"
            ? source.bitrateMode === "high"
              ? "high"
              : "standard"
            : current.bitrateMode,
      };
      setForm(next, restored.length);

      if (source.hasReferenceImage && keys.length === 0) {
        Alert.alert(
          "Settings restored",
          "The reference images are unavailable for this older generation.",
        );
      }
    },
    [applyReferences, setForm],
  );

  const startImage = useMutation(api.grokGenerations.startImage);
  const startVideo = useMutation(api.grokGenerations.startVideo);
  const startAtlas = useMutation(api.atlas.start);

  // Only consulted at submit, and only for Grok — connecting happens on the
  // web (an OAuth device grant), but the account is shared, so a phone signed
  // into a connected account passes.
  const grokConnection = useQuery(
    api.grokAuth.getConnection,
    form.provider === "grok" ? {} : "skip",
  );

  /**
   * Everything the web form refuses before spending, refused here too — a
   * vendor-side failure costs money on Atlas and reads as a broken app
   * everywhere. Returns the reason, or null when the submission is sound.
   */
  const preflightError = useCallback((): string | null => {
    const current = formRef.current;
    const refCount = selectedReferences(referencesRef.current).length;

    if (atlasModel) {
      const capacity = atlasMaxReferences(atlasModel);
      if (refCount > capacity) {
        return capacity === 0
          ? `${atlasModel.label} does not accept reference images — remove them.`
          : `${atlasModel.label} takes up to ${capacity} reference${capacity === 1 ? "" : "s"} — remove some.`;
      }
      const invalidReference = referenceIssues[0];
      if (invalidReference) return invalidReference.message;
      return null;
    }

    const activeModel = getApiModel(
      isApiModelId(current.model) ? (current.model as ApiModelId) : DEFAULT_API_FORM.model,
    );
    if (activeModel.provider === "grok" && grokConnection?.connected === false) {
      return "Connect your Grok account in Tools → Connected accounts, or pick another model.";
    }

    // Every @imageN tag must point at an attached reference; the providers
    // reject or silently ignore a dangling one.
    const tagIndices = getGrokReferenceTagIndices(current.prompt);
    const maxTag = tagIndices.length > 0 ? Math.max(...tagIndices) : 0;
    if (tagIndices.some((index) => index < 1)) return "Image tags start at @image1.";
    if (maxTag > refCount) {
      return `The prompt references @image${maxTag} but only ${refCount} reference${refCount === 1 ? " is" : "s are"} attached.`;
    }

    // Per selected video model, not the aggregate: a frame model takes one
    // media input per slot, and the aggregate cap would let extra references
    // upload before the mutation rejects them.
    const caps = current.mediaType === "image" ? activeModel.image : activeModel.video;
    const hfVideo =
      current.mediaType === "video" && activeModel.video.kind === "higgsfield-video"
        ? higgsfieldVideoModel(activeModel.video, current.videoJobType)
        : null;
    const maxRefs = hfVideo
      ? hfVideo.supportsReferences
        ? hfVideo.maxReferences
        : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
      : caps.maxReferences;
    if (refCount > maxRefs) {
      const label = hfVideo?.label ?? activeModel.label;
      return maxRefs === 0
        ? `${label} does not accept reference images — remove them.`
        : `${label} takes up to ${maxRefs} reference${maxRefs === 1 ? "" : "s"} — remove some.`;
    }
    return null;
  }, [atlasModel, grokConnection, referenceIssues]);

  /** Resolves to whether a job was actually started, so the caller can navigate. */
  const submit = useCallback(async (): Promise<boolean> => {
    // A handful of Atlas edit models take no prompt at all, so the guard is per
    // model rather than universal.
    const needsPrompt = atlasModel ? atlasPromptParam(atlasModel)?.required !== false : true;
    if (submittingRef.current || (needsPrompt && form.prompt.trim().length === 0)) return false;
    const refusal = preflightError();
    if (refusal) {
      Alert.alert("Not sent", refusal);
      return false;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      // Belt and braces after the upload's own check: an argument object with an
      // `undefined` in it fails the whole mutation with a type error that names
      // Convex rather than the attachment that caused it.
      // Every submission gets its own uploads: the backend deletes these when
      // that batch finishes. The original draft files stay on the phone.
      const uploaded = await Promise.all(
        selected.map((reference) =>
          uploadReference(reference.uri, referenceProfileFor(form.provider), generateUploadUrl),
        ),
      );
      const storageIds = uploaded.map((reference) => reference.storageId);
      if (atlasModel) {
        const invalid = validateAtlasReferences(atlasModel, uploaded)[0];
        if (invalid) throw new Error(invalid.message);
      }
      if (atlasModel) {
        // Its own mutation, for the same reason the web app has one: Atlas
        // models declare their own parameters, so none of the fixed arguments
        // startImage and startVideo validate apply to them.
        await startAtlas({
          model: atlasModel.id,
          prompt: form.prompt,
          params: activeAtlasParams(form),
          referenceStorageIds: storageIds.length > 0 ? storageIds : undefined,
          jobs: atlasJobsFor(atlasModel, form),
        });
      } else if (form.mediaType === "image") {
        await startImage({
          model: form.model,
          prompt: form.prompt,
          aspectRatio: form.aspectRatio,
          count: form.count,
          quality: form.quality,
          resolution: form.imageSizeTier,
          referenceStorageIds: storageIds.length > 0 ? storageIds : undefined,
        });
      } else {
        await startVideo({
          model: form.model,
          prompt: form.prompt,
          aspectRatio: form.aspectRatio,
          duration: form.duration,
          resolution: form.resolution,
          videoTier: form.videoTier,
          videoJobType: form.videoJobType,
          videoMode: form.videoMode,
          generateAudio: form.generateAudio,
          bitrateMode: form.bitrateMode,
          count: form.videoCount,
          referenceStorageIds: storageIds.length > 0 ? storageIds : undefined,
          referenceVoices:
            form.provider === "grok" && form.videoVoices.length > 0 ? form.videoVoices : undefined,
        });
      }
      return true;
    } catch (cause) {
      // Saying so beats a button that goes back to "Generate" as if nothing had
      // been asked of it.
      Alert.alert(
        "Could not start",
        cause instanceof Error ? cause.message : "The provider refused the request.",
      );
      return false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    form,
    selected,
    atlasModel,
    preflightError,
    startImage,
    startVideo,
    startAtlas,
    generateUploadUrl,
  ]);

  return {
    form,
    setForm,
    model,
    atlasModel,
    setAtlasParam,
    jobs,
    maxReferences: atlasModel ? atlasFamilyMaxReferences(atlasModel) : undefined,
    references,
    selectedReferences: selected,
    referenceIssues,
    setReferences: setReferencesChecked,
    adjustments,
    price,
    priceLabel: formatPrice(price),
    attachReference,
    addReference,
    reproduce,
    savePrompt,
    submit,
    submitting,
    canSubmit:
      !submitting &&
      referenceIssues.length === 0 &&
      (form.prompt.trim().length > 0 ||
        (atlasModel !== null && atlasPromptParam(atlasModel)?.required === false)),
  };
}

/**
 * Keeps Higgsfield quotes warm for the options on screen.
 *
 * Mirrors the web hook: quotes are cached server-side by signature and change
 * only when Higgsfield changes its pricing, so each distinct configuration is
 * asked for once. Non-Higgsfield models never reach the network.
 */
function useHiggsfieldQuotes(
  model: ReturnType<typeof getApiModel>,
  form: ApiFormState,
  referenceCount: number,
) {
  const isHiggsfield = model.provider === "higgsfield";
  const cached = useQuery(api.higgsfield.listCosts, isHiggsfield ? {} : "skip");
  const estimate = useAction(api.higgsfieldProcessor.estimateCost);
  const [requested] = useState(() => new Set<string>());

  const quotes = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of cached ?? []) map.set(row.signature, row.credits);
    return map;
  }, [cached]);

  // An effect, not a memo: this reaches the network. A `useMemo` body runs during
  // render, may run twice, and may be discarded — none of which are things to do
  // with a request. Still fire-and-forget, because a missing quote falls back to
  // the captured rate card, so the button always shows a number.
  useEffect(() => {
    if (!isHiggsfield || cached === undefined) return;
    void (async () => {
      for (const variant of variantsToQuote(model, form, referenceCount)) {
        const signature = variantSignature(model, variant, referenceCount);
        if (!signature || quotes.has(signature) || requested.has(signature)) continue;
        requested.add(signature);
        try {
          await estimate({
            model: model.id,
            mediaType: variant.mediaType,
            aspectRatio: variant.aspectRatio,
            sizeTier: variant.sizeTier,
            videoJobType: variant.videoJobType,
            videoMode: variant.videoMode,
            generateAudio: variant.generateAudio,
            duration: variant.duration,
            resolution: variant.resolution,
            referenceCount,
          });
        } catch {
          // Released so a blip while credentials seed does not leave that
          // configuration priceless for the session.
          requested.delete(signature);
        }
      }
    })();
  }, [isHiggsfield, cached, model, form, referenceCount, quotes, estimate, requested]);

  return quotes;
}
