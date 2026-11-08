"use client";

import { usePaginatedQuery as useCachedPaginatedQuery } from "@/lib/convex-cache";

import { api } from "@/convex/_generated/api";
import { GenerationGallery } from "@/components/generation-gallery";

const INITIAL_PAGE_SIZE = 15;

export default function GalleryPage() {
  const generations = useCachedPaginatedQuery(
    api.generations.listPaginated,
    {},
    { initialNumItems: INITIAL_PAGE_SIZE },
  );

  return (
    <GenerationGallery
      generations={generations.results}
      status={generations.status}
      loadMore={generations.loadMore}
      title="Gallery"
      emptyTitle="No images yet"
      emptyDescription="Generate some images to see them appear in your gallery."
      imageAltPrefix="Gallery image"
    />
  );
}
