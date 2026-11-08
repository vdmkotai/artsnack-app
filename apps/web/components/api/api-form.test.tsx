import assert from "node:assert/strict";
// @ts-expect-error Bun exposes this test-only module at runtime; production uses Node types.
import { mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

mock.module("convex/react", () => ({
  useQuery: () => [],
  useMutation: () => mock(async () => undefined),
  useAction: () => mock(async () => undefined),
}));
mock.module("@/components/grok/prompt-input", () => ({ PromptInput: () => null }));
mock.module("@/components/prompt-library", () => ({ PromptLibrary: () => null }));
mock.module("@/components/prompt-enhance-button", () => ({ PromptEnhanceButton: () => null }));
// The form tests exercise bindings; Base UI slider cleanup requires a browser document.
mock.module("@/components/ui/slider", () => ({
  Slider: (props: Record<string, unknown>) => <input data-testid="slider" {...props} />,
}));
mock.module("@/components/api/field-row", () => ({
  FieldGrid: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InfoHint: () => null,
}));

const { ApiForm } = await import("@/components/api/api-form");
const { getApiModel } = await import("@/lib/api-models");
const { atlasDefaults, atlasFamilyMaxReferences, getAtlasModel } =
  await import("@/lib/atlas-models");
const { DEFAULT_API_FORM } = await import("@/lib/normalize-form");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

test("Wan Prime lets two attached images switch from Start/End frames to references", () => {
  const frameModel = getAtlasModel("alibaba/wan-3.0-prime/image-to-video");
  const referenceModelId = "alibaba/wan-3.0-prime/reference-to-video";
  const form = {
    ...DEFAULT_API_FORM,
    provider: "atlas" as const,
    mediaType: "video" as const,
    atlasVideoModel: frameModel.id,
    atlasVideoParams: atlasDefaults(frameModel),
  };
  const refs = ["one", "two"].map((id) => ({
    id,
    blob: new Blob([id], { type: "image/jpeg" }),
    previewUrl: `blob:${id}`,
    aspect: 1,
    width: 1024,
    height: 1024,
    selected: true,
  }));
  let chosenModel: string | undefined;
  let renderer: ReactTestRenderer | null = null;

  try {
    act(() => {
      renderer = create(
        <ApiForm
          model={getApiModel(form.model)}
          atlas={{
            model: frameModel,
            params: form.atlasVideoParams,
            onParamChange: () => {},
            jobs: 1,
          }}
          form={form}
          updateField={(field, value) => {
            if (field === "atlasVideoModel") chosenModel = String(value);
          }}
          refImages={refs}
          selectedRefs={refs}
          referenceIssues={[]}
          maxReferences={atlasFamilyMaxReferences(frameModel)}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });
    assert.ok(renderer);
    const view = renderer as unknown as ReactTestRenderer;
    const referenceMode = view.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Use reference images");

    assert.ok(referenceMode, "the UI exposes no separate References mode");
    act(() => referenceMode.props.onClick());
    assert.equal(chosenModel, referenceModelId);

    const referenceModel = getAtlasModel(referenceModelId);
    const referenceForm = {
      ...form,
      atlasVideoModel: referenceModel.id,
      atlasVideoParams: atlasDefaults(referenceModel),
    };
    chosenModel = undefined;
    act(() => {
      renderer?.update(
        <ApiForm
          model={getApiModel(form.model)}
          atlas={{
            model: referenceModel,
            params: referenceForm.atlasVideoParams,
            onParamChange: () => {},
            jobs: 1,
          }}
          form={referenceForm}
          updateField={(field, value) => {
            if (field === "atlasVideoModel") chosenModel = String(value);
          }}
          refImages={refs}
          selectedRefs={refs}
          referenceIssues={[]}
          maxReferences={atlasFamilyMaxReferences(referenceModel)}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });

    const frameMode = view.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Use Start & End frames");
    const activeReferenceMode = view.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Use reference images");
    assert.ok(frameMode);
    assert.equal(activeReferenceMode?.props["aria-pressed"], true);
    assert.match(JSON.stringify(view.toJSON()), /Reference images \(optional\)/);

    act(() => frameMode.props.onClick());
    assert.equal(chosenModel, frameModel.id);

    act(() => {
      renderer?.update(
        <ApiForm
          model={getApiModel(form.model)}
          atlas={{
            model: referenceModel,
            params: referenceForm.atlasVideoParams,
            onParamChange: () => {},
            jobs: 1,
          }}
          form={{ ...referenceForm, prompt: "keep @image1 and @image2 consistent" }}
          updateField={() => {}}
          refImages={refs}
          selectedRefs={refs}
          referenceIssues={[]}
          maxReferences={atlasFamilyMaxReferences(referenceModel)}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });
    const taggedFrameMode = view.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Use Start & End frames");
    assert.equal(taggedFrameMode?.props.disabled, true);

    const unpairedModel = getAtlasModel("atlascloud/wan-2.2/image-to-video");
    act(() => {
      renderer?.update(
        <ApiForm
          model={getApiModel(form.model)}
          atlas={{
            model: unpairedModel,
            params: atlasDefaults(unpairedModel),
            onParamChange: () => {},
            jobs: 1,
          }}
          form={{
            ...form,
            atlasVideoModel: unpairedModel.id,
            atlasVideoParams: atlasDefaults(unpairedModel),
          }}
          updateField={() => {}}
          refImages={refs.slice(0, 1)}
          selectedRefs={refs.slice(0, 1)}
          referenceIssues={[]}
          maxReferences={atlasFamilyMaxReferences(unpairedModel)}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });
    assert.equal(
      view.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Use reference images"),
      false,
    );
  } finally {
    act(() => renderer?.unmount());
  }
});

test("clicking a reference opens its preview while the checkbox independently toggles selection", () => {
  const reference = {
    id: "generated",
    blob: new Blob(["image"], { type: "image/jpeg" }),
    previewUrl: "blob:reference",
    sourceUrl: "/api/images/generations/original.png",
    aspect: 1,
    selected: true,
  };
  let previewed: unknown;
  let toggled: string | undefined;
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <ApiForm
          model={getApiModel(DEFAULT_API_FORM.model)}
          form={DEFAULT_API_FORM}
          updateField={() => {}}
          refImages={[reference]}
          selectedRefs={[reference]}
          referenceIssues={[]}
          maxReferences={4}
          onPreviewRef={(ref) => {
            previewed = ref;
          }}
          onToggleRef={(id) => {
            toggled = id;
          }}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });
    assert.ok(renderer);
    const buttons = renderer.root.findAllByType("button");
    const preview = buttons.find(
      (button) => button.props["aria-label"] === "Preview reference image",
    );
    const checkbox = buttons.find((button) => button.props["aria-label"] === "Deselect reference");
    assert.ok(preview);
    assert.ok(checkbox);
    act(() => preview.props.onClick());
    assert.equal(previewed, reference);
    assert.equal(toggled, undefined);
    act(() => checkbox.props.onClick());
    assert.equal(toggled, reference.id);
  } finally {
    act(() => renderer?.unmount());
  }
});

test("Nano Banana exposes text and video-reference modes and keeps clip controls reachable", () => {
  const model = getAtlasModel("google/nano-banana-2/text-to-image");
  const form = {
    ...DEFAULT_API_FORM,
    provider: "atlas" as const,
    mediaType: "image" as const,
    atlasImageModel: model.id,
    atlasImageParams: atlasDefaults(model),
  };
  let chosen: unknown;
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <ApiForm
          model={getApiModel(form.model)}
          atlas={{ model, params: form.atlasImageParams, onParamChange: () => {}, jobs: 1 }}
          form={form}
          updateField={(field, value) => {
            if (field === "atlasImageModel") chosen = value;
          }}
          refImages={[]}
          selectedRefs={[]}
          referenceIssues={[]}
          maxReferences={atlasFamilyMaxReferences(model)}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });
    assert.ok(renderer);
    const mode = renderer.root.findByProps({ "aria-label": "Atlas input mode" });
    const options = mode.findAllByType("option");
    assert.deepEqual(
      options.map((option) => option.props.value).sort(),
      [model.id, "google/nano-banana-2/reference-to-image"].sort(),
    );
    assert.ok(options.every((option) => !option.props.disabled));
    assert.match(JSON.stringify(renderer.toJSON()), /video clip/);
    act(() =>
      mode.props.onChange({ target: { value: "google/nano-banana-2/reference-to-image" } }),
    );
    assert.equal(chosen, "google/nano-banana-2/reference-to-image");
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("Grok 1.5 gives each selected image a role, and a pick goes through the shared rule", () => {
  const refs = ["one", "two"].map((id) => ({
    id,
    blob: new Blob([id], { type: "image/jpeg" }),
    previewUrl: `blob:${id}`,
    aspect: 1,
    width: 768,
    height: 768,
    selected: true,
  }));
  const form = {
    ...DEFAULT_API_FORM,
    provider: "grok" as const,
    model: "grok" as const,
    mediaType: "video" as const,
    aspectRatio: "16:9",
    duration: 6,
    resolution: "480p",
  };
  const updates: [string, unknown][] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <ApiForm
          model={getApiModel("grok")}
          form={form}
          updateField={(field, value) => {
            updates.push([field, value]);
          }}
          refImages={refs}
          selectedRefs={refs}
          referenceIssues={[]}
          maxReferences={14}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
        />,
      );
    });
    assert.ok(renderer);
    const roles = renderer.root.findAllByProps({
      "aria-label": "What this image does in the clip",
    });
    assert.equal(roles.filter((node) => node.type === "select").length, 2);
    // Two automatic images are both references.
    assert.match(JSON.stringify(renderer.toJSON()), /1 · Ref/);
    act(() => roles[1].props.onChange({ target: { value: "first" } }));
    assert.deepEqual(updates.at(-1), [
      "grokFrameRoles",
      [{ role: "reference" }, { role: "first" }],
    ]);
    // 1.5 offers voices; the model choice is on screen and sets the field.
    assert.match(JSON.stringify(renderer.toJSON()), /Voices/);
    const lite = renderer.root
      .findAllByType("button")
      .find((button) => String(button.props.title ?? "").startsWith("Text or one start image"));
    assert.ok(lite);
    act(() => lite.props.onClick());
    assert.deepEqual(updates.at(-1), ["grokVideoModel", "grok-imagine-video-1.5-lite"]);
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});

