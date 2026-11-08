/** A reference image attached in the API tab, before it is uploaded. */
export type RefImage = {
  id: string;
  blob: Blob;
  previewUrl: string;
  /** Original address retained when attaching from app history or a URL. */
  sourceUrl?: string;
  /** Source aspect ratio — resolves an "auto" output ratio. */
  aspect: number;
  /** Prepared dimensions, which are what the provider validates. */
  width?: number;
  height?: number;
  /** Lazily derived down-scale for Grok's much tighter input limits. */
  grokBlob?: Blob;
  /** The same, cropped to a Grok clip's ratio — for a pinned frame. */
  grokCrop?: { ratio: string; blob: Blob };
  selected: boolean;
};
