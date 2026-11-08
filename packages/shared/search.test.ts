import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_SEARCH_INTENT,
  addSearchHistory,
  buildSearchFacets,
  collectParameterFacets,
  countActiveSearchFilters,
  countSearchMatches,
  deserializeSearchIntent,
  normalizeSearchText,
  parseSearchHistory,
  parseSearchQuery,
  reorderSearchReferences,
  resolveSearchOutput,
  sameSearchIntent,
  searchDocuments,
  searchIntentError,
  serializeSearchIntent,
  stabilizeSearchResults,
  toggleSearchReference,
  type SearchDocument,
  type SearchIntent,
} from "./search";

const base: SearchDocument = {
  id: "one",
  source: "self-hosted",
  provider: "self-hosted",
  mediaType: "image",
  createdAt: 1,
  prompt: "2dogs, on_beach, red silkscarf",
  negativePrompt: "blurry, bad hands",
  assets: [{ id: "asset", key: "image.png" }],
  checkpoints: ["sdxl_base.safetensors"],
  loras: ["Details", "Lighting"],
  hasReferences: false,
};

function run(
  query: string,
  patch: Omit<Partial<SearchIntent>, "filters"> & {
    filters?: Partial<SearchIntent["filters"]>;
  } = {},
) {
  return searchDocuments([base], {
    ...DEFAULT_SEARCH_INTENT,
    ...patch,
    query,
    filters: { ...DEFAULT_SEARCH_INTENT.filters, ...patch.filters },
  });
}

function resultCount(value: ReturnType<typeof run>): number {
  return "results" in value ? value.results.length : -1;
}

describe("search query grammar", () => {
  test("supports broad contains, exact tokens, phrases, exclusions and OR", () => {
    assert.equal(resultCount(run("dog, beach")), 1);
    assert.equal(resultCount(run('"dog"')), 0);
    assert.equal(resultCount(run('"2dogs"')), 1);
    assert.equal(resultCount(run('"on beach"')), 1);
    assert.equal(resultCount(run("dog, beach, -scarf")), 0);
    assert.equal(resultCount(run('dog, -"scarf"')), 1);
    assert.equal(resultCount(run("fox|dog, beach")), 1);
  });

  test("reports malformed syntax instead of guessing", () => {
    assert.deepEqual(parseSearchQuery('dog, "beach'), {
      ok: false,
      error: "Close the quoted phrase with another quote.",
      at: 5,
    });
    assert.equal(parseSearchQuery("dog|").ok, false);
    assert.equal(parseSearchQuery("(dog|fox)").ok, false);
  });

  test("fuzzy matching is opt-in, positive-only, and length limited", () => {
    assert.equal(resultCount(run("bech", { allowTypos: true })), 0);
    assert.equal(resultCount(run("beahc", { allowTypos: true })), 0);
    assert.equal(resultCount(run("beacg", { allowTypos: true })), 1);
    assert.equal(resultCount(run('"beacg"', { allowTypos: true })), 0);
  });

  test("searches negative prompts only through their explicit field", () => {
    assert.equal(resultCount(run("blurry")), 0);
    assert.equal(resultCount(run("dog", { negativePromptQuery: "blurry" })), 1);
    assert.equal(resultCount(run("dog", { negativePromptQuery: "sharp" })), 0);
  });
});

