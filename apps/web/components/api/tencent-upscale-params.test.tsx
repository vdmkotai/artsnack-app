import assert from "node:assert/strict";
// @ts-expect-error Bun provides the test runner at runtime.
import { test } from "bun:test";
import { useState } from "react";
import { act, create } from "react-test-renderer";
import { TencentUpscaleParams } from "./tencent-upscale-params";
import { atlasDefaults, getAtlasModel } from "@/lib/atlas-models";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

test("a restored 7.5x run shows its size and switching to 5K updates the preview", () => {
  function Form() {
    const [params, setParams] = useState({
      ...atlasDefaults(getAtlasModel("tencent/image/upscaler")),
      percent: 7.5,
    });
    return (
      <TencentUpscaleParams
        params={params}
        source={{ width: 2048, height: 1536 }}
        onChange={(name, value) => setParams((previous) => ({ ...previous, [name]: value }))}
      />
    );
  }
  let view: ReturnType<typeof create>;
  act(() => {
    view = create(<Form />);
  });
  try {
    assert.match(JSON.stringify(view!.toJSON()), /15,360 × 11,520/);
    assert.match(JSON.stringify(view!.toJSON()), /Large upscale/);
    const preset = view!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"]?.startsWith("5K"))!;
    act(() => preset.props.onClick());
    const rendered = JSON.stringify(view!.toJSON());
    assert.match(rendered, /5,120 × 3,840/);
    assert.doesNotMatch(rendered, /Large upscale/);
    assert.match(rendered, /no stretching or cropping/);
    const format = view!.root
      .findAllByType("select")
      .find((select) => select.props.value === "JPEG")!;
    act(() => format.props.onChange({ target: { value: "PNG" } }));
    assert.doesNotMatch(JSON.stringify(view!.toJSON()), /File quality/);
  } finally {
    act(() => view!.unmount());
  }
});
