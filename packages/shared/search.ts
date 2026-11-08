/**
 * One portable search contract for Convex, the web app and the native app.
 *
 * Search documents are generation-sized rather than asset-sized: a four-image
 * generation carries its prompt once, then expands to four results after it has
 * matched. This keeps the catalogue small without changing what the user sees.
 */

export type SearchMediaType = "image" | "video";
export type SearchSource = "self-hosted" | "api";
export type SearchProvider = "self-hosted" | "grok" | "fal" | "higgsfield" | "atlas" | "comfy";
export type SearchSort = "relevance" | "newest" | "oldest";
export type SearchLoraMode = "any" | "all";

export type SearchAsset = {
  id: string;
  key: string;
  thumbnailKey?: string;
};

export type SearchLocalSettings = {
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  batchSize: number;
  loras: Array<{
    enabled: boolean;
    loraName: string;
    strengthModel: number;
    strengthClip: number;
  }>;
};

export type SearchDocument = {
  id: string;
  source: SearchSource;
  provider: SearchProvider;
  mediaType: SearchMediaType;
  createdAt: number;
  prompt: string;
  negativePrompt?: string;
  assets: SearchAsset[];
  model?: string;
  modelLabel?: string;
  modelFamily?: string;
  checkpoints: string[];
  loras: string[];
  width?: number;
  height?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  duration?: number;
  hasReferences: boolean;
  sampler?: string;
  scheduler?: string;
  steps?: number;
  cfg?: number;
  seed?: number;
  parameters?: Record<string, string | number | boolean | string[]>;
  localSettings?: SearchLocalSettings;
};

export type SearchFilters = {
  mediaTypes: SearchMediaType[];
  sources: SearchSource[];
  providers: SearchProvider[];
  models: string[];
  modelFamilies: string[];
  checkpoints: string[];
  loras: string[];
  loraMode: SearchLoraMode;
  createdAfter?: number;
  createdBefore?: number;
  orientations: Array<"portrait" | "square" | "landscape">;
  resolutions: string[];
  qualities: string[];
  durationMin?: number;
  durationMax?: number;
  hasReferences?: boolean;
  samplers: string[];
  schedulers: string[];
  stepsMin?: number;
  stepsMax?: number;
  cfgMin?: number;
  cfgMax?: number;
  seed?: number;
  widthMin?: number;
  widthMax?: number;
  heightMin?: number;
  heightMax?: number;
  /** Atlas and future provider-specific parameter values, keyed by vendor name. */
  parameters: Record<string, string[]>;
};

export type SearchIntent = {
  query: string;
  negativePromptQuery: string;
  allowTypos: boolean;
  sort: SearchSort;
  filters: SearchFilters;
};

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  mediaTypes: [],
  sources: [],
  providers: [],
  models: [],
  modelFamilies: [],
  checkpoints: [],
  loras: [],
  loraMode: "any",
  orientations: [],
  resolutions: [],
  qualities: [],
  samplers: [],
  schedulers: [],
  parameters: {},
};

export const DEFAULT_SEARCH_INTENT: SearchIntent = {
  query: "",
  negativePromptQuery: "",
  allowTypos: false,
  sort: "relevance",
  filters: EMPTY_SEARCH_FILTERS,
};

export type SearchTerm = {
  value: string;
  quoted: boolean;
};

export type SearchGroup = {
  excluded: boolean;
  alternatives: SearchTerm[];
};

export type ParsedSearchQuery = {
  groups: SearchGroup[];
  required: string[];
  excluded: string[];
};

export type SearchParseResult =
  | { ok: true; query: ParsedSearchQuery }
  | { ok: false; error: string; at: number };

export type SearchMatchReason = {
  term: string;
  kind: "phrase" | "token" | "contains" | "fuzzy";
};

export type SearchResult = {
  id: string;
  document: SearchDocument;
  asset: SearchAsset;
  score: number;
  reasons: SearchMatchReason[];
};