describe("search filtering and persistence", () => {
  test("supports LoRA any/all and historical checkpoint values", () => {
    const any = run("", { filters: { loras: ["Details", "Missing"], loraMode: "any" } });
    const all = run("", { filters: { loras: ["Details", "Missing"], loraMode: "all" } });
    const checkpoint = run("", { filters: { checkpoints: ["sdxl_base.safetensors"] } });
    assert.equal("results" in any && any.results.length, 1);
    assert.equal("results" in all && all.results.length, 0);
    assert.equal("results" in checkpoint && checkpoint.results.length, 1);
  });

  test("round-trips a search intent through a URL", () => {
    const intent: SearchIntent = {
      ...DEFAULT_SEARCH_INTENT,
      query: 'dog|fox, beach, -"scarf"',
      allowTypos: true,
      sort: "oldest",
      filters: {
        ...DEFAULT_SEARCH_INTENT.filters,
        providers: ["atlas"],
        loras: ["Details"],
        loraMode: "all",
        parameters: { motion: ["high"] },
      },
    };
    assert.deepEqual(deserializeSearchIntent(serializeSearchIntent(intent)), intent);
  });

  test("sanitizes hand-edited and stale filter payloads", () => {
    const params = new URLSearchParams({
      filters: JSON.stringify({
        mediaTypes: null,
        providers: ["atlas", "not-a-provider", 123],
        loraMode: "invalid",
        stepsMin: "20",
        parameters: { motion: "high", quality: ["pro", false] },
      }),
    });
    assert.deepEqual(deserializeSearchIntent(params).filters, {
      ...DEFAULT_SEARCH_INTENT.filters,
      providers: ["atlas"],
      parameters: { quality: ["pro"] },
    });
  });

  test("ranks exact tokens above broad contains and uses recency only as a tie-breaker", () => {
    const documents: SearchDocument[] = [
      { ...base, id: "new-contains", createdAt: 30, prompt: "2dogs" },
      { ...base, id: "old-exact", createdAt: 10, prompt: "dog" },
      { ...base, id: "new-exact", createdAt: 20, prompt: "dog" },
    ];
    const output = searchDocuments(documents, { ...DEFAULT_SEARCH_INTENT, query: "dog" });
    assert.ok("results" in output);
    assert.deepEqual(
      output.results.map((result) => result.document.id),
      ["new-exact", "old-exact", "new-contains"],
    );
  });

  test("filters provider parameters and expands a matching generation into every asset", () => {
    const api: SearchDocument = {
      ...base,
      id: "atlas-video",
      source: "api",
      provider: "atlas",
      mediaType: "video",
      prompt: "dog walking on beach",
      assets: [
        { id: "a", key: "a.mp4" },
        { id: "b", key: "b.mp4" },
      ],
      model: "wan",
      checkpoints: [],
      loras: [],
      duration: 10,
      hasReferences: true,
      parameters: { motion: "high", camera: ["pan", "zoom"] },
    };
    const output = searchDocuments([base, api], {
      ...DEFAULT_SEARCH_INTENT,
      query: "beach",
      filters: {
        ...DEFAULT_SEARCH_INTENT.filters,
        mediaTypes: ["video"],
        providers: ["atlas"],
        durationMin: 8,
        hasReferences: true,
        parameters: { motion: ["high"], camera: ["zoom"] },
      },
    });
    assert.ok("results" in output);
    assert.equal(output.documents.length, 1);
    assert.deepEqual(
      output.results.map((result) => result.asset.id),
      ["a", "b"],
    );
  });

  test("covers the complete scalar and facet filter matrix at inclusive boundaries", () => {
    const rich: SearchDocument = {
      ...base,
      source: "api",
      provider: "atlas",
      mediaType: "video",
      createdAt: 1_000,
      model: "wan-2.7",
      modelFamily: "WAN",
      checkpoints: ["high.safetensors", "low.safetensors"],
      loras: ["motion.safetensors"],
      width: 1920,
      height: 1080,
      resolution: "1080p",
      quality: "pro",
      duration: 10,
      hasReferences: true,
      sampler: "euler",
      scheduler: "normal",
      steps: 30,
      cfg: 7.5,
      seed: 42,
      parameters: { motion: "high" },
    };
    const filters: SearchIntent["filters"] = {
      mediaTypes: ["video"],
      sources: ["api"],
      providers: ["atlas"],
      models: ["wan-2.7"],
      modelFamilies: ["WAN"],
      checkpoints: ["low.safetensors"],
      loras: ["motion.safetensors"],
      loraMode: "all",
      createdAfter: 1_000,
      createdBefore: 1_000,
      orientations: ["landscape"],
      resolutions: ["1080p"],
      qualities: ["pro"],
      durationMin: 10,
      durationMax: 10,
      hasReferences: true,
      samplers: ["euler"],
      schedulers: ["normal"],
      stepsMin: 30,
      stepsMax: 30,
      cfgMin: 7.5,
      cfgMax: 7.5,
      seed: 42,
      widthMin: 1920,
      widthMax: 1920,
      heightMin: 1080,
      heightMax: 1080,
      parameters: { motion: ["high"] },
    };
    const matching = searchDocuments([rich], { ...DEFAULT_SEARCH_INTENT, filters });
    const outsideBoundary = searchDocuments([rich], {
      ...DEFAULT_SEARCH_INTENT,
      filters: { ...filters, stepsMin: 31 },
    });
    assert.equal("results" in matching && matching.results.length, 1);
    assert.equal("results" in outsideBoundary && outsideBoundary.results.length, 0);
  });

  test("builds generation-level facets and counts grouped active filters", () => {
    const facets = buildSearchFacets([
      base,
      { ...base, id: "two", provider: "atlas", loras: ["Details"], model: "wan" },
    ]);
    assert.deepEqual(facets.providers, [
      { value: "atlas", count: 1 },
      { value: "self-hosted", count: 1 },
    ]);
    assert.deepEqual(facets.loras, [
      { value: "Details", count: 2 },
      { value: "Lighting", count: 1 },
    ]);
    assert.equal(
      countActiveSearchFilters({
        ...DEFAULT_SEARCH_INTENT.filters,
        providers: ["atlas"],
        stepsMin: 20,
        hasReferences: false,
        parameters: { motion: ["high"] },
      }),
      4,
    );
  });

  test("normalizes Unicode compatibility forms and ignores empty-asset documents", () => {
    assert.equal(normalizeSearchText("Ｄｏｇ_on-BEACH!!!"), "dog on beach");
    const output = searchDocuments([{ ...base, assets: [] }], DEFAULT_SEARCH_INTENT);
    assert.ok("results" in output);
    assert.equal(output.results.length, 0);
  });

  test("supports explicit newest and oldest ordering", () => {
    const older = { ...base, id: "older", createdAt: 1 };
    const newer = { ...base, id: "newer", createdAt: 2 };
    const newest = searchDocuments([older, newer], {
      ...DEFAULT_SEARCH_INTENT,
      sort: "newest",
    });
    const oldest = searchDocuments([newer, older], {
      ...DEFAULT_SEARCH_INTENT,
      sort: "oldest",
    });
    assert.ok("results" in newest && "results" in oldest);
    assert.deepEqual(
      newest.results.map((result) => result.document.id),
      ["newer", "older"],
    );
    assert.deepEqual(
      oldest.results.map((result) => result.document.id),
      ["older", "newer"],
    );
  });

  test("keeps ordered image references, enforces capacity, and rejects videos", () => {
    const result = (id: string, mediaType: "image" | "video" = "image") => ({
      id,
      document: { ...base, id, mediaType },
      asset: base.assets[0],
      score: 0,
      reasons: [],
    });
    const first = result("first");
    const second = result("second");
    assert.deepEqual(toggleSearchReference([], result("video", "video")), []);
    assert.deepEqual(toggleSearchReference([first], second, 1), [first]);
    assert.deepEqual(toggleSearchReference([first], first), []);
    const thirty = Array.from({ length: 30 }, (_, index) => result(`ref-${index}`));
    assert.equal(toggleSearchReference(thirty.slice(0, 29), thirty[29]).length, 30);
    assert.equal(toggleSearchReference(thirty, result("ref-30")).length, 30);
    assert.deepEqual(reorderSearchReferences([first, second], 0, 1), [second, first]);
    assert.deepEqual(reorderSearchReferences([first, second], -1, 1), [first, second]);
  });

  test("keeps the last valid result set while a query has a syntax error", () => {
    const valid = resolveSearchOutput([base], { ...DEFAULT_SEARCH_INTENT, query: "beach" });
    const invalid = resolveSearchOutput(
      [base],
      { ...DEFAULT_SEARCH_INTENT, query: '"beach' },
      valid.lastValid,
    );
    assert.equal(valid.output.results.length, 1);
    assert.equal(invalid.output, valid.output);
    assert.match(invalid.syntaxError ?? "", /Close the quoted phrase/);
  });

  test("compares canonical intents so the same return URL does not reset session state", () => {
    const linked = deserializeSearchIntent(
      serializeSearchIntent({
        ...DEFAULT_SEARCH_INTENT,
        query: "beach",
        filters: { ...DEFAULT_SEARCH_INTENT.filters, providers: ["atlas"] },
      }),
    );
    assert.equal(sameSearchIntent(linked, { ...linked, filters: { ...linked.filters } }), true);
    assert.equal(sameSearchIntent(linked, { ...linked, query: "scarf" }), false);
  });

  test("restores local search history defensively and keeps newest unique entries", () => {
    assert.deepEqual(parseSearchHistory("not json"), []);
    assert.deepEqual(parseSearchHistory(JSON.stringify({ query: "beach" })), []);
    assert.deepEqual(parseSearchHistory(JSON.stringify(["beach", 12, "dog"])), ["beach", "dog"]);
    assert.deepEqual(addSearchHistory(["dog", "beach", "scarf"], "beach", 3), [
      "beach",
      "dog",
      "scarf",
    ]);
  });
});

