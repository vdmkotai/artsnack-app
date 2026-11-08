import { atlasMediaParams, type AtlasModel, type AtlasParam } from "./atlas-models";

/** Metadata both clients know after preparing an image for upload. */
export type ReferenceImageMetadata = {
  width?: number;
  height?: number;
  /** Fallback for references persisted before prepared dimensions were stored. */
  aspect?: number;
  bytes?: number;
};

export type AtlasReferenceIssue = {
  referenceIndex: number;
  paramName: string;
  code: "aspect" | "dimensions" | "file-size";
  message: string;
};

type ImageLimits = {
  minAspect?: number;
  maxAspect?: number;
  minSide?: number;
  maxSide?: number;
  maxBytes?: number;
  maxBytesExclusive?: boolean;
};

const ASPECT_VALUE = String.raw`(?:\d+(?:\.\d+)?(?::|\/)\d+(?:\.\d+)?|\d+(?:\.\d+)?)`;

function parseAspect(value: string): number | undefined {
  const parts = value.split(/[:/]/).map(Number);
  const ratio = parts.length === 2 ? parts[0] / parts[1] : parts[0];
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

function parseAspectLimits(description: string): Pick<ImageLimits, "minAspect" | "maxAspect"> {
  const patterns = [
    new RegExp(
      String.raw`aspect ratio(?:\s*\(W\/H\))?\s*(${ASPECT_VALUE})\s*[-~]\s*(${ASPECT_VALUE})`,
      "i",
    ),
    new RegExp(
      String.raw`aspect ratio(?:\s*\(W\/H\))?\s*(?:range\s*:\s*)?[\[(]\s*(${ASPECT_VALUE})\s*[,~\-]\s*(${ASPECT_VALUE})\s*[\])]`,
      "i",
    ),
    new RegExp(
      String.raw`aspect ratio[^.]{0,100}?between\s+(${ASPECT_VALUE})\s+(?:and|~)\s+(${ASPECT_VALUE})`,
      "i",
    ),
    new RegExp(
      String.raw`aspect ratio[^.]{0,100}?greater than\s+(${ASPECT_VALUE})\s+and\s+less than\s+(${ASPECT_VALUE})`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (!match) continue;
    const first = parseAspect(match[1]);
    const second = parseAspect(match[2]);
    if (first === undefined || second === undefined) continue;
    return { minAspect: Math.min(first, second), maxAspect: Math.max(first, second) };
  }
  const maximum = description.match(
    new RegExp(String.raw`aspect ratio\s*(?:<=|≤)\s*(${ASPECT_VALUE})`, "i"),
  );
  if (maximum) {
    const maxAspect = parseAspect(maximum[1]);
    if (maxAspect !== undefined) return { minAspect: 1 / maxAspect, maxAspect };
  }
  return {};
}

function parseDimensionLimits(description: string): Pick<ImageLimits, "minSide" | "maxSide"> {
  const rangePatterns = [
    /single edge\s+(\d+)\s*[-~]\s*(\d+)\s*px/i,
    /dimensions?\s*\(\s*(\d+)\s*[,~-]\s*(\d+)\s*\)\s*px/i,
    /width\s*\/\s*height\s+(\d+)\s*[-~]\s*(\d+)\s*px/i,
    /width and height[^.]{0,50}?between\s+(\d+)\s+and\s+(\d+)\s+pixels/i,
    /width and height[^.]{0,50}?range from\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/i,
  ];
  for (const pattern of rangePatterns) {
    const match = description.match(pattern);
    if (match) return { minSide: Number(match[1]), maxSide: Number(match[2]) };
  }

  const minimum =
    description.match(
      /(?:width and height|image resolution)[^.]{0,70}?no(?:t)? less than\s+(\d+)/i,
    ) ??
    description.match(/at least\s+(\d+)\s*px[^.]{0,25}shorter side/i) ??
    description.match(/short side pixels greater than\s+(\d+)\s*px/i);
  return minimum ? { minSide: Number(minimum[1]) } : {};
}

function parseFileSizeLimit(
  description: string,
): Pick<ImageLimits, "maxBytes" | "maxBytesExclusive"> {
  const match =
    description.match(
      /(?:max(?:imum)?(?: file)? size|(?:file )?size(?: limit)?|no larger than|no more than|cannot exceed|limited to)[^\d]{0,24}(\d+(?:\.\d+)?)\s*MB/i,
    ) ?? description.match(/(?:<=|≤)\s*(\d+(?:\.\d+)?)\s*MB/i);
  return match
    ? {
        maxBytes: Number(match[1]) * 1024 * 1024,
        maxBytesExclusive: /size\s*</i.test(match[0]),
      }
    : {};
}

function descriptionFor(model: AtlasModel, param: AtlasParam): string {
  const own = param.description ?? "";
  const inherited = own.match(
    /same (?:format )?(?:requirements|limits) as\s+[`'"]?([a-z_]+)[`'"]?/i,
  )?.[1];
  if (!inherited) return own;
  return `${model.params.find((candidate) => candidate.name === inherited)?.description ?? ""} ${own}`;
}

function limitsFor(model: AtlasModel, param: AtlasParam): ImageLimits {
  const description = descriptionFor(model, param);
  return {
    ...parseAspectLimits(description),
    ...parseDimensionLimits(description),
    ...parseFileSizeLimit(description),
  };
}

function mediaParamForIndex(model: AtlasModel, index: number): AtlasParam | undefined {
  let cursor = 0;
  for (const param of atlasMediaParams(model)) {
    const capacity = param.kind === "media" ? 1 : (param.maxImageItems ?? param.maxItems ?? 9);
    if (index >= cursor && index < cursor + capacity) return param;
    cursor += capacity;
  }
  return undefined;
}

function readableAspect(value: number): string {
  const rounded = (number: number) => Number(number.toFixed(2)).toString();
  return value >= 1 ? `${rounded(value)}:1` : `1:${rounded(1 / value)}`;
}

/**
 * Refuses model-specific input limits before a paid Atlas request is sent.
 *
 * The image stays attached. Callers use `referenceIndex` to mark its tile and
 * show the message beside the picker; changing models immediately re-runs the
 * check against the new endpoint's own documented limits.
 */
export function validateAtlasReferences(
  model: AtlasModel,
  references: readonly ReferenceImageMetadata[],
): AtlasReferenceIssue[] {
  const issues: AtlasReferenceIssue[] = [];

  references.forEach((reference, referenceIndex) => {
    const param = mediaParamForIndex(model, referenceIndex);
    if (!param) return;
    const limits = limitsFor(model, param);
    const aspect =
      reference.width && reference.height ? reference.width / reference.height : reference.aspect;

    if (
      aspect &&
      ((limits.minAspect !== undefined && aspect < limits.minAspect) ||
        (limits.maxAspect !== undefined && aspect > limits.maxAspect))
    ) {
      const direction =
        limits.maxAspect !== undefined && aspect > limits.maxAspect ? "wide" : "tall";
      const accepted =
        limits.minAspect !== undefined && limits.maxAspect !== undefined
          ? `${readableAspect(limits.minAspect)}–${readableAspect(limits.maxAspect)}`
          : "the documented aspect-ratio range";
      issues.push({
        referenceIndex,
        paramName: param.name,
        code: "aspect",
        message: `Reference ${referenceIndex + 1} is too ${direction} (${readableAspect(aspect)}). ${model.label} accepts ${accepted}. Crop it or choose another model; the image is still attached.`,
      });
    }

    if (reference.width && reference.height) {
      const short = Math.min(reference.width, reference.height);
      const long = Math.max(reference.width, reference.height);
      if (
        (limits.minSide !== undefined && short < limits.minSide) ||
        (limits.maxSide !== undefined && long > limits.maxSide)
      ) {
        const accepted = [
          limits.minSide !== undefined ? `at least ${limits.minSide}px per side` : null,
          limits.maxSide !== undefined ? `at most ${limits.maxSide}px per side` : null,
        ]
          .filter(Boolean)
          .join(" and ");
        issues.push({
          referenceIndex,
          paramName: param.name,
          code: "dimensions",
          message: `Reference ${referenceIndex + 1} is ${reference.width}×${reference.height}px. ${model.label} requires ${accepted}; the image is still attached.`,
        });
      }
    }

    if (
      reference.bytes &&
      limits.maxBytes !== undefined &&
      (limits.maxBytesExclusive
        ? reference.bytes >= limits.maxBytes
        : reference.bytes > limits.maxBytes)
    ) {
      const actualMb = Number((reference.bytes / 1024 / 1024).toFixed(1));
      const maxMb = Number((limits.maxBytes / 1024 / 1024).toFixed(1));
      issues.push({
        referenceIndex,
        paramName: param.name,
        code: "file-size",
        message: `Reference ${referenceIndex + 1} is ${actualMb}MB. ${model.label} accepts ${limits.maxBytesExclusive ? "under" : "up to"} ${maxMb}MB; compress it or choose another model. The image is still attached.`,
      });
    }
  });

  return issues;
}