/** Ordered, image-only reference selection shared by web and native search. */
export const MAX_SEARCH_REFERENCES = 30;

export function toggleSearchReference(
  current: SearchResult[],
  result: SearchResult,
  limit = MAX_SEARCH_REFERENCES,
): SearchResult[] {
  const exists = current.some((entry) => entry.id === result.id);
  if (exists) return current.filter((entry) => entry.id !== result.id);
  if (result.document.mediaType !== "image" || current.length >= limit) return current;
  return [...current, result];
}

export function reorderSearchReferences(
  current: SearchResult[],
  from: number,
  to: number,
): SearchResult[] {
  if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) {
    return current;
  }
  const next = [...current];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

export type SearchFacetValue = { value: string; count: number };
export type SearchFacets = {
  mediaTypes: SearchFacetValue[];
  sources: SearchFacetValue[];
  providers: SearchFacetValue[];
  models: SearchFacetValue[];
  modelFamilies: SearchFacetValue[];
  checkpoints: SearchFacetValue[];
  loras: SearchFacetValue[];
  resolutions: SearchFacetValue[];
  qualities: SearchFacetValue[];
  samplers: SearchFacetValue[];
  schedulers: SearchFacetValue[];
  parameters: Record<string, SearchFacetValue[]>;
};

export type SearchOutput = {
  results: SearchResult[];
  documents: SearchDocument[];
  facets: SearchFacets;
  parsed: ParsedSearchQuery;
};

const EMPTY_PARSED: ParsedSearchQuery = { groups: [], required: [], excluded: [] };
const WORD = /[\p{L}\p{N}]/u;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Small, explicit query language:
 *   dog beach           AND
 *   dog|fox beach      OR inside one requirement
 *   -scarf              broad exclusion
 *   "dog"               exact token
 *   "red dress"         exact phrase
 *
 * Parentheses are intentionally rejected. Silently interpreting a malformed
 * query is worse than showing the user exactly where it stopped making sense.
 */
export function parseSearchQuery(input: string): SearchParseResult {
  const groups: SearchGroup[] = [];
  let index = 0;

  const skipSeparators = () => {
    while (index < input.length && (input[index] === "," || /\s/.test(input[index]))) index += 1;
  };

  skipSeparators();
  while (index < input.length) {
    const start = index;
    let excluded = false;
    if (input[index] === "-") {
      excluded = true;
      index += 1;
      if (index >= input.length || input[index] === "," || /\s/.test(input[index])) {
        return { ok: false, error: "Add a word or quoted phrase after ‘-’.", at: start };
      }
    }

    const alternatives: SearchTerm[] = [];
    while (true) {
      if (input[index] === "-") {
        return {
          ok: false,
          error: "Put ‘-’ before the whole excluded expression, not after ‘|’.",
          at: index,
        };
      }

      let quoted = false;
      let raw = "";
      if (input[index] === '"') {
        quoted = true;
        index += 1;
        const quoteStart = index - 1;
        while (index < input.length && input[index] !== '"') {
          raw += input[index];
          index += 1;
        }
        if (index >= input.length) {
          return {
            ok: false,
            error: "Close the quoted phrase with another quote.",
            at: quoteStart,
          };
        }
        index += 1;
      } else {
        const valueStart = index;
        while (
          index < input.length &&
          input[index] !== "|" &&
          input[index] !== "," &&
          !/\s/.test(input[index])
        ) {
          if (input[index] === '"') {
            return { ok: false, error: "A quote must start a new term.", at: index };
          }
          if (input[index] === "(" || input[index] === ")") {
            return {
              ok: false,
              error: "Parentheses are not supported. Use ‘|’ for alternatives.",
              at: index,
            };
          }
          raw += input[index];
          index += 1;
        }
        if (index === valueStart) {
          return { ok: false, error: "Expected a search term.", at: index };
        }
      }

      const value = normalizeSearchText(raw);
      if (!value || ![...value].some((character) => WORD.test(character))) {
        return { ok: false, error: "A search term must contain a letter or number.", at: start };
      }
      alternatives.push({ value, quoted });

      if (input[index] !== "|") break;
      index += 1;
      if (
        index >= input.length ||
        input[index] === "," ||
        input[index] === "|" ||
        /\s/.test(input[index])
      ) {
        return { ok: false, error: "Add an alternative after ‘|’.", at: index };
      }
    }

    groups.push({ excluded, alternatives });
    skipSeparators();
  }

  const describe = (group: SearchGroup) =>
    group.alternatives.map((term) => (term.quoted ? `“${term.value}”` : term.value)).join(" OR ");
  return {
    ok: true,
    query: {
      groups,
      required: groups.filter((group) => !group.excluded).map(describe),
      excluded: groups.filter((group) => group.excluded).map(describe),
    },
  };
}

