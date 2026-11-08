import assert from "node:assert/strict";
import test from "node:test";

import { API_MODEL_IDS, getApiModel, modelsForProvider, videoResolutions } from "./api-models";
import {
  buildHiggsfieldJob,
  costSignature,
  creditsOf,
  findMediaUrls,
  isModerationState,
  jobIdOf,
  jobStateOf,
  jobStatusesOf,
} from "./higgsfield-job";
import { HIGGSFIELD_LIST_PRICE } from "./higgsfield-prices";

test("Higgsfield models map onto the vendor's job types", () => {
  assert.equal(
    buildHiggsfieldJob({ model: "hf-seedream-4.5", mediaType: "image", prompt: "x" }).jobType,
    "seedream_v4_5",
  );
  assert.equal(
    buildHiggsfieldJob({ model: "hf-seedream-5-lite", mediaType: "image", prompt: "x" }).jobType,
    "seedream_v5_lite",
  );
  // Both Seedream models animate through the same Seedance job type.
  for (const model of ["hf-seedream-4.5", "hf-seedream-5-lite"] as const) {
    assert.equal(
      buildHiggsfieldJob({ model, mediaType: "video", prompt: "x" }).jobType,
      "seedance_2_0",
    );
  }
});

test("size is spelled the way each model spells it", () => {
  // 4.5 and Lite take `quality`; Pro takes `resolution`. Sending the other name
  // is an unknown-param rejection, so this is not interchangeable.
  const basic = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "image",
    prompt: "a cat",
    aspectRatio: "16:9",
    sizeTier: "high",
  });
  assert.deepEqual(Object.keys(basic.params).sort(), ["aspect_ratio", "prompt", "quality"]);
  assert.equal(basic.params.quality, "high");

  const pro = buildHiggsfieldJob({
    model: "hf-seedream-5-pro",
    mediaType: "image",
    prompt: "a cat",
    sizeTier: "1.5k",
  });
  assert.equal(pro.params.resolution, "1.5k");
  assert.ok(!("quality" in pro.params));
});

test("video params follow the selected model, not a shared shape", () => {
  const seedance = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    prompt: "a cat",
    aspectRatio: "9:16",
    durationSeconds: 12,
    resolution: "1080p",
    generateAudio: true,
  });
  assert.deepEqual(Object.keys(seedance.params).sort(), [
    "aspect_ratio",
    "duration",
    "generate_audio",
    "mode",
    "prompt",
    "resolution",
  ]);
  // Integer here, unlike fal, where the same model wants a string.
  assert.equal(seedance.params.duration, 12);

  // Kling exposes no resolution at all — quality rides on its mode.
  const kling = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    videoJobType: "kling3_0",
    prompt: "a cat",
    aspectRatio: "16:9",
    resolution: "1080p",
  });
  assert.ok(!("resolution" in kling.params));
  assert.equal(kling.params.mode, "std");
  // And no audio toggle.
  assert.ok(!("generate_audio" in kling.params));
});

test("an auto ratio is left off rather than sent as the literal 'auto'", () => {
  const params = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "image",
    prompt: "x",
    aspectRatio: "auto",
  }).params;
  assert.ok(!("aspect_ratio" in params));
});

test("a single reference defines the shape, and 'auto' is how you say so", () => {
  // Every video schema defaults to 16:9, so omitting the ratio would crop a
  // portrait start frame. "auto" is the value that means "use the frame".
  assert.equal(
    buildHiggsfieldJob({ model: "hf-seedream-4.5", mediaType: "video", prompt: "x" }).params
      .aspect_ratio,
    "auto",
  );
  // Wan has no "auto", so there is nothing honest to send and it is omitted.
  assert.ok(
    !(
      "aspect_ratio" in
      buildHiggsfieldJob({
        model: "hf-seedream-4.5",
        mediaType: "video",
        videoJobType: "wan2_7",
        prompt: "x",
      }).params
    ),
  );
});

