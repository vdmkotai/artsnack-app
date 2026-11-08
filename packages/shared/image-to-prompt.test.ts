import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  atlasTextModels,
  buildDescribeCatalog,
  buildDescribeMessages,
  DEFAULT_DESCRIBE_MODEL_ID,
  DESCRIBE_FALLBACK_MODELS,
  DESCRIBE_PRESETS,
  describeFallbackFor,
  describeModelFor,
  describeModelHint,
  describeCatalogNotice,
  FALLBACK_DESCRIBE_CATALOG,
  getDescribePreset,
  grokLanguageModels,
  groupDescribeModels,
  isDescribableImage,
  isDescribeModelId,
  isDescribePresetId,
  MAX_DESCRIBE_IMAGE_CHARS,
  renderDescribeInstructions,
  withPreviousModels,
} from "./image-to-prompt";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("describe presets", () => {
  test("ids are unique and each resolves to itself", () => {
    const ids = DESCRIBE_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.equal(getDescribePreset(id).id, id);
  });

  test("unknown ids fall back to natural and fail the guard", () => {
    assert.equal(getDescribePreset("bogus").id, "natural");
    assert.equal(isDescribePresetId("bogus"), false);
    assert.equal(isDescribePresetId("sd-tags"), true);
  });
});

/** Trimmed rows of Atlas's `GET /api/v1/models`, as served on 2026-10-30. */
const ATLAS_CATALOG = {
  code: 200,
  data: [
    {
      model: "deepseek-ai/deepseek-v4-flash",
      type: "Text",
      displayName: "DeepSeek V4 Flash",
      priority: 88888,
      price: { actual: { input_price: "0.14", output_price: "0.28" } },
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_protocols: ["openai.chat.completions"],
    },
    {
      model: "xai/grok-4.6",
      type: "Text",
      displayName: "Grok 4.6",
      priority: 90046,
      price: { actual: { input_price: "2", output_price: "6" } },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supported_protocols: ["openai.chat.completions"],
    },
    {
      model: "moonshotai/kimi-k3.1-pro",
      type: "Text",
      displayName: "Kimi K3.1 Pro",
      priority: 200000,
      price: { origin: { input_price: "2", output_price: "10" } },
      input_modalities: ["text", "image", "video"],
      output_modalities: ["text"],
      supported_protocols: ["openai.chat.completions"],
    },
    {
      model: "tencent/hy4-preview",
      type: "Text",
      displayName: "Hunyuan 4 Preview",
      priority: 160039,
      price: { actual: { input_price: "0.834", output_price: "2.501" } },
      input_modalities: ["text"],
      supported_protocols: ["openai.chat.completions"],
    },
    {
      model: "dots-studio/dots-3-note-prev-free",
      type: "Text",
      displayName: "Dots 3 Note Preview",
      priority: 88891,
      price: { actual: { input_price: "0", output_price: "0" } },
      input_modalities: ["text", "image"],
      supported_protocols: ["openai.chat.completions"],
    },
    // Listed as text, but an image generator behind another protocol.
    {
      model: "openai/gpt-image-2",
      type: "Text",
      displayName: "GPT Image 2",
      supported_protocols: ["openai.images"],
    },
    { model: "autojev", type: "Text", supported_protocols: ["systemone"] },
    { model: "bytedance/seedream-5", type: "Image" },
  ],
};