type IndexedText = { normalized: string; tokens: string[]; tokenSet: Set<string> };
const promptCache = new WeakMap<SearchDocument, IndexedText>();
const negativeCache = new WeakMap<SearchDocument, IndexedText>();

function indexedText(document: SearchDocument, negative = false): IndexedText {
  const cache = negative ? negativeCache : promptCache;
  const cached = cache.get(document);
  if (cached) return cached;
  const normalized = normalizeSearchText(
    negative ? (document.negativePrompt ?? "") : document.prompt,
  );
  const tokens = normalized ? normalized.split(" ") : [];
  const indexed = { normalized, tokens, tokenSet: new Set(tokens) };
  cache.set(document, indexed);
  return indexed;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let short = left;
  let long = right;
  if (short.length > long.length) [short, long] = [long, short];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (short.length === long.length) i += 1;
    j += 1;
  }
  if (i < short.length || j < long.length) edits += 1;
  return edits <= 1;
}

function termMatch(
  text: IndexedText,
  term: SearchTerm,
  allowTypos: boolean,
): { score: number; reason: SearchMatchReason } | null {
  const phrase = term.value.includes(" ");
  if (term.quoted) {
    if (phrase && text.normalized.includes(term.value)) {
      return { score: 400, reason: { term: term.value, kind: "phrase" } };
    }
    if (!phrase && text.tokenSet.has(term.value)) {
      return { score: 300, reason: { term: term.value, kind: "token" } };
    }
    return null;
  }

  if (text.tokenSet.has(term.value)) {
    return { score: 300, reason: { term: term.value, kind: "token" } };
  }
  if (text.normalized.includes(term.value)) {
    return { score: 200, reason: { term: term.value, kind: "contains" } };
  }
  if (allowTypos && term.value.length >= 5) {
    for (const token of text.tokens) {
      if (editDistanceAtMostOne(term.value, token)) {
        return { score: 100, reason: { term: term.value, kind: "fuzzy" } };
      }
    }
  }
  return null;
}

function matchParsed(
  text: IndexedText,
  parsed: ParsedSearchQuery,
  allowTypos: boolean,
): { score: number; reasons: SearchMatchReason[] } | null {
  let score = 0;
  const reasons: SearchMatchReason[] = [];
  // Runs once per document per keystroke, so no intermediate arrays: the best
  // alternative is the first one with the highest score, exactly what a stable
  // sort of all matches used to pick.
  for (const group of parsed.groups) {
    let best: { score: number; reason: SearchMatchReason } | null = null;
    for (const term of group.alternatives) {
      const match = termMatch(text, term, group.excluded ? false : allowTypos);
      if (!match) continue;
      if (group.excluded) return null;
      if (!best || match.score > best.score) best = match;
    }
    if (group.excluded) continue;
    if (!best) return null;
    score += best.score;
    reasons.push(best.reason);
  }
  return { score, reasons };
}

function includesAny<T extends string>(selected: readonly T[], value: T): boolean {
  return selected.length === 0 || selected.includes(value);
}

function includesOverlap(selected: readonly string[], values: readonly string[]): boolean {
  return selected.length === 0 || selected.some((value) => values.includes(value));
}

