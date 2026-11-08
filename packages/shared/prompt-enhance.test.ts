import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AtlasModel } from "./atlas-models";
import {
  BUILTIN_RECIPES,
  atlasEnhanceContext,
  DEFAULT_ENHANCE_MODEL_ID,
  ENHANCE_MODELS,
  atlasFallbackFor,
  buildCustomEnhanceMessages,
  buildEnhanceMessages,
  cleanEnhancedText,
  defaultRecipeFor,
  getEnhanceModel,
  withoutRefusedParams,
  recipesFor,
  renderRecipeInstructions,
} from "./prompt-enhance";

describe("enhance models", () => {
  test("ids are unique and the default exists", () => {
    const ids = ENHANCE_MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(DEFAULT_ENHANCE_MODEL_ID));
  });

  test("id encodes the provider it claims", () => {
    for (const m of ENHANCE_MODELS) assert.equal(m.id.startsWith(`${m.provider}:`), true);
  });

  test("unknown or missing id resolves to the default", () => {
    assert.equal(getEnhanceModel(undefined).id, DEFAULT_ENHANCE_MODEL_ID);
    assert.equal(getEnhanceModel("atlas:gone").id, DEFAULT_ENHANCE_MODEL_ID);
  });

  test("every subscription Grok model has an Atlas twin to fall back to", () => {
    for (const m of ENHANCE_MODELS.filter((m) => m.provider === "grok")) {
      const twin = atlasFallbackFor(m);
      assert.equal(twin?.provider, "atlas");
      assert.equal(twin?.model, `xai/${m.model}`);
    }
    assert.equal(atlasFallbackFor(getEnhanceModel("atlas:openai/gpt-5.4")), null);
  });

  test("no Gemini", () => {
    assert.equal(
      ENHANCE_MODELS.some((m) => /gemini/i.test(m.model)),
      false,
    );
  });
});

describe("recipes", () => {
  test("built-ins cover both media types with a default", () => {
    assert.equal(defaultRecipeFor(BUILTIN_RECIPES, "image")?.title, "Polish");
    assert.equal(defaultRecipeFor(BUILTIN_RECIPES, "video")?.title, "Cinematic scenes");
  });

  test("a media-specific default beats an 'any' default, and the default lists first", () => {
    const list = recipesFor(BUILTIN_RECIPES, "video");
    assert.equal(list[0].title, "Cinematic scenes");
    assert.ok(list.map((r) => r.title).includes("Polish"));
    assert.ok(!list.map((r) => r.title).includes("nothing"));
    assert.deepEqual(
      recipesFor(BUILTIN_RECIPES, "image").map((r) => r.title),
      ["Polish", "Translate & tidy"],
    );
  });

  test("falls back to any listable recipe when nothing is marked default", () => {
    const recipes = [{ media: "video" as const, isDefault: false, title: "only" }];
    assert.equal(defaultRecipeFor(recipes, "video")?.title, "only");
    assert.equal(defaultRecipeFor(recipes, "image"), null);
  });

  test("placeholders render from context and unknown ones survive", () => {
    const out = renderRecipeInstructions(
      "Model {{targetModel}}, {{duration}}s{{durationFallback}}, ratio {{aspectRatio}}, {{unknown}}.{{references}}",
      {
        media: "video",
        targetModel: "Seedance 2.0",
        duration: 8,
        aspectRatio: "16:9",
        referenceCount: 2,
      },
    );
    assert.ok(out.includes("Model Seedance 2.0, 8s, ratio 16:9, {{unknown}}."));
    assert.ok(out.includes("@image1, @image2"));
    assert.ok(out.includes("Output rules:"));
  });

  test("missing duration and refs leave no dangling text", () => {
    const out = renderRecipeInstructions(
      "{{duration}} seconds{{durationFallback}}.{{references}}",
      {
        media: "image",
        aspectRatio: "auto",
      },
    );
    assert.equal(out.startsWith("a few seconds (pick a sensible total if none is given)."), true);
    assert.ok(!out.includes("@image"));
  });

  test("sentinel ratios and prototype names are not substituted", () => {
    const out = renderRecipeInstructions("ratio {{aspectRatio}} {{constructor}} {{toString}}", {
      media: "video",
      aspectRatio: "adaptive",
    });
    assert.ok(out.startsWith("ratio as set {{constructor}} {{toString}}"));
  });

  test("Atlas context reads duration, ratio params and size presets", () => {
    const ratioModel = {
      label: "Seedance",
      media: "video",
      params: [
        { name: "duration", kind: "integer" },
        { name: "ratio", kind: "enum" },
      ],
    } as unknown as AtlasModel;
    assert.deepEqual(atlasEnhanceContext(ratioModel, { duration: "8", ratio: "16:9" }, 2), {
      media: "video",
      targetModel: "Seedance",
      duration: 8,
      aspectRatio: "16:9",
      referenceCount: 2,
    });
    const sizeModel = {
      label: "Seedream",
      media: "image",
      params: [{ name: "size", kind: "dimensions", default: "2048*2048" }],
    } as unknown as AtlasModel;
    const ctx = atlasEnhanceContext(sizeModel, { size: "2048*2048" }, 0);
    assert.equal(ctx.aspectRatio, "1:1");
    assert.equal(ctx.duration, undefined);
  });

  test("messages carry the system brief and the user's prompt verbatim", () => {
    const messages = buildEnhanceMessages("Be brief.", "  girl on a beach  ", { media: "image" });
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content.startsWith("Be brief."), true);
    assert.deepEqual(messages[1], { role: "user", content: "girl on a beach" });
  });
});