test("references go to the slot the model actually declares", () => {
  const flagFor = (videoJobType: string) =>
    buildHiggsfieldJob({
      model: "hf-seedream-4.5",
      mediaType: "video",
      videoJobType,
      prompt: "x",
      aspectRatio: "16:9",
    }).mediaFlags;

  // Only the Seedance pair declares image_references — that is what makes
  // @-tagging in the prompt mean anything.
  assert.deepEqual(flagFor("seedance_2_0"), ["image-references"]);
  assert.deepEqual(flagFor("seedance_2_0_mini"), ["image-references"]);
  // The rest have discrete frame slots that each take exactly one input, so a
  // repeated --start-image is a vendor rejection.
  assert.deepEqual(flagFor("wan2_7"), ["start-image", "end-image"]);
  assert.deepEqual(flagFor("kling3_0"), ["start-image", "end-image"]);
  // Happy Horse has no end frame at all.
  assert.deepEqual(flagFor("happy_horse_video"), ["start-image"]);

  assert.deepEqual(
    buildHiggsfieldJob({ model: "hf-seedream-4.5", mediaType: "image", prompt: "x" }).mediaFlags,
    ["image-references"],
  );
});

test("out-of-enum settings are refused rather than sent", () => {
  const base = { model: "hf-seedream-4.5", prompt: "x" } as const;

  // Their image enum has no 2:1 or 1:2, however natural those look.
  assert.throws(
    () => buildHiggsfieldJob({ ...base, mediaType: "image", aspectRatio: "2:1" }),
    /does not support/,
  );
  // It does have 21:9, which the fal side does not.
  assert.equal(
    buildHiggsfieldJob({ ...base, mediaType: "image", aspectRatio: "21:9" }).params.aspect_ratio,
    "21:9",
  );
  assert.throws(
    () => buildHiggsfieldJob({ ...base, mediaType: "video", durationSeconds: 7.5 }),
    /does not support 7.5s/,
  );
  // Per model, not the union: Wan reaches 2s and Seedance does not, and the
  // form offers exactly what each one takes.
  assert.equal(
    buildHiggsfieldJob({ ...base, mediaType: "video", videoJobType: "wan2_7", durationSeconds: 2 })
      .params.duration,
    2,
  );
  assert.throws(
    () =>
      buildHiggsfieldJob({
        ...base,
        mediaType: "video",
        videoJobType: "seedance_2_0",
        durationSeconds: 2,
      }),
    /does not support 2s/,
  );
  // Wan tops out at 1080p.
  assert.throws(
    () =>
      buildHiggsfieldJob({ ...base, mediaType: "video", videoJobType: "wan2_7", resolution: "4k" }),
    /does not support 4k/,
  );
  // Their own rule: Seedance fast is 480p/720p only.
  assert.throws(
    () =>
      buildHiggsfieldJob({
        ...base,
        mediaType: "video",
        mode: "fast",
        resolution: "1080p",
        aspectRatio: "16:9",
      }),
    /Fast mode supports 480p and 720p/,
  );
  // "auto" is a real video ratio but not an image one, so it is dropped there.
  assert.ok(
    !(
      "aspect_ratio" in
      buildHiggsfieldJob({ ...base, mediaType: "image", aspectRatio: "auto" }).params
    ),
  );
  assert.equal(
    buildHiggsfieldJob({ ...base, mediaType: "video", aspectRatio: "auto" }).params.aspect_ratio,
    "auto",
  );
});

test("non-Higgsfield models are refused", () => {
  for (const id of API_MODEL_IDS) {
    if (getApiModel(id).provider === "higgsfield") continue;
    assert.throws(
      () => buildHiggsfieldJob({ model: id, mediaType: "image", prompt: "x" }),
      /not a Higgsfield model/,
    );
  }
});

test("the cost signature ignores the prompt but tracks every priced setting", () => {
  const base = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    prompt: "one prompt",
    durationSeconds: 10,
    resolution: "720p",
    aspectRatio: "16:9",
  });
  const other = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    prompt: "a completely different prompt",
    durationSeconds: 10,
    resolution: "720p",
    aspectRatio: "16:9",
  });
  assert.equal(costSignature(base), costSignature(other));

  const longer = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    prompt: "one prompt",
    durationSeconds: 15,
    resolution: "720p",
    aspectRatio: "16:9",
  });
  assert.notEqual(costSignature(base), costSignature(longer));

  // Measured against `higgsfield generate cost`: neither the aspect ratio nor a
  // start frame moves the price, and folding them into the key would split one
  // known number across two dozen entries that each need their own round trip.
  const portrait = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    prompt: "one prompt",
    durationSeconds: 10,
    resolution: "720p",
    aspectRatio: "9:16",
  });
  assert.equal(costSignature(base), costSignature(portrait));
  const withFrame = buildHiggsfieldJob({
    model: "hf-seedream-4.5",
    mediaType: "video",
    prompt: "one prompt",
    durationSeconds: 10,
    resolution: "720p",
    aspectRatio: "16:9",
    referenceCount: 1,
  });
  assert.equal(costSignature(base), costSignature(withFrame));
});