function orientationOf(document: SearchDocument): "portrait" | "square" | "landscape" | null {
  let ratio: number | null = null;
  if (document.width && document.height) ratio = document.width / document.height;
  if (ratio === null && document.aspectRatio) {
    const [width, height] = document.aspectRatio.split(":").map(Number);
    if (width > 0 && height > 0) ratio = width / height;
  }
  if (ratio === null) return null;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
}

export function matchesSearchFilters(document: SearchDocument, filters: SearchFilters): boolean {
  if (!includesAny(filters.mediaTypes, document.mediaType)) return false;
  if (!includesAny(filters.sources, document.source)) return false;
  if (!includesAny(filters.providers, document.provider)) return false;
  if (filters.models.length > 0 && (!document.model || !filters.models.includes(document.model))) {
    return false;
  }
  if (
    filters.modelFamilies.length > 0 &&
    (!document.modelFamily || !filters.modelFamilies.includes(document.modelFamily))
  ) {
    return false;
  }
  if (!includesOverlap(filters.checkpoints, document.checkpoints)) return false;
  if (filters.loras.length > 0) {
    const matches = filters.loras.filter((lora) => document.loras.includes(lora)).length;
    if (filters.loraMode === "all" ? matches !== filters.loras.length : matches === 0) return false;
  }
  if (filters.createdAfter !== undefined && document.createdAt < filters.createdAfter) return false;
  if (filters.createdBefore !== undefined && document.createdAt > filters.createdBefore)
    return false;
  if (filters.orientations.length > 0) {
    const orientation = orientationOf(document);
    if (!orientation || !filters.orientations.includes(orientation)) return false;
  }
  if (
    filters.resolutions.length > 0 &&
    (!document.resolution || !filters.resolutions.includes(document.resolution))
  ) {
    return false;
  }
  if (
    filters.qualities.length > 0 &&
    (!document.quality || !filters.qualities.includes(document.quality))
  ) {
    return false;
  }
  if (filters.durationMin !== undefined && (document.duration ?? -Infinity) < filters.durationMin) {
    return false;
  }
  if (filters.durationMax !== undefined && (document.duration ?? Infinity) > filters.durationMax) {
    return false;
  }
  if (filters.hasReferences !== undefined && document.hasReferences !== filters.hasReferences) {
    return false;
  }
  if (
    filters.samplers.length > 0 &&
    (!document.sampler || !filters.samplers.includes(document.sampler))
  ) {
    return false;
  }
  if (
    filters.schedulers.length > 0 &&
    (!document.scheduler || !filters.schedulers.includes(document.scheduler))
  ) {
    return false;
  }
  if (filters.stepsMin !== undefined && (document.steps ?? -Infinity) < filters.stepsMin)
    return false;
  if (filters.stepsMax !== undefined && (document.steps ?? Infinity) > filters.stepsMax)
    return false;
  if (filters.cfgMin !== undefined && (document.cfg ?? -Infinity) < filters.cfgMin) return false;
  if (filters.cfgMax !== undefined && (document.cfg ?? Infinity) > filters.cfgMax) return false;
  if (filters.seed !== undefined && document.seed !== filters.seed) return false;
  if (filters.widthMin !== undefined && (document.width ?? -Infinity) < filters.widthMin)
    return false;
  if (filters.widthMax !== undefined && (document.width ?? Infinity) > filters.widthMax)
    return false;
  if (filters.heightMin !== undefined && (document.height ?? -Infinity) < filters.heightMin)
    return false;
  if (filters.heightMax !== undefined && (document.height ?? Infinity) > filters.heightMax)
    return false;
  for (const [name, selected] of Object.entries(filters.parameters)) {
    if (selected.length === 0) continue;
    const raw = document.parameters?.[name];
    const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
    if (!selected.some((value) => values.includes(value))) return false;
  }
  return true;
}

/**
 * Provider parameters that are free text or media, never a filter value. Every
 * client already hides them from its filter UI by name; counting them anyway
 * meant one facet entry per prompt in the history, so they are not collected.
 * Filtering by them still works — `matchesSearchFilters` reads the document.
 */