describe("cleanEnhancedText", () => {
  test("strips code fences and wrapping quotes, leaves inner quotes alone", () => {
    assert.equal(cleanEnhancedText("```\nA shot.\n```"), "A shot.");
    assert.equal(cleanEnhancedText("```\r\nA shot.\r\n```"), "A shot.");
    assert.equal(cleanEnhancedText("```\nA shot.```"), "A shot.");
    assert.equal(cleanEnhancedText('"A shot."'), "A shot.");
    assert.equal(cleanEnhancedText('"She says "hi"."'), '"She says "hi"."');
    assert.equal(cleanEnhancedText("  plain  "), "plain");
  });
});

describe("buildCustomEnhanceMessages", () => {
  test("puts the instruction in the brief and the prompt in the user turn", () => {
    const [system, user] = buildCustomEnhanceMessages(
      "  Add more visual details.  ",
      "  a cat on a roof ",
      { media: "image", targetModel: "Seedream 5", referenceCount: 2 },
    );
    assert.equal(user.role, "user");
    assert.equal(user.content, "a cat on a roof");
    assert.equal(system.role, "system");
    assert.match(system.content, /image generation model \(Seedream 5\)/);
    assert.match(system.content, /Instruction:\nAdd more visual details\./);
    assert.match(system.content, /@image1, @image2/);
  });

  test("lets the instruction override the always-add-detail rule", () => {
    const [system] = buildCustomEnhanceMessages("Make it shorter", "x", { media: "video" });
    assert.doesNotMatch(system.content, /Add detail;/);
    assert.match(system.content, /Change only what the instruction asks for/);
    assert.match(system.content, /Reply with the finished prompt only/);
  });

  test("leaves placeholder-looking text in the instruction alone", () => {
    const [system] = buildCustomEnhanceMessages("Keep {{media}} and $& as-is", "x", {
      media: "image",
    });
    assert.match(system.content, /Keep \{\{media\}\} and \$& as-is/);
  });
});

describe("withoutRefusedParams", () => {
  const body = {
    model: "grok-4.20-0309-reasoning",
    messages: [],
    max_tokens: 6000,
    temperature: 0.4,
    reasoning_effort: "low",
  };

  test("drops the parameter a 400 names, and only that one", () => {
    assert.deepEqual(
      withoutRefusedParams(body, '{"error":"Model does not support parameter reasoningEffort."}'),
      { model: body.model, messages: [], max_tokens: 6000, temperature: 0.4 },
    );
    assert.deepEqual(
      withoutRefusedParams(
        body,
        "Unsupported value: 'temperature' does not support 0.4 with this model.",
      ),
      { model: body.model, messages: [], max_tokens: 6000, reasoning_effort: "low" },
    );
  });

  test("renames max_tokens rather than dropping the budget", () => {
    const next = withoutRefusedParams(
      body,
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    );
    assert.equal(next?.max_completion_tokens, 6000);
    assert.equal("max_tokens" in (next ?? {}), false);
  });

  test("null when the error names nothing the body still carries", () => {
    assert.equal(withoutRefusedParams(body, "Model not found: grok-9"), null);
    assert.equal(
      withoutRefusedParams({ model: "x", messages: [] }, "temperature must be at most 1"),
      null,
    );
  });
});
