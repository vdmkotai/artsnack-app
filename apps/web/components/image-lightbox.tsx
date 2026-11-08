"use client";

import { useMemo } from "react";

import { GenerationLightbox, type ReferenceSource } from "@/components/generation-lightbox";
import { MediaLightbox, type LightboxMedia } from "@/components/media-lightbox";

interface ImageLightboxProps {
  getSource?: (url: string) => ReferenceSource | undefined;
  images: string[];
  initialIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onReproduce?: (imageUrl: string) => void;
  onSendToEnhance?: (imageUrl: string) => void;
  onToggleFavorite?: (imageUrl: string) => void;
  favoritedUrls?: Set<string>;
  onLoadMore?: () => void;
  canLoadMore?: boolean;
  isLoadingMore?: boolean;
  /** Extra action buttons for the top-right action bar (rendered leftmost). */
  renderActions?: (imageUrl: string) => React.ReactNode;
}

/** Image-only view of {@link MediaLightbox}. */
export function ImageLightbox({ images, getSource, ...props }: ImageLightboxProps) {
  const items = useMemo<LightboxMedia[]>(
    () => images.map((url) => ({ url, type: "image" as const })),
    [images],
  );

  if (getSource) return <GenerationLightbox items={items} getSource={getSource} {...props} />;
  return <MediaLightbox items={items} {...props} />;
}