export const NON_FACET_SEARCH_PARAMETERS: ReadonlySet<string> = new Set([
  "prompt",
  "image",
  "images",
  "video",
  "url",
]);

// Same ordering as `localeCompare` with no arguments, without resolving the
// default locale again for every comparison of a sort.
const facetCollator = new Intl.Collator();

function countFacet(counts: Map<string, number>, value: string | undefined) {
  if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
}

function sortedFacet(counts: Map<string, number>): SearchFacetValue[] {
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (left, right) => right.count - left.count || facetCollator.compare(left.value, right.value),
    );
}

function facet(values: Array<string | undefined>): SearchFacetValue[] {
  const counts = new Map<string, number>();
  for (const value of values) countFacet(counts, value);
  return sortedFacet(counts);
}

/**
 * Counts every provider parameter value across documents, by parameter name.
 *
 * Counted in place: this used to re-copy a parameter's whole accumulated value
 * list for every document (`[...previous, ...values]`), which made facets
 * quadratic in the history size — 10,000 Atlas generations spent hundreds of
 * milliseconds here on every catalogue change.
 */
export function collectParameterFacets(
  documents: readonly SearchDocument[],
): Record<string, SearchFacetValue[]> {
  const parameterCounts = new Map<string, Map<string, number>>();
  for (const document of documents) {
    const parameters = document.parameters;
    if (!parameters) continue;
    for (const name in parameters) {
      if (NON_FACET_SEARCH_PARAMETERS.has(name)) continue;
      const raw = parameters[name];
      if (raw === undefined) continue;
      let counts = parameterCounts.get(name);
      if (!counts) {
        counts = new Map();
        parameterCounts.set(name, counts);
      }
      if (Array.isArray(raw)) for (const value of raw) countFacet(counts, String(value));
      else countFacet(counts, String(raw));
    }
  }
  const facets: Record<string, SearchFacetValue[]> = {};
  for (const [name, counts] of parameterCounts) facets[name] = sortedFacet(counts);
  return facets;
}

export function buildSearchFacets(documents: SearchDocument[]): SearchFacets {
  return {
    mediaTypes: facet(documents.map((document) => document.mediaType)),
    sources: facet(documents.map((document) => document.source)),
    providers: facet(documents.map((document) => document.provider)),
    models: facet(documents.map((document) => document.model)),
    modelFamilies: facet(documents.map((document) => document.modelFamily)),
    checkpoints: facet(documents.flatMap((document) => document.checkpoints)),
    loras: facet(documents.flatMap((document) => document.loras)),
    resolutions: facet(documents.map((document) => document.resolution)),
    qualities: facet(documents.map((document) => document.quality)),
    samplers: facet(documents.map((document) => document.sampler)),
    schedulers: facet(documents.map((document) => document.scheduler)),
    parameters: collectParameterFacets(documents),
  };
}

export function searchDocuments(
  documents: SearchDocument[],
  intent: SearchIntent,
): SearchOutput | SearchParseResult {
  const positive = parseSearchQuery(intent.query);
  if (!positive.ok) return positive;
  const negative = parseSearchQuery(intent.negativePromptQuery);
  if (!negative.ok) return negative;

  const textMatches: Array<{
    document: SearchDocument;
    score: number;
    reasons: SearchMatchReason[];
  }> = [];
  for (const document of documents) {
    if (document.assets.length === 0) continue;
    const promptMatch = matchParsed(indexedText(document), positive.query, intent.allowTypos);
    if (!promptMatch) continue;
    if (negative.query.groups.length > 0) {
      const negativeMatch = matchParsed(indexedText(document, true), negative.query, false);
      if (!negativeMatch) continue;
    }
    textMatches.push({ document, ...promptMatch });
  }

  const facets = buildSearchFacets(textMatches.map((match) => match.document));
  const filtered = textMatches.filter(({ document }) =>
    matchesSearchFilters(document, intent.filters),
  );
  filtered.sort((left, right) => {
    if (intent.sort === "oldest") return left.document.createdAt - right.document.createdAt;
    if (intent.sort === "newest") return right.document.createdAt - left.document.createdAt;
    return right.score - left.score || right.document.createdAt - left.document.createdAt;
  });

  const results = filtered.flatMap(({ document, score, reasons }) =>
    document.assets.map((asset) => ({
      id: `${document.id}:${asset.id}`,
      document,
      asset,
      score,
      reasons,
    })),
  );
  return {
    results,
    documents: filtered.map((match) => match.document),
    facets,
    parsed: positive.query,
  };
}

