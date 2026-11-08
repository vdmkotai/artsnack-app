import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { matchesFavoriteFilters, type FilterableFavorite } from "./favorite-filters";

const image: FilterableFavorite = { mediaType: "image", provider: "grok" };
const filedVideo: FilterableFavorite = { folderId: "f1", mediaType: "video", provider: "atlas" };
const selfHosted: FilterableFavorite = {
  mediaType: "image",
  provider: "self-hosted",
  checkpoint: "sdxl.safetensors",
};

describe("matchesFavoriteFilters", () => {
  test("no filters keeps everything", () => {
    for (const row of [image, filedVideo, selfHosted]) {
      assert.equal(matchesFavoriteFilters(row, {}), true);
    }
  });

  test("folder scopes: unfiled, a folder, or all", () => {
    assert.equal(matchesFavoriteFilters(image, { folder: "none" }), true);
    assert.equal(matchesFavoriteFilters(filedVideo, { folder: "none" }), false);
    assert.equal(matchesFavoriteFilters(filedVideo, { folder: "f1" }), true);
    assert.equal(matchesFavoriteFilters(filedVideo, { folder: "f2" }), false);
    assert.equal(matchesFavoriteFilters(image, { folder: "f1" }), false);
  });

  test("media type, providers and checkpoints combine", () => {
    assert.equal(matchesFavoriteFilters(filedVideo, { mediaType: "image" }), false);
    assert.equal(
      matchesFavoriteFilters(filedVideo, { mediaType: "video", providers: ["atlas"] }),
      true,
    );
    assert.equal(matchesFavoriteFilters(image, { providers: ["atlas", "fal"] }), false);
    assert.equal(matchesFavoriteFilters(image, { providers: [] }), true);
    assert.equal(matchesFavoriteFilters(selfHosted, { checkpoints: ["sdxl.safetensors"] }), true);
    // A checkpoint filter excludes rows that have no checkpoint at all.
    assert.equal(matchesFavoriteFilters(image, { checkpoints: ["sdxl.safetensors"] }), false);
  });
});
