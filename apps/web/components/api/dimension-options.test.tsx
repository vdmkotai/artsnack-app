import assert from "node:assert/strict";
// @ts-expect-error Bun exposes its test runner at runtime.
import { test } from "bun:test";
import { act, create } from "react-test-renderer";
import { getAtlasModel } from "@/lib/atlas-models";
import { DimensionOptions, dimensionOptionGroups } from "./dimension-options";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

test("Seedream sizes retain every provider value and group rounded ratios without inventing presets", () => {
  const options = getAtlasModel("bytedance/seedream-v4.5").params.find(
    (param) => param.name === "size",
  )!.options!;
  const { groups, specials } = dimensionOptionGroups(options)!;
  assert.equal(groups.length, 8);
  assert.deepEqual(specials, []);
  assert.deepEqual(
    groups.flatMap((group) => group.options.map((option) => option.value)).sort(),
    [...options].sort(),
  );
  assert.deepEqual(
    groups.find((group) => group.ratio === "16:9")!.options.map((option) => option.value),
    ["2848*1600", "5504*3040"],
  );
  assert.deepEqual(dimensionOptionGroups(["auto", "1024*1024"])!.specials, ["auto"]);
  assert.equal(dimensionOptionGroups(["auto"]), null);
  assert.equal(dimensionOptionGroups(["default", "1024*1024"]), null);
  assert.equal(dimensionOptionGroups(["720p", "1080p"]), null);
  assert.equal(dimensionOptionGroups([]), null);
  assert.equal(dimensionOptionGroups(["1500*1000"])!.groups[0].ratio, "3:2");
  assert.equal(dimensionOptionGroups(["5000*1000"])!.groups[0].ratio, "5:1");
});

test("restored Seedream size selects its shape and switching shape keeps a similar pixel count", () => {
  const options = getAtlasModel("bytedance/seedream-v4.5").params.find(
    (param) => param.name === "size",
  )!.options!;
  const { groups } = dimensionOptionGroups(options)!;
  const changes: unknown[] = [];
  let view: ReturnType<typeof create>;
  act(() => {
    view = create(
      <DimensionOptions
        groups={groups}
        value="5504*3040"
        label="Size"
        onChange={(value) => changes.push(value)}
      />,
    );
  });
  try {
    const ratio = view!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Size aspect ratio 16:9")!;
    assert.equal(ratio.props["aria-pressed"], true);
    assert.equal(view!.root.findByType("select").props.value, "5504*3040");
    assert.match(JSON.stringify(view!.toJSON()), /≈ /);
    const portrait = view!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Size aspect ratio 9:16")!;
    act(() => portrait.props.onClick());
    assert.equal(changes.at(-1), "3040*5504");
    act(() => view!.root.findByType("select").props.onChange({ target: { value: "2848*1600" } }));
    assert.equal(changes.at(-1), "2848*1600");
  } finally {
    act(() => view!.unmount());
  }
});

test("GPT Image 2.5's auto size is a shapeless option beside the pixel groups", () => {
  const param = getAtlasModel("openai/gpt-image-2.5-flare/edit").params.find(
    (entry) => entry.name === "size",
  )!;
  const { groups, specials } = dimensionOptionGroups(param.options!)!;
  assert.deepEqual(specials, ["auto"]);
  // The documented default the vendor left out of its own enum is offered.
  assert.ok(groups.some((group) => group.options.some((option) => option.value === "1024x1024")));
  const changes: unknown[] = [];
  let view: ReturnType<typeof create>;
  act(() => {
    view = create(
      <DimensionOptions
        groups={groups}
        specials={specials}
        value="auto"
        label="Size"
        onChange={(value) => changes.push(value)}
      />,
    );
  });
  try {
    const button = (name: string) =>
      view!.root
        .findAllByType("button")
        .find((candidate) => candidate.props["aria-label"] === `Size aspect ratio ${name}`)!;
    assert.equal(button("Auto").props["aria-pressed"], true);
    assert.equal(view!.root.findAllByType("select").length, 0);
    act(() => button("1:1").props.onClick());
    assert.equal(changes.at(-1), "1024x1024");
    act(() => button("Auto").props.onClick());
    assert.equal(changes.at(-1), "auto");
  } finally {
    act(() => view!.unmount());
  }
});