/** Trimmed `GET https://api.x.ai/v1/language-models`, 2026-10-30. */
const GROK_LIST = {
  models: [
    {
      id: "grok-4.20-0309-non-reasoning",
      created: 1773014400,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    {
      id: "grok-4.6",
      created: 1785974400,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    {
      id: "grok-4.7",
      created: 1788307200,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    { id: "grok-imagine-image", input_modalities: ["text"], output_modalities: ["image"] },
  ],
};

describe("describe models", () => {
  test("the default is subscription Grok 4.6, with an Atlas twin to fall back to", () => {
    const model = describeModelFor(undefined);
    assert.equal(model.id, DEFAULT_DESCRIBE_MODEL_ID);
    assert.equal(model.provider, "grok");
    assert.equal(model.label, "Grok 4.6");
    assert.equal(describeFallbackFor(model)?.id, "atlas:xai/grok-4.6");
  });

  test("the built-in models are the Grok generations, on both providers, all with vision", () => {
    assert.ok(DESCRIBE_FALLBACK_MODELS.some((m) => m.id === DEFAULT_DESCRIBE_MODEL_ID));
    assert.ok(DESCRIBE_FALLBACK_MODELS.some((m) => m.provider === "atlas"));
    for (const model of DESCRIBE_FALLBACK_MODELS) {
      assert.match(model.model, /^(xai\/)?grok-/);
      assert.equal(model.vision, true);
    }
  });

  test("any well-formed id resolves, with a label made from its slug", () => {
    const model = describeModelFor("grok:grok-4.20-0309-non-reasoning");
    assert.equal(model.provider, "grok");
    assert.equal(model.model, "grok-4.20-0309-non-reasoning");
    assert.equal(model.label, "Grok 4.20 0309 Non-reasoning");
    assert.equal(describeModelFor("atlas:qwen/qwen3.8-max").label, "Qwen3.8 Max");
    assert.equal(describeModelFor("atlas:openai/gpt-6-sol").label, "GPT 6 Sol");
    assert.equal(describeFallbackFor(describeModelFor("atlas:qwen/qwen3.8-max")), null);
  });

  test("malformed ids fail the guard and resolve to the default", () => {
    for (const id of [
      "",
      "grok:",
      "openai:gpt-6",
      "atlas:../x",
      "atlas:a b",
      `grok:${"a".repeat(200)}`,
    ]) {
      assert.equal(isDescribeModelId(id), false, id);
      assert.equal(describeModelFor(id).id, DEFAULT_DESCRIBE_MODEL_ID, id);
    }
    assert.equal(isDescribeModelId("atlas:deepseek-ai/deepseek-v4.1-flash-1017"), true);
  });
});

describe("atlasTextModels", () => {
  const models = atlasTextModels(ATLAS_CATALOG);

  test("keeps chat-capable text models only", () => {
    assert.deepEqual(models.map((m) => m.model).sort(), [
      "deepseek-ai/deepseek-v4-flash",
      "dots-studio/dots-3-note-prev-free",
      "moonshotai/kimi-k3.1-pro",
      "tencent/hy4-preview",
      "xai/grok-4.6",
    ]);
  });

  test("vision first, then Atlas's priority", () => {
    assert.deepEqual(
      models.map((m) => m.model),
      [
        "moonshotai/kimi-k3.1-pro",
        "xai/grok-4.6",
        "dots-studio/dots-3-note-prev-free",
        "tencent/hy4-preview",
        "deepseek-ai/deepseek-v4-flash",
      ],
    );
  });

  test("ids, labels and prices read as ENHANCE_MODELS writes them", () => {
    const byModel = new Map(models.map((m) => [m.model, m]));
    assert.deepEqual(byModel.get("xai/grok-4.6"), {
      id: "atlas:xai/grok-4.6",
      provider: "atlas",
      model: "xai/grok-4.6",
      label: "Grok 4.6",
      note: "Atlas · $2 / $6 per 1M",
      vision: true,
    });
    assert.equal(
      byModel.get("deepseek-ai/deepseek-v4-flash")?.note,
      "Atlas · $0.14 / $0.28 per 1M",
    );
    assert.equal(byModel.get("deepseek-ai/deepseek-v4-flash")?.vision, false);
    assert.equal(byModel.get("tencent/hy4-preview")?.note, "Atlas · $0.834 / $2.501 per 1M");
    assert.equal(byModel.get("moonshotai/kimi-k3.1-pro")?.note, "Atlas · $2 / $10 per 1M");
    assert.equal(byModel.get("dots-studio/dots-3-note-prev-free")?.note, "Atlas · free");
  });

  test("anything but a catalogue is an empty list", () => {
    assert.deepEqual(atlasTextModels(null), []);
    assert.deepEqual(atlasTextModels({ data: "nope" }), []);
  });
});

describe("grokLanguageModels", () => {
  test("text models newest first, labelled as the built-ins are", () => {
    const models = grokLanguageModels(GROK_LIST);
    assert.deepEqual(
      models.map((m) => [m.id, m.label, m.note, m.vision]),
      [
        ["grok:grok-4.7", "Grok 4.7", "subscription", true],
        ["grok:grok-4.6", "Grok 4.6", "subscription", true],
        ["grok:grok-4.20-0309-non-reasoning", "Grok 4.20 0309 Non-reasoning", "subscription", true],
      ],
    );
  });

  test("anything but a model list is an empty list", () => {
    assert.deepEqual(grokLanguageModels(undefined), []);
    assert.deepEqual(grokLanguageModels({ models: {} }), []);
  });
});

describe("buildDescribeCatalog", () => {
  test("subscription first, then Atlas, no errors", () => {
    const catalog = buildDescribeCatalog(
      grokLanguageModels(GROK_LIST),
      atlasTextModels(ATLAS_CATALOG),
    );
    assert.equal(catalog.models[0].id, "grok:grok-4.7");
    assert.equal(catalog.models.at(-1)?.provider, "atlas");
    assert.equal(catalog.grokError, undefined);
    assert.equal(catalog.atlasError, undefined);
  });

  test("a list that failed is replaced by its built-in models and says why", () => {
    const catalog = buildDescribeCatalog({ error: "Grok connection expired" }, []);
    assert.equal(catalog.grokError, "Grok connection expired");
    assert.equal(catalog.atlasError, "Atlas listed no text models");
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      DESCRIBE_FALLBACK_MODELS.map((m) => m.id),
    );
  });

  test("the stand-in catalogue holds the default and reports nothing failed", () => {
    assert.ok(FALLBACK_DESCRIBE_CATALOG.models.some((m) => m.id === DEFAULT_DESCRIBE_MODEL_ID));
    assert.equal(FALLBACK_DESCRIBE_CATALOG.grokError, undefined);
    assert.equal(FALLBACK_DESCRIBE_CATALOG.atlasError, undefined);
  });
});

describe("withPreviousModels", () => {
  const full = buildDescribeCatalog(
    grokLanguageModels(GROK_LIST),
    atlasTextModels(ATLAS_CATALOG),
  ).models;

  test("a list that failed comes from last time, and says so", () => {
    const fresh = buildDescribeCatalog(grokLanguageModels(GROK_LIST), {
      error: "Atlas answered HTTP 502",
    });
    const kept = withPreviousModels(fresh, full);
    assert.deepEqual(
      kept.models.map((m) => m.id),
      full.map((m) => m.id),
    );
    assert.equal(kept.atlasFromBefore, true);
    assert.equal(kept.grokFromBefore, undefined);
    assert.equal(
      describeCatalogNotice(kept),
      "Atlas's models could not be read (Atlas answered HTTP 502) — showing the list from last time.",
    );
  });

  test("with nothing from last time the built-in models stay", () => {
    const fresh = buildDescribeCatalog(
      { error: "Grok connection expired" },
      atlasTextModels(ATLAS_CATALOG),
    );
    const kept = withPreviousModels(fresh, []);
    assert.deepEqual(kept.models, fresh.models);
    assert.equal(kept.grokFromBefore, undefined);
    assert.match(describeCatalogNotice(kept) ?? "", /showing the built-in Grok models\.$/);
  });
});

describe("describeCatalogNotice", () => {
  test("nothing to say about a full answer; a failed call is named", () => {
    assert.equal(describeCatalogNotice(FALLBACK_DESCRIBE_CATALOG), null);
    assert.equal(
      describeCatalogNotice(FALLBACK_DESCRIBE_CATALOG, "offline"),
      "The model list could not be refreshed (offline).",
    );
  });
});

describe("groupDescribeModels", () => {
  const models = buildDescribeCatalog(
    grokLanguageModels(GROK_LIST),
    atlasTextModels(ATLAS_CATALOG),
  ).models;

  test("subscription, Atlas with vision, then Atlas without", () => {
    const groups = groupDescribeModels(models);
    assert.deepEqual(
      groups.map((g) => [g.title, g.models.length]),
      [
        ["SuperGrok subscription", 3],
        ["Atlas Cloud · takes images", 3],
        ["Atlas Cloud · image input not listed", 2],
      ],
    );
  });

  test("a selected model the list lacks is added, once", () => {
    const groups = groupDescribeModels(models, "atlas:openai/gpt-6-sol");
    assert.equal(groups[1].models[0].id, "atlas:openai/gpt-6-sol");
    assert.equal(groupDescribeModels(models, "grok:grok-4.6")[0].models.length, 3);
  });
});

describe("describeModelHint", () => {
  test("says who pays and warns about a model without listed vision", () => {
    assert.match(describeModelHint(describeModelFor("grok:grok-4.6")), /SuperGrok subscription/);
    const atlas = atlasTextModels(ATLAS_CATALOG);
    const grok = atlas.find((m) => m.model === "xai/grok-4.6")!;
    assert.equal(describeModelHint(grok), "Billed to your Atlas balance ($2 / $6 per 1M tokens).");
    const blind = atlas.find((m) => m.model === "deepseek-ai/deepseek-v4-flash")!;
    assert.match(describeModelHint(blind), /does not list image input/);
  });

  test("a subscription model without an Atlas twin is told it has no fallback", () => {
    const models = buildDescribeCatalog(
      grokLanguageModels(GROK_LIST),
      atlasTextModels(ATLAS_CATALOG),
    ).models;
    const twinless = describeModelFor("grok:grok-4.20-0309-non-reasoning");
    assert.match(describeModelHint(twinless, models), /Atlas does not carry this model/);
    assert.match(
      describeModelHint(describeModelFor("grok:grok-4.6"), models),
      /the same model on Atlas does/,
    );
    // With no Atlas list to go by, the promise stands.
    assert.match(describeModelHint(twinless), /the same model on Atlas does/);
  });
});

describe("renderDescribeInstructions", () => {
  test("the tag preset asks for weights", () => {
    assert.match(renderDescribeInstructions("sd-tags"), /\(tag:1\.2\)/);
  });

  test("user instructions are appended and marked as winning", () => {
    const rendered = renderDescribeInstructions("natural", "  focus on the dress  ");
    assert.match(rendered, /they win:\nfocus on the dress\n/);
  });

  test("blank instructions add nothing", () => {
    assert.equal(
      renderDescribeInstructions("natural", "   "),
      renderDescribeInstructions("natural"),
    );
  });
});

describe("buildDescribeMessages", () => {
  test("sends the image as a content part of the user message", () => {
    const [system, user] = buildDescribeMessages("natural", PNG);
    assert.equal(system.role, "system");
    assert.equal(user.role, "user");
    assert.ok(Array.isArray(user.content));
    assert.deepEqual(user.content[0], {
      type: "image_url",
      image_url: { url: PNG, detail: "high" },
    });
  });
});

describe("isDescribableImage", () => {
  test("accepts jpeg, png and webp data URLs", () => {
    assert.equal(isDescribableImage(PNG), true);
    assert.equal(isDescribableImage("data:image/jpeg;base64,/9j/4AAQ"), true);
    assert.equal(isDescribableImage("data:image/webp;base64,UklGRg=="), true);
  });

  test("rejects other types, remote URLs and oversized payloads", () => {
    assert.equal(isDescribableImage("data:image/gif;base64,R0lGOD=="), false);
    assert.equal(isDescribableImage("https://example.com/a.jpg"), false);
    assert.equal(isDescribableImage("data:image/png;base64,abc def"), false);
    const big = `data:image/png;base64,${"A".repeat(MAX_DESCRIBE_IMAGE_CHARS)}`;
    assert.equal(isDescribableImage(big), false);
  });
});