/**
 * How many media `searchDocuments` would return for this intent, without the
 * facets, sorting and per-asset expansion it would also build. The filter
 * drawer asks this for every draft change; a malformed query counts as 0.
 */
export function countSearchMatches(
  documents: readonly SearchDocument[],
  intent: SearchIntent,
): number {
  const positive = parseSearchQuery(intent.query);
  if (!positive.ok) return 0;
  const negative = parseSearchQuery(intent.negativePromptQuery);
  if (!negative.ok) return 0;
  let count = 0;
  for (const document of documents) {
    if (document.assets.length === 0) continue;
    if (!matchesSearchFilters(document, intent.filters)) continue;
    if (!matchParsed(indexedText(document), positive.query, intent.allowTypos)) continue;
    if (
      negative.query.groups.length > 0 &&
      !matchParsed(indexedText(document, true), negative.query, false)
    ) {
      continue;
    }
    count += document.assets.length;
  }
  return count;
}

/** The message a malformed positive or negative query reports, or null. */
export function searchIntentError(intent: SearchIntent): string | null {
  const positive = parseSearchQuery(intent.query);
  if (!positive.ok) return positive.error;
  const negative = parseSearchQuery(intent.negativePromptQuery);
  return negative.ok ? null : negative.error;
}

function sameReasons(left: SearchMatchReason[], right: SearchMatchReason[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].term !== right[index].term || left[index].kind !== right[index].kind) {
      return false;
    }
  }
  return true;
}

/**
 * Reuses the previous result object for every result whose document, asset,
 * score and match reasons are unchanged, and the previous array when nothing
 * changed at all.
 *
 * `searchDocuments` builds fresh result objects on every call, so without this
 * a memoised tile can never bail out: one finished generation re-rendered every
 * tile on screen. It only preserves identity when the caller also keeps
 * document identity stable — a catalogue that rebuilds every document object
 * gets fresh results, which is merely slower, never wrong.
 */
export function stabilizeSearchResults(
  previous: readonly SearchResult[],
  next: SearchResult[],
): SearchResult[] {
  if (previous.length === 0) return next;
  const known = new Map<string, SearchResult>();
  for (const result of previous) known.set(result.id, result);
  let unchanged = previous.length === next.length;
  const stable = next.map((result, index) => {
    const before = known.get(result.id);
    const kept =
      before &&
      before.document === result.document &&
      before.asset === result.asset &&
      before.score === result.score &&
      sameReasons(before.reasons, result.reasons)
        ? before
        : result;
    if (unchanged && previous[index] !== kept) unchanged = false;
    return kept;
  });
  return unchanged ? (previous as SearchResult[]) : stable;
}

export function countActiveSearchFilters(filters: SearchFilters): number {
  let count = 0;
  for (const value of Object.values(filters)) {
    if (Array.isArray(value)) count += value.length > 0 ? 1 : 0;
    else if (value && typeof value === "object") {
      count += Object.values(value).some((entry) => Array.isArray(entry) && entry.length > 0)
        ? 1
        : 0;
    } else if (value !== undefined && value !== "any") count += 1;
  }
  return count;
}

