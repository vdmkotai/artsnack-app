"use client";

import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { useQuery as useCachedQuery } from "@/lib/convex-cache";
import { useRouter } from "next/navigation";
import { Film, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { MediaLightbox } from "@/components/media-lightbox";
import { Button } from "@/components/ui/button";
import { PriceTag } from "@/components/api/price-tag";
import {
  isSelfHostedVideo,
  priceOfGeneration,
  type GenerationDoc,
} from "@/components/api/generation-meta";
import type { RefImage } from "@/components/api/types";
import { useToggleFavorite } from "@/hooks/use-toggle-favorite";
import { enhanceReproduceHref } from "@/lib/reference-handoff";
import { mediaUrl } from "@/lib/media-url";
import {
  findReferenceGeneration,
  referenceOutputKey,
  type ReferenceGeneration,
} from "@/lib/reference-generation";

interface ReferencePreviewProps {
  reference: RefImage;
  onClose: () => void;
  onRecreate: (generation: GenerationDoc) => void;
  onRemove: (generation: GenerationDoc) => Promise<boolean>;
  onUseAsReference: (url: string, asVideo?: boolean) => void;
}

export function ReferencePreview({
  reference,
  onClose,
  onRecreate,
  onRemove,
  onUseAsReference,
}: ReferencePreviewProps) {
  const client = useConvex();
  const router = useRouter();
  const favoriteKeys = useCachedQuery(api.favorites.myKeys);
  const toggleFavorite = useToggleFavorite();
  const b2Key = referenceOutputKey(reference.sourceUrl);
  const [source, setSource] = useState<ReferenceGeneration | null>(null);
  const [loading, setLoading] = useState(b2Key !== null);
  const [failed, setFailed] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);

  useEffect(() => {
    if (!b2Key) return;
    let cancelled = false;
    void findReferenceGeneration(client, b2Key, () => cancelled).then(
      (found) => {
        if (cancelled) return;
        setSource(found);
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, b2Key, lookupAttempt]);

  const url = source ? mediaUrl(source.b2Key) : reference.previewUrl;
  const reproduce = () => {
    if (!source) return;
    onClose();
    if (source.kind === "api") {
      onRecreate(source.generation);
    } else if (source.kind === "enhancement") {
      router.push(enhanceReproduceHref(source.generation._id));
    } else {
      sessionStorage.setItem("reproduce_state", JSON.stringify(source.generation.formState));
      router.push("/generate?reproduce=true");
    }
  };
  const handleUseReference = (asVideo?: boolean) => {
    onClose();
    onUseAsReference(url, asVideo);
  };

  return (
    <MediaLightbox
      items={[{ url, type: "image" }]}
      initialIndex={0}
      isOpen
      onClose={onClose}
      onReproduce={source ? reproduce : undefined}
      onSendToEnhance={
        source?.kind === "selfhosted"
          ? () => {
              sessionStorage.setItem(
                "enhance_source",
                JSON.stringify({ imageUrl: url, formState: source.generation.formState }),
              );
              onClose();
              router.push("/enhance");
            }
          : undefined
      }
      favoritedUrls={new Set(source && favoriteKeys?.includes(source.b2Key) ? [url] : [])}
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
      renderActions={() => (
        <>
          {loading ? (
            <span role="status" className="flex items-center gap-2 text-sm text-white/70">
              <Loader2 className="h-4 w-4 animate-spin" /> Finding generation...
            </span>
          ) : failed ? (
            <Button
              variant="ghost"
              className="text-white/70 hover:text-white hover:bg-white/10"
              onClick={() => {
                setFailed(false);
                setLoading(true);
                setLookupAttempt((attempt) => attempt + 1);
              }}
            >
              Lookup failed. Retry
            </Button>
          ) : !source ? (
            <span className="text-sm text-white/70">
              {b2Key
                ? "Original generation is unavailable"
                : "No generation settings for this reference"}
            </span>
          ) : (
            <>
              {source.kind === "api" && !isSelfHostedVideo(source.generation) && (
                <PriceTag
                  price={priceOfGeneration(source.generation)}
                  approximate={source.generation.costEstimated}
                  className="mr-2 text-white/70"
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                title="Use as reference"
                aria-label="Use as reference"
                className="text-white/70 hover:text-white hover:bg-white/10"
                onClick={() => handleUseReference(false)}
              >
                <ImagePlus className="h-6 w-6" />
              </Button>
              {source.kind === "api" && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Make video from this image"
                    aria-label="Make video from this image"
                    className="text-white/70 hover:text-white hover:bg-white/10"
                    onClick={() => handleUseReference(true)}
                  >
                    <Film className="h-6 w-6" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete generation"
                    aria-label="Delete generation"
                    className="text-white/70 hover:bg-red-500/20 hover:text-red-400"
                    onClick={() => {
                      void onRemove(source.generation).then((removed) => {
                        if (removed) onClose();
                      });
                    }}
                  >
                    <Trash2 className="h-6 w-6" />
                  </Button>
                </>
              )}
            </>
          )}
        </>
      )}
    />
  );
}