test("Grok Edit swaps the image strip for a source clip and says what is missing", () => {
  const reference = {
    id: "kept",
    blob: new Blob(["image"], { type: "image/jpeg" }),
    previewUrl: "blob:kept",
    aspect: 1,
    selected: true,
  };
  const form = {
    ...DEFAULT_API_FORM,
    provider: "grok" as const,
    model: "grok" as const,
    mediaType: "video" as const,
    grokVideoMode: "edit" as const,
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <ApiForm
          model={getApiModel("grok")}
          form={form}
          updateField={() => {}}
          refImages={[reference]}
          selectedRefs={[reference]}
          referenceIssues={[]}
          maxReferences={14}
          onPreviewRef={() => {}}
          onToggleRef={() => {}}
          onRemoveRef={() => {}}
          onPickFiles={() => {}}
          onOpenGallery={() => {}}
          quotes={new Map()}
          onPickSourceVideo={() => {}}
        />,
      );
    });
    assert.ok(renderer);
    const json = JSON.stringify(renderer.toJSON());
    assert.equal(
      renderer.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Preview reference image"),
      false,
    );
    assert.match(json, /Upload mp4/);
    assert.match(json, /Edit needs a source video/);
    // Edit has no duration, resolution or ratio of its own.
    assert.doesNotMatch(json, /Seconds to add|Aspect ratio|"Resolution"/);
  } finally {
    if (renderer) act(() => renderer?.unmount());
  }
});
