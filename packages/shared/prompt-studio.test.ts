import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  areStudioImages,
  buildStudioMessages,
  diffWords,
  findStudioVariant,
  isStudioVariantCount,
  labelStudioVariants,
  parseStudioReply,
  renderStudioSystem,
  studioSessionTitle,
  studioContextError,
  type StudioMessage,
} from "./prompt-studio";
import { ENHANCE_MODELS, getEnhanceModel } from "./prompt-enhance";
import { REFERENCE_PROFILES } from "./reference-profile";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const answer = (labels: string[]): StudioMessage => ({
  role: "assistant",
  variants: labels.map((label) => ({
    label,
    title: `T${label}`,
    summary: "",
    prompt: `P${label}`,
  })),
  model: "Grok 4.6",
  provider: "grok",
  fellBack: false,
  durationMs: 1000,
  at: 1,
});

describe("parseStudioReply", () => {
  test("reads the documented shape", () => {
    const reply = parseStudioReply(
      JSON.stringify({
        title: "Танец в пустыне",
        variants: [
          { title: "Облёт", summary: "Камера обходит её", prompt: "A woman dances." },
          { title: "Статика", summary: "Камера стоит", prompt: "She sways.", basedOn: "2" },
        ],
      }),
    );
    assert.deepEqual(reply, {
      title: "Танец в пустыне",
      variants: [
        { title: "Облёт", summary: "Камера обходит её", prompt: "A woman dances." },
        { title: "Статика", summary: "Камера стоит", prompt: "She sways.", basedOn: "2" },
      ],
    });
  });

  test("survives a code fence, prose around it and raw line breaks in strings", () => {
    const raw =
      'Here you go:\n```json\n{"variants": [{"title": "H3", "summary": "s", "prompt": "line one\nline two\tend"}]}\n```';
    assert.equal(parseStudioReply(raw)?.variants[0].prompt, "line one\nline two\tend");
  });

  test("accepts a bare array and string items", () => {
    assert.deepEqual(parseStudioReply('["first prompt", {"prompt": "second"}]')?.variants, [
      { title: "", summary: "", prompt: "first prompt" },
      { title: "", summary: "", prompt: "second" },
    ]);
  });

  test("normalises basedOn labels", () => {
    const reply = parseStudioReply(
      '{"variants":[{"prompt":"x","basedOn":"variant #2.1"},{"prompt":"y","basedOn":3}]}',
    );
    assert.deepEqual(
      reply?.variants.map((v) => v.basedOn),
      ["2.1", "3"],
    );
  });

  test("drops variants without a prompt and gives up on prose", () => {
    assert.equal(parseStudioReply('{"variants":[{"title":"empty"}]}'), null);
    assert.equal(parseStudioReply("I'm sorry, I can't help with that."), null);
  });

  test("caps model output before storing it", () => {
    const reply = parseStudioReply(
      JSON.stringify({
        variants: Array.from({ length: 8 }, () => ({
          prompt: "x".repeat(9000),
          title: "t".repeat(100),
          summary: "s".repeat(500),
          changes: "c".repeat(500),
        })),
      }),
    );
    assert.equal(reply?.variants.length, 3);
    assert.equal(reply?.variants[0].prompt.length, 8000);
    assert.equal(reply?.variants[0].title.length, 80);
    assert.equal(reply?.variants[0].summary.length, 400);
    assert.equal(reply?.variants[0].changes?.length, 400);
  });
});

