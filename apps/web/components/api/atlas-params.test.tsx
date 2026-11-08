import assert from "node:assert/strict";
// @ts-expect-error Bun exposes this test-only module at runtime; production uses Node types.
import { mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { atlasDefaults, getAtlasModel } from "@/lib/atlas-models";
mock.module("@/components/ui/slider", () => ({
  Slider: (props: Record<string, unknown>) => <input data-testid="slider" {...props} />,
}));

mock.module("@/components/api/field-row", () => ({
  FieldGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FieldRow: ({ children, label }: { children: React.ReactNode; label: string }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  InfoHint: () => null,
}));

const { AtlasModelBadges, AtlasParams } = await import("@/components/api/atlas-params");

test("the existing parameter panel switches between Tencent sizing and generic model controls", () => {
  const tencent = getAtlasModel("tencent/image/upscaler");
  const other = getAtlasModel("alibaba/wan-3.0-prime/reference-to-video");
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <AtlasParams
          model={tencent}
          params={{ ...atlasDefaults(tencent), mode: "aspect", long_side: 5120 }}
          referenceDimensions={{ width: 2048, height: 1536 }}
          onChange={() => {}}
          jobs={1}
        />,
      );
    });
    assert.match(JSON.stringify(renderer!.toJSON()), /5,120 × 3,840/);
    assert.match(JSON.stringify(renderer!.toJSON()), /Image treatment/);
    act(() =>
      renderer!.update(
        <AtlasParams model={other} params={atlasDefaults(other)} onChange={() => {}} jobs={1} />,
      ),
    );
    assert.match(JSON.stringify(renderer!.toJSON()), /1080p/);
    assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Image treatment/);
  } finally {
    if (renderer) act(() => renderer!.unmount());
  }
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

test("Wan Prime resolution choices show the confirmed total for every native tier", () => {
  const model = getAtlasModel("alibaba/wan-3.0-prime/reference-to-video");
  const params = { ...atlasDefaults(model), duration: 30 };
  let renderer: ReactTestRenderer | null = null;

  try {
    act(() => {
      renderer = create(<AtlasParams model={model} params={params} onChange={() => {}} jobs={1} />);
    });

    assert.ok(renderer);
    const view = renderer as unknown as ReactTestRenderer;
    const rendered = JSON.stringify(view.toJSON());
    assert.match(rendered, /480p/);
    assert.match(rendered, /\$1\.83/);
    assert.match(rendered, /720p/);
    assert.match(rendered, /\$3\.78/);
    assert.match(rendered, /1080p/);
    assert.match(rendered, /\$7\.56/);
    assert.match(rendered, /confirmed tier total/);
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("video badges label catalogue rates as a floor while image badges stay exact", () => {
  const video = getAtlasModel("alibaba/wan-3.0-prime/reference-to-video");
  const image = getAtlasModel("atlascloud/qwen-image/text-to-image");
  let renderer: ReactTestRenderer | null = null;

  try {
    act(() => {
      renderer = create(<AtlasModelBadges model={video} />);
    });
    assert.ok(renderer);
    const view = renderer as unknown as ReactTestRenderer;
    assert.match(JSON.stringify(view.toJSON()), /from \$0\.061\/s/);

    act(() => renderer?.update(<AtlasModelBadges model={image} />));
    const rendered = JSON.stringify(view.toJSON());
    assert.doesNotMatch(rendered, /from /);
    assert.match(rendered, new RegExp(`\\$${image.basePrice}\\/img`));
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("Pixverse exposes one named, typed reference editor for each attached image", () => {
  const model = getAtlasModel("pixverse/v6/reference-to-video");
  let changed: { name: string; value: unknown } | undefined;
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <AtlasParams
          model={model}
          params={atlasDefaults(model)}
          jobs={1}
          referenceCount={2}
          onChange={(name, value) => {
            changed = { name, value };
          }}
        />,
      );
    });
    assert.ok(renderer);
    const fields = renderer.root
      .findAllByType("input")
      .filter((input) => /^reference\d+$/.test(String(input.props.value)));
    assert.equal(fields.length, 2);
    act(() =>
      fields[1].props.onChange({
        target: { value: "room" },
        currentTarget: { value: "room" },
        nativeEvent: { defaultPrevented: false },
      }),
    );
    assert.equal(changed?.name, "images_details");
    const rows = JSON.parse(String(changed?.value));
    assert.equal(rows[0].ref_name, "reference1");
    assert.equal(rows[1].ref_name, "room");
    assert.equal(rows[1].type, "subject");
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("Youchuan draws Midjourney's prompt flags beside the vendor's own fields", () => {
  const model = getAtlasModel("youchuan/v8.2/image-to-image");
  let renderer: ReactTestRenderer | null = null;
  try {
    act(() => {
      renderer = create(
        <AtlasParams model={model} params={atlasDefaults(model)} onChange={() => {}} jobs={1} />,
      );
    });
    const rendered = JSON.stringify((renderer as unknown as ReactTestRenderer).toJSON());
    for (const label of [
      "Stylize",
      "Raw mode",
      "Exclude",
      "Style weight",
      "Image weight",
      "Experimental aesthetics",
      "Tile",
    ]) {
      assert.match(rendered, new RegExp(label), label);
    }
    // HD is the one toggle that changes the price, so it shows both figures.
    assert.match(rendered, /\$0\.086/);
    assert.match(rendered, /\$0\.129/);
    // The style reference is a picker slot now, not a text box in this panel.
    assert.doesNotMatch(rendered, /Style reference/);
    assert.doesNotMatch(rendered, /Sref/);
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("MAI-Image-2.6 starts on its default size word and Custom seeds editable numbers", () => {
  const model = getAtlasModel("microsoft/mai-image-2.6/text-to-image");
  const changes: [string, unknown][] = [];
  let renderer: ReactTestRenderer | null = null;
  try {
    act(() => {
      renderer = create(
        <AtlasParams
          model={model}
          params={atlasDefaults(model)}
          onChange={(name, value) => changes.push([name, value])}
          jobs={1}
        />,
      );
    });
    const button = (label: string) =>
      renderer!.root
        .findAllByType("button")
        .find((candidate) => candidate.props["aria-label"] === `Aspect ratio ${label}`)!;
    assert.equal(button("Default").props["aria-pressed"], true);
    assert.equal(button("Auto").props["aria-pressed"], false);
    // No 1K/1.5K/2K row under a word: there is no shape to scale.
    assert.ok(!renderer!.root.findAllByType("button").some((b) => b.props.children === "1.5K"));
    act(() => button("Custom").props.onClick());
    assert.deepEqual(changes.at(-1), ["size", "1024*1024"]);
  } finally {
    if (renderer) act(() => renderer!.unmount());
  }
});

test("an optional enum without a vendor default offers Default and starts on it", () => {
  const model = getAtlasModel("ltx/ltx-2.5-pro/text-to-video");
  let renderer: ReactTestRenderer | null = null;
  try {
    act(() => {
      renderer = create(
        <AtlasParams model={model} params={atlasDefaults(model)} onChange={() => {}} jobs={1} />,
      );
    });
    const select = renderer!.root
      .findAllByType("select")
      .find((candidate) => candidate.props["aria-label"] === "Camera Motion")!;
    const labels = select.findAllByType("option").map((option) => option.props.children[0]);
    assert.equal(labels[0], "Default");
    assert.equal(select.props.value, 0);
  } finally {
    if (renderer) act(() => renderer!.unmount());
  }
});
