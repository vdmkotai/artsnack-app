"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useConvex, useQuery } from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { useRouter } from "next/navigation";
import { Film, ImagePlus, Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { MediaLightbox, type MediaLightboxProps } from "@/components/media-lightbox";
import { Button } from "@/components/ui/button";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import { ReferenceThumb, generationReferences, type Reference } from "@/components/reference-thumb";
import { mediaUrl } from "@/lib/media-url";
import { apiReproduceHref, enhanceReproduceHref, queueApiReference } from "@/lib/reference-handoff";
import {
  findReferenceGeneration,
  referenceOutputKey,
  type ReferenceGeneration,
} from "@/lib/reference-generation";

/**
 * The details panel, loaded on demand.
 *
 * It names models and prices through `api/generation-meta`, which imports the
 * generated Atlas catalogue — about 87 KB gzipped, and until this every page with
 * a lightbox (history, gallery, favourites, enhance, generate) shipped it up
 * front for a panel most visits never open. `ssr: false` because it only ever
 * renders inside an open lightbox.
 */
const GenerationDetails = dynamic(
  () => import("@/components/generation-details").then((module) => module.GenerationDetails),
  {
    ssr: false,
    loading: () => (
      <aside
        data-reference-panel
        aria-label="Generation details"
        className="flex shrink-0 items-start rounded-xl border border-white/10 bg-neutral-950/80 p-4 text-white md:w-80 md:self-stretch"
      >
        <p role="status" className="flex items-center gap-2 text-xs text-white/50">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading details...
        </p>
      </aside>
    ),
  },
);

/**
 * Fetches the panel's chunk ahead of need — on the first opening of a lightbox,
 * so pressing `i` is instant, and on idle when the panel was left open last time
 * and will render the moment a lightbox opens. Same specifier as above, so it is
 * the same chunk and the import is deduplicated.
 */
function warmDetails() {
  void import("@/components/generation-details");
}

export type ReferenceSource =
  | { kind: "api"; id: Id<"grokGenerations"> }
  | { kind: "enhancement"; id: Id<"enhancements"> };

type ReferenceActions = {
  onUseReference?: (url: string, asVideo?: boolean) => void;
  onReproduceApi?: (generation: Doc<"grokGenerations">) => void;
};

/**
 * Hands an image to the page's form as a reference, closing the viewer first.
 * A page without a form of its own (Favorites) sends it to the API tab.
 */
function useReferenceHandoff(
  onUseReference: ReferenceActions["onUseReference"],
  onClose: () => void,
) {
  const router = useRouter();
  return (url: string, video = false) => {
    onClose();
    if (onUseReference) onUseReference(url, video);
    else {
      queueApiReference(url, video ? "video" : "image");
      router.push("/generate?tab=api");
    }
  };
}

function ReferencePanel({
  source,
  onOpen,
  onUse,
}: {
  source?: ReferenceSource;
  onOpen: (reference: Reference) => void;
  onUse: (url: string) => void;
}) {
  const generation = useQuery(
    api.grokGenerations.get,
    source?.kind === "api" ? { id: source.id } : "skip",
  );
  const enhancement = useQuery(
    api.enhancements.getById,
    source?.kind === "enhancement" ? { id: source.id } : "skip",
  );
  if (!source) return null;
  const references: Reference[] = generation
    ? generationReferences(generation)
    : enhancement &&
        (enhancement.sourceB2Key ||
          /^(https?:\/\/|\/api\/images\/)/.test(enhancement.sourceImageUrl))
      ? [
          {
            url: enhancement.sourceB2Key
              ? mediaUrl(enhancement.sourceB2Key)
              : enhancement.sourceImageUrl,
            sourceKey: enhancement.sourceB2Key ?? referenceOutputKey(enhancement.sourceImageUrl),
          },
        ]
      : [];
  const loading = source.kind === "api" ? generation === undefined : enhancement === undefined;
  if (!loading && references.length === 0 && !generation?.hasReferenceImage) return null;
  return (
    <aside
      data-reference-panel
      aria-label="Source references"
      className="max-h-40 shrink-0 overflow-y-auto rounded-xl border border-white/10 bg-white/5 p-4 text-white md:max-h-full md:w-44 md:self-start"
    >
      <h2 className="mb-3 text-sm font-medium text-white/80">References</h2>
      {loading ? (
        <p role="status" className="text-xs text-white/50">
          Loading references...
        </p>
      ) : references.length === 0 ? (
        <p className="text-xs text-white/50">The original reference was not saved.</p>
      ) : (
        <div className="flex gap-3 md:flex-col">
          {references.map((reference, index) => (
            <ReferenceThumb
              key={`${reference.url}:${index}`}
              reference={reference}
              index={index}
              onOpen={onOpen}
              onUse={onUse}
              className="w-24 shrink-0 md:w-full"
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function ReferenceViewer({
  reference,
  onBack,
  onClose,
  onOpen,
  onUseReference,
  onReproduceApi,
}: ReferenceActions & {
  reference: Reference;
  onBack: () => void;
  onClose: () => void;
  onOpen: (reference: Reference) => void;
}) {
  const client = useConvex();
  const router = useRouter();
  const handOff = useReferenceHandoff(onUseReference, onClose);
  const favoriteKeys = useCachedQuery(api.favorites.myKeys);
  const toggleFavorite = useToggleFavorite();
  const key = reference.sourceKey ?? referenceOutputKey(reference.url);
  const [source, setSource] = useState<ReferenceGeneration | null>(null);
  const [loading, setLoading] = useState(!!key);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void findReferenceGeneration(client, key, () => cancelled).then(
      (found) => {
        if (!cancelled) {
          setSource(found);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, key, attempt]);

  const reproduce = () => {
    if (!source) return;
    onClose();
    if (source.kind === "api") {
      if (onReproduceApi) onReproduceApi(source.generation);
      else router.push(apiReproduceHref(source.generation._id));
    } else if (source.kind === "enhancement")
      router.push(enhanceReproduceHref(source.generation._id));
    else {
      sessionStorage.setItem("reproduce_state", JSON.stringify(source.generation.formState));
      router.push("/generate?reproduce=true");
    }
  };
  const handleUseReference = (video = false) =>
    handOff(source ? mediaUrl(source.b2Key) : reference.url, video);
  return (
    <MediaLightbox
      items={[{ url: reference.url, type: "image" }]}
      initialIndex={0}
      isOpen
      onClose={onClose}
      onBack={onBack}
      onReproduce={source ? reproduce : undefined}
      onSendToEnhance={() => {
        sessionStorage.setItem(
          "enhance_source",
          JSON.stringify({
            imageUrl: reference.url,
            formState: source?.kind === "selfhosted" ? source.generation.formState : null,
          }),
        );
        onClose();
        router.push("/enhance");
      }}
      onToggleFavorite={
        source
          ? () => {
              void toggleFavorite(
                source.kind === "api"
                  ? { apiGenerationId: source.generation._id, b2Key: source.b2Key }
                  : source.kind === "enhancement"
                    ? { enhancementId: source.generation._id, b2Key: source.b2Key }
                    : { generationId: source.generation._id, b2Key: source.b2Key },
              );
            }
          : undefined
      }
      favoritedUrls={new Set(source && favoriteKeys?.includes(source.b2Key) ? [reference.url] : [])}
      renderActions={() => (
        <>
          <Button
            variant="ghost"
            size="icon"
            title="Use as reference"
            aria-label="Use as reference"
            className="text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => handleUseReference()}
          >
            <ImagePlus className="h-6 w-6" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Make video from this image"
            aria-label="Make video from this image"
            className="text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => handleUseReference(true)}
          >
            <Film className="h-6 w-6" />
          </Button>
        </>
      )}
      renderSidebar={() => (
        <div
          data-reference-panel
          className="max-h-40 shrink-0 overflow-y-auto text-white md:max-h-full md:w-44"
        >
          <div className="mb-3 rounded-xl border border-white/10 bg-white/5 p-4">
            <h2 className="mb-2 text-sm font-medium">Source image</h2>
            {loading ? (
              <p role="status" className="text-xs text-white/50">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                Finding generation...
              </p>
            ) : failed ? (
              <Button
                variant="ghost"
                className="h-auto whitespace-normal p-0 text-xs"
                onClick={() => {
                  setLoading(true);
                  setFailed(false);
                  setAttempt(attempt + 1);
                }}
              >
                Lookup failed. Retry
              </Button>
            ) : (
              <p className="text-xs text-white/50">
                {source
                  ? "Generation settings available"
                  : key
                    ? "Original generation is unavailable. You can still use this saved reference."
                    : "No generation settings were saved for this reference."}
              </p>
            )}
          </div>
          <ReferencePanel
            source={
              source && source.kind !== "selfhosted"
                ? ({ kind: source.kind, id: source.generation._id } as ReferenceSource)
                : undefined
            }
            onOpen={onOpen}
            onUse={(url) => handOff(url)}
          />
        </div>
      )}
    />
  );
}

/** Whether the details sidebar was open last time, across items and visits. */
const DETAILS_KEY = "artsnack-lightbox-details";

function readDetailsOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Module scope keeps the `try` out of the component: React Compiler does not
 * lower a ternary inside one, and gave up on the whole lightbox because of it.
 */
function writeDetailsOpen(open: boolean) {
  try {
    localStorage.setItem(DETAILS_KEY, open ? "1" : "0");
  } catch {
    // Still toggles for this visit when storage is blocked.
  }
}

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(callback, 1500);
  return () => window.clearTimeout(timer);
}

/** Reference navigation has its own stack; the gallery keeps its anchored result. */
export function GenerationLightbox({
  getSource,
  onUseReference,
  onReproduceApi,
  ...props
}: MediaLightboxProps &
  ReferenceActions & { getSource: (url: string) => ReferenceSource | undefined }) {
  const [trail, setTrail] = useState<Reference[]>([]);
  const [wasOpen, setWasOpen] = useState(props.isOpen);
  if (wasOpen !== props.isOpen) {
    setWasOpen(props.isOpen);
    setTrail([]);
  }
  // Read after mount: localStorage does not exist during the server render.
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    const open = readDetailsOpen();
    setDetailsOpen(open);
    if (open) return whenIdle(warmDetails);
  }, []);
  useEffect(() => {
    if (props.isOpen) warmDetails();
  }, [props.isOpen]);
  const toggleDetails = () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    writeDetailsOpen(next);
  };
  const handOff = useReferenceHandoff(onUseReference, props.onClose);
  const current = trail.at(-1);
  const open = (reference: Reference) => setTrail((previous) => [...previous, reference]);
  return (
    <>
      <MediaLightbox
        {...props}
        suspended={!!current}
        infoAvailable={(url) => getSource(url)?.kind === "api"}
        infoOpen={detailsOpen}
        onToggleInfo={toggleDetails}
        renderSidebar={(url) => {
          const source = getSource(url);
          // The details panel lists the inputs itself, so it replaces the
          // references column rather than sitting beside it.
          return detailsOpen && source?.kind === "api" ? (
            <GenerationDetails
              key={source.id}
              id={source.id}
              onOpenReference={open}
              onUseReference={(reference) => handOff(reference)}
              onClose={toggleDetails}
            />
          ) : (
            <ReferencePanel
              source={source}
              onOpen={open}
              onUse={(reference) => handOff(reference)}
            />
          );
        }}
      />
      {props.isOpen && current && (
        <ReferenceViewer
          key={`${trail.length}:${current.url}`}
          reference={current}
          onUseReference={onUseReference}
          onReproduceApi={onReproduceApi}
          onClose={props.onClose}
          onBack={() => setTrail((previous) => previous.slice(0, -1))}
          onOpen={open}
        />
      )}
    </>
  );
}
