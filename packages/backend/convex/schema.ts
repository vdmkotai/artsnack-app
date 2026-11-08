import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  comfyRunValidator,
  h3InputRoleValidator,
  h3SettingsValidator,
  ltxSettingsValidator,
} from "./h3Validators";
import { studioMessageValidator } from "./promptStudioValidators";

const loraSlotValidator = v.object({
  enabled: v.boolean(),
  loraName: v.string(),
  strengthModel: v.number(),
  strengthClip: v.number(),
});

const formStateValidator = v.object({
  prompt: v.string(),
  negativePrompt: v.string(),
  checkpoint: v.string(),
  width: v.number(),
  height: v.number(),
  seed: v.number(),
  steps: v.number(),
  cfg: v.number(),
  sampler: v.string(),
  scheduler: v.string(),
  denoise: v.number(),
  batchSize: v.number(),
  loras: v.array(loraSlotValidator),
});

/**
 * What one attached image does in a Grok 1.5 clip — the shape of
 * `GrokFrameRole` in packages/shared/grok-imagine.ts. `at` is a keyframe's
 * time in seconds and absent for every other role.
 */
export const grokFrameRoleValidator = v.object({
  role: v.union(
    v.literal("reference"),
    v.literal("first"),
    v.literal("last"),
    v.literal("loop"),
    v.literal("keyframe"),
  ),
  at: v.optional(v.number()),
});