describe("search performance contracts", () => {
  const atlas = (index: number, parameters: SearchDocument["parameters"]): SearchDocument => ({
    ...base,
    id: `atlas-${index}`,
    source: "api",
    provider: "atlas",
    createdAt: index,
    prompt: `dog on beach number ${index}`,
    checkpoints: [],
    loras: [],
    parameters,
  });

  test("counts provider parameter values in place, across arrays and documents", () => {
    const facets = collectParameterFacets([
      atlas(1, { motion: "high", camera: ["pan", "zoom"], audio: true, empty: [] }),
      atlas(2, { motion: "high", camera: ["zoom"], audio: false, steps: 0 }),
      atlas(3, { motion: "low", camera: "zoom", blank: "" }),
      base,
    ]);
    assert.deepEqual(facets, {
      motion: [
        { value: "high", count: 2 },
        { value: "low", count: 1 },
      ],
      camera: [
        { value: "zoom", count: 3 },
        { value: "pan", count: 1 },
      ],
      audio: [
        { value: "false", count: 1 },
        { value: "true", count: 1 },
      ],
      empty: [],
      steps: [{ value: "0", count: 1 }],
      blank: [],
    });
  });

  test("leaves free-text and media parameters out of facets but still filters by them", () => {
    const document = atlas(1, {
      prompt: "dog on beach number 1",
      image: "https://media.example/1.png",
      images: ["https://media.example/2.png"],
      video: "https://media.example/1.mp4",
      url: "https://media.example/",
      negative_prompt: "blurry",
    });
    assert.deepEqual(Object.keys(buildSearchFacets([document]).parameters), ["negative_prompt"]);
    const filtered = searchDocuments([document], {
      ...DEFAULT_SEARCH_INTENT,
      filters: {
        ...DEFAULT_SEARCH_INTENT.filters,
        parameters: { prompt: ["dog on beach number 1"] },
      },
    });
    assert.equal("results" in filtered && filtered.results.length, 1);
  });

  test("builds facets for a large history in linear time", () => {
    // Unique seeds plus a few shared values: the shape that made the old
    // accumulate-by-copy loop quadratic: ~1.9 s for this input, ~17 ms now.
    const documents = Array.from({ length: 20_000 }, (_, index) =>
      atlas(index, { seed: index, motion: index % 2 ? "high" : "low", camera: ["pan", "zoom"] }),
    );
    const started = performance.now();
    const facets = buildSearchFacets(documents);
    const elapsed = performance.now() - started;
    assert.equal(facets.parameters.seed.length, 20_000);
    assert.deepEqual(facets.parameters.camera, [
      { value: "pan", count: 20_000 },
      { value: "zoom", count: 20_000 },
    ]);
    assert.ok(elapsed < 250, `facets for 20,000 documents took ${elapsed.toFixed(0)} ms`);
  });

  test("counts exactly the media searchDocuments would return", () => {
    const documents: SearchDocument[] = [
      base,
      { ...base, id: "video", mediaType: "video", assets: [base.assets[0], { id: "b", key: "b" }] },
      { ...base, id: "fox", prompt: "fox in forest", negativePrompt: "sharp" },
      { ...base, id: "empty", assets: [] },
    ];
    const intents: SearchIntent[] = [
      DEFAULT_SEARCH_INTENT,
      { ...DEFAULT_SEARCH_INTENT, query: "dog" },
      { ...DEFAULT_SEARCH_INTENT, query: "dog|fox, -scarf" },
      { ...DEFAULT_SEARCH_INTENT, query: "forest", negativePromptQuery: "sharp" },
      { ...DEFAULT_SEARCH_INTENT, query: "beahc", allowTypos: true },
      {
        ...DEFAULT_SEARCH_INTENT,
        filters: { ...DEFAULT_SEARCH_INTENT.filters, mediaTypes: ["video"] },
      },
    ];
    for (const intent of intents) {
      const output = searchDocuments(documents, intent);
      assert.ok("results" in output);
      assert.equal(countSearchMatches(documents, intent), output.results.length, intent.query);
    }
    assert.equal(countSearchMatches(documents, { ...DEFAULT_SEARCH_INTENT, query: '"dog' }), 0);
  });

  test("reports the first malformed query of an intent", () => {
    assert.equal(searchIntentError(DEFAULT_SEARCH_INTENT), null);
    assert.match(
      searchIntentError({ ...DEFAULT_SEARCH_INTENT, query: '"beach' }) ?? "",
      /Close the quoted phrase/,
    );
    assert.match(
      searchIntentError({ ...DEFAULT_SEARCH_INTENT, negativePromptQuery: "blurry|" }) ?? "",
      /alternative/,
    );
  });

  test("keeps result identity for unchanged documents and only replaces what changed", () => {
    const second = { ...base, id: "second", createdAt: 2 };
    const results = (documents: SearchDocument[]) => {
      const output = searchDocuments(documents, { ...DEFAULT_SEARCH_INTENT, sort: "newest" });
      assert.ok("results" in output);
      return output.results;
    };
    const first = results([base, second]);
    const same = stabilizeSearchResults(first, results([base, second]));
    assert.equal(same, first, "an unchanged search keeps the previous array");

    const edited = { ...second, prompt: "edited" };
    const changed = stabilizeSearchResults(first, results([base, edited]));
    assert.notEqual(changed, first);
    assert.equal(changed[1], first[1], "the untouched document keeps its result object");
    assert.notEqual(changed[0], first[0]);
    assert.equal(changed[0].document, edited);

    const third = { ...base, id: "third", createdAt: 3 };
    const grown = stabilizeSearchResults(first, results([base, second, third]));
    assert.equal(grown.length, 3);
    assert.equal(grown[1], first[0]);
    assert.equal(grown[2], first[1]);
  });
});
