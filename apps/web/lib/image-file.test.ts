import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REFERENCE_IMAGE_ACCEPT,
  isAttachableImageFile,
  pastedImageFiles,
  referenceImageBlob,
} from "./image-file";

test("pasting text into a field takes priority over an image in the same clipboard", () => {
  const file = new File(["image"], "image.png", { type: "image/png" });
  const clipboard = {
    files: [file] as unknown as FileList,
    getData: (type: string) => (type === "text/plain" ? "dictated text" : ""),
  };
  assert.deepEqual(pastedImageFiles(clipboard, true), []);
  assert.deepEqual(pastedImageFiles(clipboard, false), [file]);
});

test("image-only pastes still attach from a text field, but non-images don't", () => {
  const image = new File(["image"], "image.png", { type: "image/png" });
  const text = new File(["text"], "notes.txt", { type: "text/plain" });
  const clipboard = {
    files: [image, text] as unknown as FileList,
    getData: () => "",
  };
  assert.deepEqual(pastedImageFiles(clipboard, true), [image]);
  assert.deepEqual(pastedImageFiles({ ...clipboard, files: [] as unknown as FileList }, true), []);
});

test("the file dialog names avif, webp and gif explicitly", () => {
  for (const token of [".avif", "image/avif", ".webp", "image/webp", ".gif", "image/gif"]) {
    assert.match(REFERENCE_IMAGE_ACCEPT, new RegExp(`(^|,)${token.replace("/", "\\/")}(,|$)`));
  }
});

test("avif, webp and gif are attachable when the browser reports no image type", () => {
  for (const name of ["shot.avif", "shot.webp", "shot.gif"]) {
    assert.equal(isAttachableImageFile({ name, type: "" }), true);
    assert.equal(
      isAttachableImageFile({ name: name.toUpperCase(), type: "application/octet-stream" }),
      true,
    );
  }
  assert.equal(isAttachableImageFile({ name: "shot.webp", type: "image/webp" }), true);
  assert.equal(isAttachableImageFile({ name: "shot.gif", type: "image/gif" }), true);
  assert.equal(isAttachableImageFile({ name: "shot.jpeg", type: "image/jpeg" }), true);
});

test("an empty type is not a free pass for other files", () => {
  assert.equal(isAttachableImageFile({ name: "notes.txt", type: "" }), false);
  assert.equal(isAttachableImageFile({ name: "clip.mp4", type: "video/mp4" }), false);
  assert.equal(isAttachableImageFile({ name: "page.html", type: "text/html" }), false);
});

test("an untyped picture is relabeled with its own type without copying", () => {
  for (const [name, type] of [
    ["shot.avif", "image/avif"],
    ["shot.webp", "image/webp"],
    ["shot.gif", "image/gif"],
  ] as const) {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type: "" });
    const blob = referenceImageBlob(file);
    assert.equal(blob.type, type);
    assert.equal(blob.size, file.size);
    assert.notEqual(blob, file);
  }
});

test("a typed image is left as the original file", () => {
  const file = new File([new Uint8Array([1])], "shot.jpg", { type: "image/jpeg" });
  assert.equal(referenceImageBlob(file), file);
});
