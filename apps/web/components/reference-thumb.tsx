"use client";

import { Download, ImagePlus } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { downloadMedia } from "@/lib/download-media";
import { mediaUrl, thumbUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";

/*
 * Split out of generation-details.tsx so the lightbox can show references
 * without importing the details panel. That panel reads model labels and prices
 * through `api/generation-meta`, which pulls in the generated Atlas catalogue — the
 * largest chunk in the app — and the lightbox is on every gallery page. The panel
 * is now loaded on demand (see generation-lightbox.tsx); nothing here may import
 * from it or from generation-meta, or the catalogue comes straight back.
 */

/** An input image of a generation, as the lightbox shows and opens it. */
export type Reference = {
  url: string;
  sourceKey?: string | null;
  thumbnail?: string;
  /** "First frame", "Picture 2"… — what the prompt and the form call it. */
  label?: string;
};

/**
 * The images a generation was given, labelled the way its form named them: an
 * H3 clip's frames and `<Picture N>` references, or an API job's references.
 */
export function generationReferences(generation: Doc<"grokGenerations">): Reference[] {
  const roles = generation.h3InputRoles;
  let picture = 0;
  return (generation.referenceB2Keys ?? []).map((key, index) => {
    const role = roles?.[index];
    return {
      url: mediaUrl(key),
      thumbnail: thumbUrl(key),
      sourceKey: generation.referenceSourceKeys?.[index],
      label:
        role === "first"
          ? "First frame"
          : role === "last"
            ? "Last frame"
            : role === "reference"
              ? `Picture ${++picture}`
              : `Reference ${index + 1}`,
    };
  });
}

function ThumbButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded-md border border-white/15 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/85 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

/**
 * One input image: click to open it full size (where every action is), or use
 * the two the grid offers straight from the thumbnail — attach it as a
 * reference, or download it. Hover-revealed on desktop, always on for touch.
 */
export function ReferenceThumb({
  reference,
  index,
  onOpen,
  onUse,
  className,
}: {
  reference: Reference;
  index: number;
  onOpen: (reference: Reference) => void;
  onUse: (url: string) => void;
  className?: string;
}) {
  const label = reference.label ?? `Reference ${index + 1}`;
  return (
    <div className={cn("group relative", className)}>
      <button
        type="button"
        aria-label={`Open ${label}`}
        onClick={() => onOpen(reference)}
        className="block w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <img
          src={reference.thumbnail ?? reference.url}
          alt={label}
          className="aspect-square w-full rounded-lg border border-white/10 object-cover transition-opacity group-hover:opacity-80"
        />
      </button>
      <div className="absolute top-1 right-1 flex gap-1 opacity-100 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
        <ThumbButton label="Use as reference" onClick={() => onUse(reference.url)}>
          <ImagePlus className="h-3 w-3" />
        </ThumbButton>
        <ThumbButton
          label="Download"
          onClick={() =>
            void downloadMedia({
              url: reference.url,
              type: "image",
              name: `artsnack-${label.toLowerCase().replace(/\s+/g, "-")}`,
            })
          }
        >
          <Download className="h-3 w-3" />
        </ThumbButton>
      </div>
      <span className="mt-1 block truncate text-xs text-white/50">{label}</span>
    </div>
  );
}
