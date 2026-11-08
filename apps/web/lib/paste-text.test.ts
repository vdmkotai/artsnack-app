import assert from "node:assert/strict";
import test from "node:test";
import { pasteTextareaText } from "./paste-text";

function fixture(text = "dictated text") {
  const calls: unknown[][] = [];
  const doc = {
    activeElement: null as unknown,
    execCommand: (...args: unknown[]) => {
      calls.push(args);
      return true;
    },
  };
  const field = { ownerDocument: doc, value: "existing", disabled: false, readOnly: false };
  doc.activeElement = field;
  let reads = 0;
  const event = {
    defaultPrevented: false,
    clipboardData: {
      getData: (format: string) => {
        assert.equal(format, "text/plain");
        reads++;
        return reads === 1 ? text : "";
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  return {
    doc,
    field,
    event,
    calls,
    reads: () => reads,
    paste: () =>
      pasteTextareaText(
        field as unknown as HTMLTextAreaElement,
        event as unknown as ClipboardEvent,
      ),
  };
}

test("inserts the paste snapshot once even when later clipboard reads would be empty", () => {
  const f = fixture("Красный дом\n@image2");
  f.paste();
  assert.deepEqual(f.calls, [["insertText", false, "Красный дом\n@image2"]]);
  assert.equal(f.reads(), 1);
  assert.equal(f.event.defaultPrevented, true);
});

test("image-only or empty clipboards keep native and parent paste handling", () => {
  const f = fixture("");
  f.paste();
  assert.equal(f.event.defaultPrevented, false);
  assert.equal(f.calls.length, 0);
});

test("cancelled events, readonly fields and focus changes are respected", () => {
  for (const scenario of ["cancelled", "readonly", "disabled", "blurred"]) {
    const f = fixture();
    if (scenario === "cancelled") f.event.defaultPrevented = true;
    if (scenario === "readonly") f.field.readOnly = true;
    if (scenario === "disabled") f.field.disabled = true;
    if (scenario === "blurred") f.doc.activeElement = null;
    f.paste();
    assert.equal(f.calls.length, 0, scenario);
    assert.equal(f.reads(), 0, scenario);
  }
});

test("unsupported editing commands leave normal paste available", () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.doc.execCommand = () => {
      if (throws) throw new Error("unsupported");
      return false;
    };
    f.paste();
    assert.equal(f.event.defaultPrevented, false);
  }
});

test("a command that inserts but reports failure cannot cause duplicate insertion", () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.doc.execCommand = () => {
      f.field.value += "dictated text";
      if (throws) throw new Error("failure after insertion");
      return false;
    };
    f.paste();
    assert.equal(f.event.defaultPrevented, true);
  }
});
