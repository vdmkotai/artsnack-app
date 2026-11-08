import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import { prepareReferenceImage } from "@/lib/resize-image";
import {
  DEFAULT_STUDIO_VARIANTS,
  isStudioVariantCount,
  type StudioContext,
} from "@/lib/prompt-studio";

/**
 * The parts of Prompt Studio that are not React: what it remembers between
 * visits, how a reference becomes something the model can see, and the send
 * itself. Module scope on purpose — the React Compiler gives up on a
 * component that holds a `try` it cannot lower.
 */

const SESSION_KEY = "prompt-studio-session";
const PREFS_KEY = "prompt-studio-prefs";

export type StudioPrefs = {
  variantCount: number;
  /** An ENHANCE_MODELS id; unset follows the Enhance model setting. */
  modelId?: string;
  /** Show the references to a model that can see them. */
  vision: boolean;
  /** Recipe id per media type, or "auto". */
  formats: { image?: string; video?: string };
};

const DEFAULT_PREFS: StudioPrefs = {
  variantCount: DEFAULT_STUDIO_VARIANTS,
  vision: true,
  formats: {},
};

export function readStudioPrefs(): StudioPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<StudioPrefs>;
    const formats =
      parsed.formats && typeof parsed.formats === "object" ? parsed.formats : DEFAULT_PREFS.formats;
    return {
      variantCount: isStudioVariantCount(parsed.variantCount)
        ? parsed.variantCount
        : DEFAULT_PREFS.variantCount,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : undefined,
      vision: typeof parsed.vision === "boolean" ? parsed.vision : DEFAULT_PREFS.vision,
      formats: {
        image: typeof formats.image === "string" ? formats.image : undefined,
        video: typeof formats.video === "string" ? formats.video : undefined,
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveStudioPrefs(prefs: StudioPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked: the choices last until the page closes.
  }
}

export function readStudioSession(): Id<"promptStudioSessions"> | null {
  try {
    return (localStorage.getItem(SESSION_KEY) as Id<"promptStudioSessions"> | null) || null;
  } catch {
    return null;
  }
}

export function saveStudioSession(id: Id<"promptStudioSessions"> | null) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the next visit starts a new session.
  }
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
 * Each reference re-encoded once (≤1536 px, 768 KiB), and kept for as long as
 * the blob lives — every turn sends the images again, and re-encoding four
 * of them per message would be felt.
 */
const dataUrls = new WeakMap<Blob, Promise<string>>();

export function studioDataUrl(blob: Blob): Promise<string> {
  const cached = dataUrls.get(blob);
  if (cached) return cached;
  const pending = prepareReferenceImage(blob, "studio").then(({ blob: prepared }) =>
    blobToDataUrl(prepared),
  );
  dataUrls.set(blob, pending);
  // A failure is not remembered: the next send tries again.
  pending.catch(() => dataUrls.delete(blob));
  return pending;
}

export type StudioSendArgs = {
  sessionId?: Id<"promptStudioSessions">;
  text: string;
  replyTo?: string;
  variantCount: number;
  formatId?: Id<"enhanceRecipes">;
  modelId: string;
  context: StudioContext;
  currentPrompt?: string;
  images?: string[];
};

export type StudioSendResult = {
  sessionId: Id<"promptStudioSessions">;
  labels: string[];
  model: string;
  fellBack: boolean;
  reason?: string;
  costUsd?: number;
};

/** The context as the backend validates it: exactly these fields. */
export function studioContextArgs(context: StudioContext): StudioContext {
  return {
    media: context.media,
    targetModel: context.targetModel,
    duration: context.duration,
    aspectRatio: context.aspectRatio,
    referenceCount: context.referenceCount,
    frameInputs: context.frameInputs,
    tagsInPrompt: context.tagsInPrompt,
    frameSlots: context.frameSlots,
    referenceRoles: context.referenceRoles,
  };
}

/** Never rejects: a failure comes back as the message to show. */
export async function sendStudioMessage(
  send: (args: StudioSendArgs) => Promise<StudioSendResult>,
  args: StudioSendArgs,
  imageBlobs: readonly Blob[],
): Promise<{ ok: true; result: StudioSendResult } | { ok: false; message: string }> {
  try {
    const images = await Promise.all(imageBlobs.map(studioDataUrl));
    const result = await send({ ...args, images: images.length > 0 ? images : undefined });
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof ConvexError
          ? String(error.data)
          : error instanceof Error
            ? error.message
            : "The model did not answer",
    };
  }
}

export function timeAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