describe("labelStudioVariants", () => {
  test("numbers fresh variants after the highest top-level label", () => {
    const history = [answer(["1", "2", "3"]), answer(["2.1"])];
    const labelled = labelStudioVariants(history, [
      { title: "a", summary: "", prompt: "a" },
      { title: "b", summary: "", prompt: "b" },
    ]);
    assert.deepEqual(
      labelled.map((v) => v.label),
      ["4", "5"],
    );
    assert.equal(labelled[0].parentLabel, undefined);
  });

  test("a revision of a known label becomes its next child", () => {
    const history = [answer(["1", "2", "3"]), answer(["2.1"])];
    const labelled = labelStudioVariants(history, [
      { title: "a", summary: "", prompt: "a", basedOn: "2", changes: "slower" },
      { title: "b", summary: "", prompt: "b", basedOn: "2" },
    ]);
    assert.deepEqual(
      labelled.map((v) => [v.label, v.parentLabel, v.changes]),
      [
        ["2.2", "2", "slower"],
        ["2.3", "2", undefined],
      ],
    );
  });

  test("falls back to the quoted variant, and ignores unknown basedOn", () => {
    const history = [answer(["1", "2"])];
    assert.deepEqual(
      labelStudioVariants(history, [{ title: "", summary: "", prompt: "x" }], "1").map((v) => [
        v.label,
        v.title,
      ]),
      [["1.1", "Variant 1.1"]],
    );
    assert.deepEqual(
      labelStudioVariants(history, [{ title: "t", summary: "", prompt: "x", basedOn: "9" }]).map(
        (v) => v.label,
      ),
      ["3"],
    );
  });

  test("findStudioVariant looks labels up", () => {
    const history = [answer(["1", "2"]), answer(["2.1"])];
    assert.equal(findStudioVariant(history, "2.1")?.prompt, "P2.1");
    assert.equal(findStudioVariant(history, "7"), undefined);
  });
});

describe("buildStudioMessages", () => {
  const context = {
    media: "video" as const,
    targetModel: "Seedance 2.0",
    duration: 10,
    aspectRatio: "9:16",
    referenceCount: 2,
    tagsInPrompt: true,
  };

  test("shows images after their tags in the last message only", () => {
    const messages = buildStudioMessages({
      history: [{ role: "user", text: "first", at: 0 }, answer(["1"])],
      text: "Девушка с @image1 в платье с @image2",
      variantCount: 3,
      context,
      images: [PNG, PNG],
    });
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(
      messages[2].content,
      JSON.stringify({ variants: [{ label: "1", title: "T1", prompt: "P1" }] }),
    );
    const last = messages[3].content;
    assert.equal(Array.isArray(last), true);
    if (!Array.isArray(last)) return;
    assert.deepEqual(
      last.map((p) => (p.type === "text" ? p.text.slice(0, 7) : "IMG")),
      ["@image1", "IMG", "@image2", "IMG", "Девушка"],
    );
    assert.ok(String(messages[0].content).includes("shown to you in the last message"));
    assert.ok(String(messages[0].content).includes("exactly 3 items"));
  });

  test("quotes the variant being revised and the current prompt", () => {
    const messages = buildStudioMessages({
      history: [],
      text: "slower",
      replyTo: { label: "2", title: "Spin", summary: "", prompt: "She spins." },
      variantCount: 1,
      context: { ...context, referenceCount: 0 },
      currentPrompt: "old prompt",
      images: [],
    });
    const last = String(messages[1].content);
    assert.ok(last.includes('"basedOn": "2"'));
    assert.ok(last.includes("She spins."));
    assert.ok(last.includes("old prompt"));
    assert.equal(last.endsWith("(Answer with 1 variant.)"), true);
  });

  test("history starts with the user and keeps only the recent turns", () => {
    const history: StudioMessage[] = [];
    for (let i = 1; i <= 8; i++)
      history.push({ role: "user", text: `u${i}`, at: i }, answer([`${i}`]));
    const messages = buildStudioMessages({
      history,
      text: "x",
      variantCount: 1,
      context,
      images: [],
    });
    assert.deepEqual(messages[1], { role: "user", content: "u4" });
    assert.equal(messages.length, 1 + 10 + 1);
  });

  test("tells a blind model not to guess and frames how references are used", () => {
    assert.ok(
      renderStudioSystem(context, { variantCount: 2, seenImages: 0 }).includes(
        "you cannot see them",
      ),
    );
    assert.ok(
      renderStudioSystem(
        { ...context, tagsInPrompt: false },
        { variantCount: 2, seenImages: 2 },
      ).includes("never write @imageN"),
    );
    assert.ok(
      renderStudioSystem(
        { ...context, frameSlots: ["Start", "End"] },
        { variantCount: 2, seenImages: 2 },
      ).includes("fixed frames, in order: Start, End"),
    );
  });

  test("a recipe becomes the format without the Enhance house rules", () => {
    const system = renderStudioSystem(context, {
      variantCount: 1,
      seenImages: 1,
      format: { title: "Describe shot", instructions: "One shot of {{duration}} seconds." },
    });
    assert.ok(system.includes("One shot of 10 seconds."));
    assert.ok(system.includes("you can see them"));
    assert.ok(!system.includes("Reply with the finished prompt only"));
  });

  test("a fixed-frame recipe does not reintroduce reference tags", () => {
    const system = renderStudioSystem(
      { ...context, tagsInPrompt: false, frameSlots: ["Start", "End"], referenceCount: 1 },
      {
        variantCount: 1,
        seenImages: 1,
        format: {
          title: "Frame recipe",
          instructions: "{{references}}\n{{h3Inputs}}\n{{ltxStart}}",
        },
      },
    );
    assert.ok(system.includes("Use the provided start image exactly as the first frame."));
    assert.ok(!system.includes("addressable in the prompt as"));
    assert.ok(!system.includes("subject_definitions:"));
    assert.ok(!system.includes("final frame of the target video, <Picture 2>"));
  });

  test("keeps Grok frame roles and keyframe times in the request", () => {
    const system = renderStudioSystem(
      { ...context, referenceRoles: ["first", "keyframe at 3 seconds"] },
      { variantCount: 1, seenImages: 2 },
    );
    assert.ok(system.includes("@image1: first; @image2: keyframe at 3 seconds"));
  });
});

