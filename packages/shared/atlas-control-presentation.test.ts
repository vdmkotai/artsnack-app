import assert from "node:assert/strict";
// @ts-expect-error Bun exposes its test runner at runtime.
import { test } from "bun:test";
import { ATLAS_MODELS, atlasEnumIsUnset, type AtlasParam } from "./atlas-models";
import { dimensionOptionGroups } from "./atlas-dimension-options";
import {
  atlasControlLabel,
  atlasControlOptions,
  atlasToggleValues,
  atlasUsesSlider,
  atlasHasRatioOptions,
  atlasNamedSizeOptions,
  parseAspectOption,
} from "./atlas-control-presentation";

test("every catalogue enum retains all original values and types through its display adapter", () => {
  const before = JSON.stringify(ATLAS_MODELS);
  let checked = 0;
  for (const model of ATLAS_MODELS) {
    for (const param of model.params) {
      if (param.kind !== "enum") continue;
      const options = atlasControlOptions(param)!;
      assert.deepEqual(
        options,
        atlasEnumIsUnset(param) ? ["", ...param.options!] : param.options,
        `${model.id}:${param.name}`,
      );
      const toggle = atlasToggleValues(param);
      if (toggle) assert.deepEqual(new Set([toggle.on, toggle.off]), new Set(options));
      const dimensions = dimensionOptionGroups(options);
      if (dimensions)
        assert.deepEqual(
          new Set([
            ...dimensions.specials,
            ...dimensions.groups.flatMap((group) => group.options.map((option) => option.value)),
          ]),
          new Set(options),
        );
      const named = atlasNamedSizeOptions(param);
      if (named)
        assert.deepEqual(
          named.map((option) => option.value),
          options,
        );
      checked++;
    }
  }
  assert.ok(checked > 500, `Only ${checked} enums checked`);
  assert.equal(
    JSON.stringify(ATLAS_MODELS),
    before,
    "Presentation must not mutate the API catalogue",
  );
});

test("all bounded native output counts expose their full range, including values above four", () => {
  let largest = 0;
  for (const model of ATLAS_MODELS) {
    for (const param of model.params.filter((param) =>
      ["n", "num_images", "max_images", "count"].includes(param.name),
    )) {
      const options = atlasControlOptions(param)!;
      assert.ok(options.length > 0, `${model.id}:${param.name}`);
      if (param.kind === "integer") {
        assert.equal(options[0], param.min);
        assert.equal(options.at(-1), param.max);
        assert.equal(options.length, param.max! - param.min! + 1);
        largest = Math.max(largest, Number(options.at(-1)));
      }
    }
  }
  assert.equal(largest, 15);
});

test("rare aspect ratios, adaptive mode and distinct named square sizes remain selectable", () => {
  const ratios: AtlasParam = {
    name: "ratio",
    kind: "enum",
    label: "Ratio",
    required: false,
    options: ["auto", "adaptive", "16:10", "10:16", "9:19.5", "8:1"],
  };
  assert.equal(atlasHasRatioOptions(ratios), true);
  assert.equal(parseAspectOption("16:10"), 1.6);
  // Optional with no vendor default: "" (shown as Default) leads, nothing is lost.
  assert.deepEqual(atlasControlOptions(ratios), ["", ...ratios.options!]);
  assert.deepEqual(atlasControlOptions({ ...ratios, default: "auto" }), ratios.options);
  assert.equal(dimensionOptionGroups(["1600*1000"])!.groups[0].ratio, "16:10");
  const named = atlasNamedSizeOptions({
    ...ratios,
    name: "image_size",
    options: ["square", "square_hd", "portrait_4_3"],
  })!;
  assert.deepEqual(
    named.map((option) => option.value),
    ["square", "square_hd", "portrait_4_3"],
  );
  assert.notEqual(named[0].label, named[1].label);
  assert.equal(named[2].aspect, 0.75);
});

test("toggles preserve string wire values, and URL audio never becomes a toggle", () => {
  const param: AtlasParam = {
    name: "generate_audio",
    kind: "enum",
    label: "Generate Audio",
    required: false,
    options: ["yes", "no"],
  };
  assert.deepEqual(atlasToggleValues(param), { on: "yes", off: "no" });
  assert.equal(atlasControlLabel(param), "Generate audio");
  assert.equal(atlasToggleValues({ ...param, name: "audio", kind: "url" }), null);
  assert.equal(
    atlasControlLabel({ ...param, name: "audio", kind: "url", label: "Audio URL" }),
    "Audio URL",
  );
  assert.equal(atlasToggleValues({ ...param, options: ["yes", "no", "auto"] }), null);
});

test("numeric controls preserve sparse durations, negative sentinels and unbounded seeds", () => {
  const param: AtlasParam = {
    name: "duration",
    kind: "enum",
    label: "Duration",
    required: false,
    default: "5",
    options: ["5", "10"],
  };
  assert.deepEqual(atlasControlOptions(param), ["5", "10"]);
  assert.deepEqual(atlasControlOptions({ ...param, default: 4, options: [-1, 4, 8] }), [-1, 4, 8]);
  assert.equal(
    atlasUsesSlider({ ...param, name: "seed", kind: "integer", min: -1, max: 4294967295 }),
    false,
  );
  assert.equal(
    atlasControlOptions({ ...param, kind: "number", options: undefined, min: 0, max: 10 }),
    null,
  );
  assert.equal(
    atlasUsesSlider({ ...param, name: "guidance_scale", kind: "number", min: 0, max: 1 }),
    true,
  );
});