export function serializeSearchIntent(intent: SearchIntent): string {
  const params = new URLSearchParams();
  if (intent.query) params.set("q", intent.query);
  if (intent.negativePromptQuery) params.set("negative", intent.negativePromptQuery);
  if (intent.allowTypos) params.set("typos", "1");
  if (intent.sort !== "relevance") params.set("sort", intent.sort);
  if (countActiveSearchFilters(intent.filters) > 0)
    params.set("filters", JSON.stringify(intent.filters));
  return params.toString();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSearchFilters(value: unknown): SearchFilters {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const only = <T extends string>(value: unknown, allowed: readonly T[]): T[] =>
    stringList(value).filter((entry): entry is T => allowed.includes(entry as T));
  const parameters: Record<string, string[]> = {};
  if (raw.parameters && typeof raw.parameters === "object" && !Array.isArray(raw.parameters)) {
    for (const [name, selected] of Object.entries(raw.parameters)) {
      const values = stringList(selected);
      if (values.length > 0) parameters[name] = values;
    }
  }
  const filters: SearchFilters = {
    mediaTypes: only(raw.mediaTypes, ["image", "video"]),
    sources: only(raw.sources, ["self-hosted", "api"]),
    providers: only(raw.providers, ["self-hosted", "grok", "fal", "higgsfield", "atlas", "comfy"]),
    models: stringList(raw.models),
    modelFamilies: stringList(raw.modelFamilies),
    checkpoints: stringList(raw.checkpoints),
    loras: stringList(raw.loras),
    loraMode: raw.loraMode === "all" ? "all" : "any",
    orientations: only(raw.orientations, ["portrait", "square", "landscape"]),
    resolutions: stringList(raw.resolutions),
    qualities: stringList(raw.qualities),
    samplers: stringList(raw.samplers),
    schedulers: stringList(raw.schedulers),
    parameters,
  };
  const numericKeys = [
    "createdAfter",
    "createdBefore",
    "durationMin",
    "durationMax",
    "stepsMin",
    "stepsMax",
    "cfgMin",
    "cfgMax",
    "seed",
    "widthMin",
    "widthMax",
    "heightMin",
    "heightMax",
  ] as const;
  for (const key of numericKeys) {
    const value = finiteNumber(raw[key]);
    if (value !== undefined) filters[key] = value;
  }
  if (typeof raw.hasReferences === "boolean") filters.hasReferences = raw.hasReferences;
  return filters;
}

export function deserializeSearchIntent(value: string | URLSearchParams): SearchIntent {
  const params = typeof value === "string" ? new URLSearchParams(value) : value;
  let filters = EMPTY_SEARCH_FILTERS;
  const encoded = params.get("filters");
  if (encoded) {
    try {
      filters = normalizeSearchFilters(JSON.parse(encoded));
    } catch {
      // A hand-edited or old link opens with safe defaults instead of crashing.
    }
  }
  const sort = params.get("sort");
  return {
    query: params.get("q") ?? "",
    negativePromptQuery: params.get("negative") ?? "",
    allowTypos: params.get("typos") === "1",
    sort: sort === "newest" || sort === "oldest" ? sort : "relevance",
    filters,
  };
}

export function emptySearchOutput(): SearchOutput {
  return { results: [], documents: [], facets: buildSearchFacets([]), parsed: EMPTY_PARSED };
}

export function resolveSearchOutput(
  documents: SearchDocument[],
  intent: SearchIntent,
  lastValid: SearchOutput = emptySearchOutput(),
): { output: SearchOutput; syntaxError: string | null; lastValid: SearchOutput } {
  const computed = searchDocuments(documents, intent);
  if ("results" in computed) {
    return { output: computed, syntaxError: null, lastValid: computed };
  }
  return { output: lastValid, syntaxError: computed.ok ? null : computed.error, lastValid };
}

export function sameSearchIntent(left: SearchIntent, right: SearchIntent): boolean {
  return serializeSearchIntent(left) === serializeSearchIntent(right);
}

export function parseSearchHistory(raw: string | null | undefined, limit = 20): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

export function addSearchHistory(previous: string[], query: string, limit = 20): string[] {
  return [query, ...previous.filter((entry) => entry !== query)].slice(0, limit);
}