/**
 * The captured rate card is keyed by signature, so a typo in either one leaves
 * the button showing an ellipsis for a price we already know.
 */
test("every configuration the form can reach has a listed price", () => {
  const missing: string[] = [];
  for (const id of API_MODEL_IDS) {
    const model = getApiModel(id);
    if (model.provider !== "higgsfield") continue;

    for (const tier of model.image.sizeTiers) {
      const request = buildHiggsfieldJob({
        model: id,
        mediaType: "image",
        prompt: "probe",
        sizeTier: tier.value,
        aspectRatio: model.image.aspectRatios[0],
      });
      const signature = costSignature(request);
      if (HIGGSFIELD_LIST_PRICE[signature] === undefined) missing.push(signature);
    }

    const caps = model.video;
    if (caps.kind !== "higgsfield-video") continue;
    for (const video of caps.models) {
      const modes = video.modeParam?.values ?? [undefined];
      // Audio is priced on Kling, so both states are reachable configurations
      // and both need an entry.
      const audioStates = video.audioParam ? [true, false] : [undefined];
      for (const generateAudio of audioStates) {
        for (const mode of modes) {
          const resolutions = videoResolutions(caps, undefined, video.jobType, mode);
          for (const duration of video.durations) {
            for (const resolution of resolutions.length > 0 ? resolutions : [undefined]) {
              const request = buildHiggsfieldJob({
                model: id,
                mediaType: "video",
                prompt: "probe",
                videoJobType: video.jobType,
                mode,
                generateAudio,
                durationSeconds: duration,
                resolution,
                aspectRatio: video.aspectRatios[0],
              });
              const signature = costSignature(request);
              if (HIGGSFIELD_LIST_PRICE[signature] === undefined) missing.push(signature);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("job state is read tolerantly, because the payload shape is undocumented", () => {
  assert.equal(jobStateOf({ status: "completed" }), "succeeded");
  assert.equal(jobStateOf({ jobs: [{ job_status: "SUCCEEDED" }] }), "succeeded");
  assert.equal(jobStateOf({ status: "failed" }), "failed");
  assert.equal(jobStateOf({ status: "queued" }), "pending");
  // An unfamiliar status must read as "still running", never as success.
  assert.equal(jobStateOf({ status: "something_new" }), "pending");
  assert.equal(jobStateOf({}), "pending");
});

test("a content refusal is a terminal failure, not a job still running", () => {
  // `nsfw` is the status their CLI ships. Reading it as "still running" is what
  // made a refused prompt sit on "Generating..." for the full four minutes and
  // then report a timeout — the one explanation that was certainly wrong.
  assert.equal(jobStateOf({ status: "nsfw" }), "failed");
  assert.equal(jobStateOf({ jobs: [{ job_status: "NSFW" }] }), "failed");
  for (const status of ["moderated", "blocked", "declined", "content_moderated"]) {
    assert.equal(jobStateOf({ status }), "failed", status);
  }
});

test("a refusal is told apart from a breakage, because only one is billed", () => {
  assert.equal(isModerationState(jobStatusesOf({ status: "nsfw" })), true);
  assert.equal(isModerationState(jobStatusesOf({ jobs: [{ job_status: "Blocked" }] })), true);
  // A server-side failure is still a failure, but nobody was refused: it keeps
  // the generic kind, and with it the estimate of what it may have cost.
  assert.equal(isModerationState(jobStatusesOf({ status: "failed" })), false);
  assert.equal(isModerationState(jobStatusesOf({ status: "queued" })), false);
});

test("statuses are reported verbatim, so an unknown one can be named", () => {
  assert.deepEqual(jobStatusesOf({ jobs: [{ job_status: "QUEUED" }, { job_status: "Running" }] }), [
    "queued",
    "running",
  ]);
  // Nothing said at all is the case the timeout message has to word differently.
  assert.deepEqual(jobStatusesOf({}), []);
});

test("echoed inputs and thumbnails are not mistaken for the output", () => {
  // Job payloads repeat what went in. Taking the first url would have saved the
  // reference image as the generated video.
  const payload = {
    medias: [{ role: "start_image", url: "https://cdn/REFERENCE.jpg" }],
    preview: { url: "https://cdn/THUMB.jpg" },
    results: [{ url: "https://cdn/OUTPUT.mp4" }],
  };
  assert.deepEqual(findMediaUrls(payload, "video"), ["https://cdn/OUTPUT.mp4"]);

  // The media type filters by extension where one is present.
  const mixed = { results: [{ url: "https://cdn/a.jpg" }, { url: "https://cdn/b.mp4" }] };
  assert.deepEqual(findMediaUrls(mixed, "video"), ["https://cdn/b.mp4"]);
  assert.deepEqual(findMediaUrls(mixed, "image"), ["https://cdn/a.jpg"]);
  // An extensionless signed link is kept rather than guessed away.
  assert.deepEqual(findMediaUrls({ results: [{ url: "https://cdn/x?sig=1" }] }, "video"), [
    "https://cdn/x?sig=1",
  ]);
});

test("key lists are read as a priority order, not as a set", () => {
  // Traversal order would have returned the nested id and the wrong figure.
  assert.equal(jobIdOf({ id: "inner", job_set_id: "outer" }), "outer");
  assert.equal(creditsOf({ cost: 999, credits_exact: 12.5 }), 12.5);
});

test("a job id is readable even when the CLI prints bare ids", () => {
  // `generate create` without --wait prints ids, and their shape is undocumented.
  assert.equal(jobIdOf("uuid-1"), "uuid-1");
  assert.equal(jobIdOf(["uuid-1", "uuid-2"]), "uuid-1");
  assert.equal(jobIdOf([{ job_set_id: "uuid-3" }]), "uuid-3");
  assert.equal(jobIdOf(""), undefined);
});

test("one failed leg fails the whole job set", () => {
  // Higgsfield's unit of work is a set, so a partial failure is the normal
  // shape of a bad run — calling it a success would save half a result.
  assert.equal(jobStateOf({ jobs: [{ status: "completed" }, { status: "failed" }] }), "failed");
  assert.equal(
    jobStateOf({ jobs: [{ status: "completed" }, { status: "completed" }] }),
    "succeeded",
  );
  assert.equal(jobStateOf({ jobs: [{ status: "completed" }, { status: "queued" }] }), "pending");
});

test("media urls are found wherever the payload puts them", () => {
  assert.deepEqual(findMediaUrls({ results: [{ url: "https://cdn/a.png" }] }), [
    "https://cdn/a.png",
  ]);
  assert.deepEqual(findMediaUrls({ job: { results: [{ result_url: "https://cdn/a.mp4" }] } }), [
    "https://cdn/a.mp4",
  ]);
  // Duplicates collapse, and non-media strings are ignored.
  assert.deepEqual(
    findMediaUrls({
      a: { url: "https://cdn/a.png" },
      b: { url: "https://cdn/a.png" },
      docs: { href: "https://example.com" },
      note: "https://cdn/not-a-url-field.png",
    }),
    ["https://cdn/a.png"],
  );
  assert.deepEqual(findMediaUrls({}), []);
});

test("job id and credits are read from any nesting", () => {
  assert.equal(jobIdOf({ job_set_id: "abc" }), "abc");
  assert.equal(jobIdOf({ data: { job_id: "def" } }), "def");
  assert.equal(jobIdOf({}), undefined);

  assert.equal(creditsOf({ credits: 24 }), 24);
  assert.equal(creditsOf({ cost: { credits_exact: 12.5 } }), 12.5);
  assert.equal(creditsOf({}), undefined);
});

test("Higgsfield offers all three Seedream models", () => {
  const models = modelsForProvider("higgsfield");
  assert.deepEqual(
    models.map((model) => model.id),
    ["hf-seedream-4.5", "hf-seedream-5-lite", "hf-seedream-5-pro"],
  );
  for (const model of models) {
    assert.equal(model.image.kind, "higgsfield-image");
    assert.equal(model.video.kind, "higgsfield-video");
  }
});