export default defineSchema({
  generations: defineTable({
    userId: v.string(),
    timestamp: v.number(),
    formState: formStateValidator,
    imageUrls: v.array(v.string()),
    b2Keys: v.optional(v.array(v.string())),
    backend: v.optional(v.string()),
    searchablePrompt: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    promptId: v.optional(v.string()),
    /** Client id used to subscribe to this prompt's ComfyUI WebSocket events. */
    comfyClientId: v.optional(v.string()),
    error: v.optional(v.string()),
    progressStage: v.optional(v.string()),
    progressMessage: v.optional(v.string()),
    progressCurrent: v.optional(v.number()),
    progressTotal: v.optional(v.number()),
    queuePosition: v.optional(v.number()),
    providerStatus: v.optional(v.string()),
    progressUpdatedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_timestamp", ["userId", "timestamp"])
    // For the stalled-job sweeper, which runs from a cron with no user to scope
    // to. This table has no `updatedAt`, so the sweep keys on `timestamp` — the
    // insert time, written once by startGeneration and never patched. That is
    // enough here: the row goes in as `pending` and the action that owns it
    // starts immediately and cannot outlive the 10-minute ceiling, so anything
    // still unfinished well past that is dead by definition. Rows written by
    // `save` carry no status at all and are never matched.
    .index("by_status_timestamp", ["status", "timestamp"])
    // "Remove all failed" is user-scoped and would otherwise read the user's
    // entire history to find the handful of rows it deletes — the same reason
    // grokGenerations carries by_user_status_createdAt.
    .index("by_user_status_timestamp", ["userId", "status", "timestamp"])
    .searchIndex("search_prompt", {
      searchField: "searchablePrompt",
      filterFields: ["userId"],
    }),
  // Reusable prompts, editable on their own page and insertable from either tab.
  savedPrompts: defineTable({
    userId: v.string(),
    title: v.string(),
    text: v.string(),
    // Cheap non-cryptographic digest of `text`, so saving the same wording
    // twice is a point lookup rather than a read of every prompt the user owns.
    // Collisions are resolved by comparing the text itself.
    textHash: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Ordered by creation, not by update: a prompt edited in place would
    // otherwise jump to the front of the grid mid-edit.
    .index("by_user_createdAt", ["userId", "createdAt"])
    .index("by_user_hash", ["userId", "textHash"]),
  /**
   * Prompt-enhancement recipes: a system prompt each, seeded from
   * packages/shared/prompt-enhance.ts the first time a user opens the feature
   * and theirs to edit after that. Which model answers is not stored here —
   * it is one setting for all recipes, in enhanceSettings.
   */
  enhanceRecipes: defineTable({
    userId: v.string(),
    title: v.string(),
    instructions: v.string(),
    media: v.union(v.literal("image"), v.literal("video"), v.literal("any")),
    /** The one the Enhance button runs without opening the menu, per media. */
    isDefault: v.boolean(),
    /**
     * Title of the built-in this row was seeded from, so "restore built-ins"
     * can tell a renamed original from a missing one. Unset on user-made rows.
     */
    builtinKey: v.optional(v.string()),
    /** An ENHANCE_MODELS id this recipe runs on instead of the global one. */
    modelId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_createdAt", ["userId", "createdAt"]),
  /**
   * Prompt Studio conversations: a brief, the variants the model wrote, the
   * user's corrections, and so on. One document per session, capped by
   * message count and byte size in promptStudio.ts. Images are not
   * kept — they travel with each request and are gone after it.
   */
  promptStudioSessions: defineTable({
    userId: v.string(),
    title: v.string(),
    media: v.union(v.literal("image"), v.literal("video")),
    messages: v.array(studioMessageValidator),
    sending: v.optional(v.object({ id: v.string(), until: v.number() })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_updatedAt", ["userId", "updatedAt"]),
  enhanceSettings: defineTable({
    userId: v.string(),
    /** An ENHANCE_MODELS id; unknown values resolve to the default model. */
    modelId: v.string(),
    /** Set once the built-in recipes were copied in, so deleting them all sticks. */
    seededAt: v.optional(v.number()),
    /** BUILTIN_RECIPES_VERSION last seeded; absent = 1, the original set. */
    builtinsVersion: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
  /** Named global-search intents, synced across web and native. */
  savedSearches: defineTable({
    userId: v.string(),
    title: v.string(),
    /** URLSearchParams produced by packages/shared/search.ts. */
    intent: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_updatedAt", ["userId", "updatedAt"])
    .index("by_user_title", ["userId", "title"]),
  /**
   * Atlas models the user has starred.
   *
   * Atlas is 300 models behind a search dialog, which is the right control for
   * finding a model and the wrong one for the four you actually use. Starring
   * pins them to a row of chips beside the picker, so the common case is one
   * click instead of open-search-scroll-click every time.
   *
   * A table rather than localStorage because this is a curated list the user
   * builds up over weeks — the same reason savedPrompts is one — and losing it
   * to a cleared cache or a different browser would be worse than the cost of
   * a query. It also means the iOS app gets the same list for free.
   *
   * The row stores the vendor slug, not a registry id: the catalogue is
   * regenerated from a live vendor, so a starred model can disappear. Readers
   * resolve against the catalogue and skip what no longer exists rather than
   * failing, and the row is left in place in case a later sync brings it back.
   */
  atlasFavorites: defineTable({
    userId: v.string(),
    /** e.g. "atlascloud/wan-2.2/image-to-video". */
    modelId: v.string(),
    createdAt: v.number(),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    // Toggling is a point lookup, not a scan of everything the user starred.
    .index("by_user_model", ["userId", "modelId"]),
  enhancements: defineTable({
    userId: v.string(),
    timestamp: v.number(),
    mode: v.string(), // "img2img" | "upscale" | "refine" | "facefix"
    sourceImageUrl: v.string(), // URL of input image
    sourceB2Key: v.optional(v.string()), // B2 key of input (if from generation)
    sourceGenerationId: v.optional(v.id("generations")), // Optional link to source generation
    resultB2Key: v.string(), // B2 key of output
    params: v.any(), // Mode-specific parameters snapshot (flexible)
    backend: v.optional(v.string()),
    warning: v.optional(v.string()), // e.g. "No faces detected"
  })
    .index("by_user", ["userId"])
    .index("by_user_timestamp", ["userId", "timestamp"]),
  /** Folders the user files favourites into. Flat, no nesting — the point is a
   *  handful of curated buckets, not a filesystem. */
  favoriteFolders: defineTable({
    userId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    // Creating is idempotent by name: re-creating "refs" returns the existing
    // folder instead of a twin, which is a point lookup here.
    .index("by_user_name", ["userId", "name"]),
  // Favourites span both pipelines. The self-hosted side denormalises its form
  // so the page can reproduce without a join; API rows have a different shape
  // entirely, so they carry a pointer and the settings are read back live.
  favorites: defineTable({
    userId: v.string(),
    generationId: v.optional(v.id("generations")),
    apiGenerationId: v.optional(v.id("grokGenerations")),
    /**
     * An enhanced image, which is neither of the above.
     *
     * Enhancements are their own table — they have a source image and a mode
     * rather than a prompt and a model — so favouriting one had nowhere to
     * point and the heart simply was not offered on the Enhance page. The
     * pointer ids are mutually exclusive; `b2Key` stays the identity a toggle
     * keys on, exactly as before.
     */
    enhancementId: v.optional(v.id("enhancements")),
    b2Key: v.string(),
    formState: v.optional(formStateValidator),
    /** Absent means unfiled — the default bucket every heart lands in. */
    folderId: v.optional(v.id("favoriteFolders")),
    /**
     * Denormalised filter columns, written by toggle/import since the filters
     * landed. Rows from before carry none of them; listFavorites derives the
     * same values through the join it already performs, so old rows filter
     * correctly — they just cost one extra read each.
     */
    mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
    provider: v.optional(v.string()),
    checkpoint: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    .index("by_user_key", ["userId", "b2Key"])
    // Folder views page on this; `folderId: undefined` addresses the unfiled set.
    .index("by_user_folder", ["userId", "folderId", "createdAt"]),
  // Pending Grok (xAI) device-authorization login sessions. Short-lived;
  // deleted once the user approves/denies or the code expires.
  grokAuthSessions: defineTable({
    userId: v.string(),
    deviceCode: v.string(),
    userCode: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
  // Grok (xAI) OAuth tokens from the device flow. One row per user.
  // Tokens are never returned from queries — only used by internal actions.
  grokTokens: defineTable({
    userId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    email: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
  // Higgsfield OAuth credentials, seeded once from the HIGGSFIELD_CREDENTIALS
  // env var and rewritten whenever the CLI rotates the token. A table rather
  // than an env var because actions can read the environment but not write it.
  higgsfieldAuth: defineTable({
    credentials: v.string(),
    updatedAt: v.number(),
  }),
  // Cached credit quotes from `higgsfield generate cost`, keyed by a signature
  // of the request. Higgsfield prices in credits and publishes no rate table,
  // so the vendor's own quote is the only honest source.
  higgsfieldCosts: defineTable({
    signature: v.string(),
    credits: v.number(),
    updatedAt: v.number(),
  }).index("by_signature", ["signature"]),
  // Last known plan balance, refreshed on a TTL so the UI can show what is left.
  higgsfieldAccount: defineTable({
    credits: v.number(),
    planType: v.optional(v.string()),
    email: v.optional(v.string()),
    updatedAt: v.number(),
  }),
  // Hosted-API generations (images and videos), self-contained so the existing
  // self-hosted generations/videos pipelines are untouched. Originally Grok
  // only; now also carries fal (Seedream / Seedance) rows, distinguished by
  // `provider`. Rows written before that field existed are Grok by definition,
  // which is why every new column is optional and no migration is needed.
  grokGenerations: defineTable({
    userId: v.string(),
    createdAt: v.number(),
    prompt: v.string(),
    searchablePrompt: v.string(),
    mediaType: v.union(v.literal("image"), v.literal("video")),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    b2Key: v.optional(v.string()),
    b2Keys: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    aspectRatio: v.optional(v.string()),
    count: v.optional(v.number()),
    quality: v.optional(v.string()),
    duration: v.optional(v.number()),
    resolution: v.optional(v.string()),
    hasReferenceImage: v.boolean(),
    referenceB2Keys: v.optional(v.array(v.string())),
    /** Original output keys, in reference slot order; null for uploaded files. */
    referenceSourceKeys: v.optional(v.array(v.union(v.string(), v.null()))),
    referenceStorageId: v.optional(v.id("_storage")),
    referenceStorageIds: v.optional(v.array(v.id("_storage"))),
    /** Grok video only: preset voice ids the clip's subjects speak with. */
    referenceVoices: v.optional(v.array(v.string())),
    /**
     * Grok video only: the model slug the clip ran on. Absent ⇒
     * grok-imagine-video-1.5, the only one used before 1.5 Lite, Edit and
     * Extend existed.
     */
    grokVideoModel: v.optional(v.string()),
    /** Grok video only: "edit" or "extend". Absent ⇒ generate. */
    grokVideoMode: v.optional(v.string()),
    /**
     * Grok 1.5 only: the role each reference played, in `referenceStorageIds`
     * (and later `referenceB2Keys`) order. Absent ⇒ the old rule — one image
     * is the first frame, two or more are references.
     */
    grokFrameRoles: v.optional(v.array(grokFrameRoleValidator)),
    /** Grok edit/extend: B2 key of the source clip (an mp4 on a video prefix). */
    sourceVideoKey: v.optional(v.string()),
    /** Grok edit/extend: the source clip's length in seconds, as measured. */
    sourceVideoSeconds: v.optional(v.number()),
    /**
     * Grok only: the quota xAI reported for the finished job
     * (`usage.cost_in_usd_ticks`, in USD). Absent where xAI sent no usage —
     * the tile then shows the rate-card estimate instead.
     */
    meteredUsd: v.optional(v.number()),
    // --- Provider routing. Absent ⇒ Grok, for rows written before fal existed. ---
    provider: v.optional(
      v.union(
        v.literal("grok"),
        v.literal("fal"),
        v.literal("higgsfield"),
        v.literal("atlas"),
        // Self-hosted MiniMax H3 on the video pod (comfyVideo.ts). Lives here,
        // not in `generations`, because these rows are videos with a long-poll
        // lifecycle — exactly what this table's grid, lightbox, favourites,
        // search and lease fields already handle.
        v.literal("comfy"),
      ),
    ),
    /** Registry id. For grok/fal/higgsfield one of api-models.ts's ids; for
     *  Atlas the vendor slug itself, e.g. "atlascloud/wan-2.2/image-to-video". */
    apiModel: v.optional(v.string()),
    /**
     * Every input for an Atlas job, by the vendor's own parameter names.
     *
     * The other three providers fit the flat columns below because they offer a
     * handful of endpoints with a shared vocabulary. Atlas offers 300 models
     * with 131 distinct parameter names — `ratio` here, `aspect_ratio` there,
     * `bitrate_mode` on one family only — so its settings are stored as the bag
     * the model declared rather than smeared across columns that would be null
     * for almost every row. The processor replays it through buildAtlasRequest,
     * which re-validates against the catalogue, so a schema change at Atlas
     * degrades to a clamped value rather than a rejected request.
     */
    atlasParams: v.optional(
      v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.array(v.string()))),
    ),
    /** Self-hosted H3 only: every setting, seed resolved. */
    h3Settings: v.optional(h3SettingsValidator),
    /** Self-hosted LTX 2.3 job on the same video pod (exclusive with h3Settings). */
    ltxSettings: v.optional(ltxSettingsValidator),
    /** Self-hosted H3 only: the role of each `referenceStorageIds` entry. */
    h3InputRoles: v.optional(v.array(h3InputRoleValidator)),
    /** Self-hosted H3 only: the WebSocket client id the prompt was queued under. */
    comfyClientId: v.optional(v.string()),
    /** Self-hosted H3 only: the pod that owns the job, so a destroyed pod fails
     *  its jobs instead of leaving them polling a dead URL. */
    comfyBackendId: v.optional(v.id("runpodBackends")),
    /** Self-hosted H3 only: timings and GPU, for the lightbox's details panel. */
    comfyRun: v.optional(comfyRunValidator),
    /** The concrete vendor endpoint the job was sent to, for debugging. */
    endpoint: v.optional(v.string()),
    /** Seedance quality tier on fal: "mini" | "fast" | "standard". */
    videoTier: v.optional(v.string()),
    /** Higgsfield video job type — its models are not interchangeable. */
    videoJobType: v.optional(v.string()),
    /** Seedance `mode` (std/fast) or Kling `mode` (std/pro/4k). */
    videoMode: v.optional(v.string()),
    generateAudio: v.optional(v.boolean()),
    bitrateMode: v.optional(v.string()),
    falRequestId: v.optional(v.string()),
    /**
     * Ownership of the Atlas poll loop. The cron may replace an expired lease,
     * but never starts a second 100MB+ output transfer beside a live action.
     */
    atlasPollLeaseId: v.optional(v.string()),
    atlasPollLeaseUntil: v.optional(v.number()),
    /** Absolute deadline shared by every continuation of one Atlas request. */
    atlasWaitEndsAt: v.optional(v.number()),
    /** Groups the rows of one fan-out, so shared reference blobs are only
     *  released once every sibling has finished with them. */
    batchId: v.optional(v.string()),
    /**
     * When the processor was scheduled — not when the row was created.
     *
     * Higgsfield jobs queue behind a concurrency limit, so `pending` covers two
     * different things: waiting for a slot (no `dispatchedAt`) and started but
     * not yet picked up (set). The stalled sweeper measures from here, because
     * the age of a row that has not been handed to anyone says nothing about
     * whether the work is stuck. Absent on rows written before the queue existed.
     */
    dispatchedAt: v.optional(v.number()),
    /** When the output reached storage. Absent on rows finished before it existed. */
    completedAt: v.optional(v.number()),
    /** USD. Written when the record is created so a price exists before fal replies. */
    costUsd: v.optional(v.number()),
    /** Higgsfield plan credits. Providers bill in different units, so the two
     *  figures are kept apart rather than converted through a made-up rate. */
    creditsUsed: v.optional(v.number()),
    /** True while the cost is a pre-flight figure rather than one measured from the output. */
    costEstimated: v.optional(v.boolean()),
    /** Machine-readable failure class: auth | billing | validation | moderation
     *  | rate_limit | server | timeout. Lets the UI tell "top up your fal
     *  balance" apart from a generic failure. */
    errorKind: v.optional(v.string()),
    /** Live lifecycle details. Exact progress is present only when the provider
     *  exposes a numerator and denominator; an absent pair means indeterminate. */
    progressStage: v.optional(v.string()),
    progressMessage: v.optional(v.string()),
    progressCurrent: v.optional(v.number()),
    progressTotal: v.optional(v.number()),
    queuePosition: v.optional(v.number()),
    providerStatus: v.optional(v.string()),
    progressUpdatedAt: v.optional(v.number()),
  })
    .index("by_user_createdAt", ["userId", "createdAt"])
    // The Self-hosted video tab's own grid: only provider "comfy" rows, paged
    // by time, without reading past every API result to find them.
    .index("by_user_provider_createdAt", ["userId", "provider", "createdAt"])
    .index("by_batch", ["batchId"])
    .index("by_provider_status_pollLease", ["provider", "status", "atlasPollLeaseUntil"])
    // The stalled-job sweeper runs from a cron with no user to scope to, so it
    // needs a status-first index; without one its `.filter()` ran after the
    // read and every sweep paged the whole table.
    .index("by_status_createdAt", ["status", "createdAt"])
    // "Remove all failed" is user-scoped and would otherwise read the user's
    // entire history to find the handful of rows it deletes.
    .index("by_user_status_createdAt", ["userId", "status", "createdAt"])
    .searchIndex("search_prompt", {
      searchField: "searchablePrompt",
      filterFields: ["userId", "mediaType"],
    }),
  /**
   * Last-known-good copy of the published provisioning script
   * (PROVISION_SCRIPT_URL), refreshed by the `/provision-script` HTTP route
   * (convex/http.ts) every time it fetches the script successfully. Single row.
   * Exists because a pod's datacenter shares one egress IP with every other
   * tenant, and a host like GitHub 429s that IP anonymously — a pod booted bare
   * because the template's one curl of the script got throttled. The published
   * script stays the source of truth; this is a serve-stale fallback, never
   * edited by hand.
   */
  provisionScript: defineTable({
    // Optional only for the one cache row written before the singleton key was
    // introduced. The next successful refresh backfills it in-place.
    key: v.optional(v.literal("current")),
    content: v.string(),
    fetchedAt: v.number(),
  }).index("by_key", ["key"]),

  /**
   * Which video family a file on the video pod belongs to (written with the
   * internal `podModels.setVideoFamily` mutation) — so the H3 and LTX forms
   * each list their own checkpoints and LoRAs. Files with no row fall back to
   * a filename guess.
   */
  videoModelFamilies: defineTable({
    filename: v.string(),
    family: v.union(v.literal("h3"), v.literal("ltx")),
    updatedAt: v.number(),
  }).index("by_filename", ["filename"]),
  /**
   * The dynamic half of the pod provisioning manifest. infra/provision.sh ships
   * a static model list; at boot it also fetches `/pod-manifest`
   * (convex/http.ts), which serializes the enabled rows here in the same
   * `dir|url|filename` format and appends them — so "add this LoRA to future
   * pods" is an insert, not an edit of the published script. Rows are added
   * with the internal `podModels.upsert` mutation.
   */
  podModels: defineTable({
    dir: v.union(v.literal("checkpoints"), v.literal("loras"), v.literal("diffusion_models")),
    /** Which pod's manifest the row belongs to. Absent = image (every row
     *  written before the video pod existed). */
    profile: v.optional(v.union(v.literal("image"), v.literal("video"))),
    /** Full download URL, host included. provision.sh only accepts
     *  https://huggingface.co/ URLs from this list. */
    url: v.string(),
    filename: v.string(),
    /** Off rows stay for the record but leave the manifest. */
    enabled: v.boolean(),
    addedAt: v.number(),
    addedBy: v.string(),
    modelName: v.optional(v.string()),
  })
    // One file per name per directory: re-adding a model updates the row.
    .index("by_dir_filename", ["dir", "filename"]),

  /**
   * The one Vast.ai ComfyUI machine currently owned by a user.
   *
   * This is orchestration state, not a second source of truth for Vast: refresh
   * reads the provider's actual state and updates this snapshot. The row exists
   * so the UI stays reactive while provisioning reports progress and so two
   * impatient clicks cannot rent two GPUs. The active constraint is global,
   * because every allowed user shares one Vast account and one tunnel hostname.
   */
  vastBackends: defineTable({
    active: v.boolean(),
    instanceId: v.optional(v.number()),
    launchLabel: v.string(),
    progressTokenHash: v.string(),
    gpuName: v.string(),
    numGpus: v.number(),
    diskGb: v.number(),
    diskBandwidthMbps: v.number(),
    diskName: v.string(),
    location: v.string(),
    reliability: v.number(),
    hourlyUsd: v.number(),
    storageHourlyUsd: v.number(),
    publicUrl: v.string(),
    state: v.union(
      v.literal("reserving"),
      v.literal("loading"),
      v.literal("provisioning"),
      v.literal("ready"),
      v.literal("stopped"),
      v.literal("offline"),
      v.literal("destroying"),
      v.literal("destroyed"),
      v.literal("error"),
    ),
    providerStatus: v.optional(v.string()),
    stage: v.string(),
    message: v.string(),
    progress: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    progressUpdatedAt: v.number(),
    provisioningDeadlineAt: v.number(),
    lifecycleRevision: v.number(),
    cleanupAttempts: v.number(),
    updatedAt: v.number(),
    destroyedAt: v.optional(v.number()),
  }).index("by_active", ["active"]),
  /** Managed RunPod state is intentionally separate from Vast so both may be
   * online at once and neither provider's lifecycle can mutate the other. */
  runpodBackends: defineTable({
    active: v.boolean(),
    podId: v.optional(v.string()),
    launchName: v.string(),
    progressTokenHash: v.string(),
    gpuTypeId: v.string(),
    gpuName: v.string(),
    numGpus: v.number(),
    cloudType: v.union(v.literal("SECURE"), v.literal("COMMUNITY")),
    templateProfile: v.union(v.literal("cuda12.8"), v.literal("cuda13.0")),
    templateId: v.string(),
    /** What the pod is for. Absent = image, i.e. every pod launched before the
     *  video pod existed. One active pod per purpose. */
    purpose: v.optional(v.union(v.literal("image"), v.literal("video"))),
    containerDiskGb: v.number(),
    volumeDiskGb: v.number(),
    hourlyUsd: v.number(),
    maxHourlyUsd: v.number(),
    publicUrl: v.string(),
    /** Video pods with several GPUs: every ComfyUI that answered when the pod
     *  became ready, GPU 0 first. Absent = just publicUrl. */
    instanceUrls: v.optional(v.array(v.string())),
    state: v.union(
      v.literal("reserving"),
      v.literal("loading"),
      v.literal("provisioning"),
      v.literal("ready"),
      v.literal("stopped"),
      v.literal("destroying"),
      v.literal("destroyed"),
      v.literal("error"),
    ),
    providerStatus: v.optional(v.string()),
    stage: v.string(),
    message: v.string(),
    progress: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    progressUpdatedAt: v.number(),
    provisioningDeadlineAt: v.number(),
    lifecycleRevision: v.number(),
    cleanupAttempts: v.number(),
    updatedAt: v.number(),
    destroyedAt: v.optional(v.number()),
  })
    .index("by_active", ["active"])
    // The active pods of one purpose, so a video-pod subscriber's read set
    // leaves out the image pod and its ~140 provisioning reports per boot.
    // Untagged rows (purpose absent) are image pods, read as `undefined`.
    .index("by_active_purpose", ["active", "purpose"]),
  /** Which ready self-hosted provider receives newly submitted generations. */
  selfHostedSelection: defineTable({
    key: v.literal("default"),
    provider: v.union(v.literal("vast"), v.literal("runpod"), v.literal("legacy")),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_key", ["key"]),
  /**
   * Per-user UI switches (packages/shared/feature-flags.ts). Each field is an
   * override of a default that is always "on", so absent means enabled.
   */
  featureFlags: defineTable({
    userId: v.string(),
    higgsfield: v.optional(v.boolean()),
    fal: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
});