describe("diffWords", () => {
  test("marks removed and added words", () => {
    assert.deepEqual(diffWords("a close-up of her face", "a wide shot of her face"), [
      { kind: "same", text: "a " },
      { kind: "removed", text: "close-up " },
      { kind: "added", text: "wide shot " },
      { kind: "same", text: "of her face" },
    ]);
  });

  test("identical text is one segment", () => {
    assert.deepEqual(diffWords("same text", "same text"), [{ kind: "same", text: "same text" }]);
  });
});

describe("guards", () => {
  test("variant counts and images", () => {
    assert.equal(isStudioVariantCount(3), true);
    assert.equal(isStudioVariantCount(4), false);
    assert.equal(areStudioImages([PNG, PNG]), true);
    assert.equal(areStudioImages([PNG, PNG, PNG, PNG, PNG]), false);
    assert.equal(areStudioImages(["https://example.com/a.png"]), false);
  });

  test("four prepared images fit the Node argument budget; oversized batches fail", () => {
    const maxBase64 = 4 * Math.ceil(REFERENCE_PROFILES.studio.maxBytes / 3);
    const image = `data:image/jpeg;base64,${"a".repeat(maxBase64)}`;
    assert.equal(areStudioImages(Array(4).fill(image)), true);
    assert.ok(4 * image.length + 100_000 < 5 * 1024 * 1024);
    const larger = `data:image/jpeg;base64,${"a".repeat(1_500_000)}`;
    assert.equal(areStudioImages(Array(4).fill(larger)), false);
  });

  test("rejects unbounded or non-finite generation context", () => {
    assert.equal(studioContextError({ media: "video", referenceCount: 4, duration: 10 }), null);
    for (const patch of [
      { referenceCount: 1e9 },
      { referenceCount: -1 },
      { referenceCount: 1.5 },
      { duration: NaN },
      { duration: Infinity },
      { targetModel: "x".repeat(201) },
      { frameSlots: Array(33).fill("Start") },
      { referenceRoles: ["x".repeat(81)] },
    ])
      assert.ok(studioContextError({ media: "video", ...patch }));
  });

  test("only the Grok family is marked as seeing images", () => {
    assert.deepEqual(
      ENHANCE_MODELS.filter((m) => m.vision).map((m) => m.id),
      [
        "grok:grok-4.6",
        "grok:grok-4.5",
        "grok:grok-4.3",
        "atlas:xai/grok-4.6",
        "atlas:xai/grok-4.5",
        "atlas:xai/grok-4.3",
      ],
    );
    assert.equal(getEnhanceModel("atlas:xiaomi/mimo-v2.5").vision, undefined);
  });

  test("session titles", () => {
    assert.equal(studioSessionTitle(" Танец ", "x"), "Танец");
    assert.equal(studioSessionTitle(undefined, "a  b\nc"), "a b c");
    assert.equal(studioSessionTitle("", "x".repeat(80)).endsWith("…"), true);
  });
});
