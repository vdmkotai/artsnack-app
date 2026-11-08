import assert from "node:assert/strict";
import test from "node:test";
import type * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { Textarea } from "./textarea";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function inputEvent(value: string) {
  const target = { value };
  return {
    nativeEvent: new Event("input"),
    target,
    currentTarget: target,
  } as unknown as React.ChangeEvent<HTMLTextAreaElement>;
}

test("an external input reaches the controlled owner even without React onChange", () => {
  const changes: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <Textarea value="before" onChange={(event) => changes.push(event.currentTarget.value)} />,
      );
    });
    assert.ok(renderer);
    act(() => renderer!.root.findByType("textarea").props.onInput(inputEvent("dictated text")));
    assert.deepEqual(changes, ["dictated text"]);
  } finally {
    act(() => renderer?.unmount());
  }
});

test("normal input notifies the owner once when both React handlers receive the event", () => {
  for (const order of ["input-first", "change-first"]) {
    const changes: string[] = [];
    let inputCalls = 0;
    let renderer: ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = create(
          <Textarea
            value=""
            onChange={(event) => changes.push(event.target.value)}
            onInput={() => inputCalls++}
          />,
        );
      });
      assert.ok(renderer);
      const handlers = renderer.root.findByType("textarea").props;
      for (const value of ["typed", "pasted", ""]) {
        const event = inputEvent(value);
        act(() => {
          if (order === "input-first") {
            handlers.onInput(event);
            handlers.onChange(event);
          } else {
            handlers.onChange(event);
            handlers.onInput(event);
          }
        });
      }
      assert.deepEqual(changes, ["typed", "pasted", ""], order);
      assert.equal(inputCalls, 3, order);
    } finally {
      act(() => renderer?.unmount());
    }
  }
});

test("external controlled updates don't emit edits and the next input uses the latest handler", () => {
  const previous: string[] = [];
  const current: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <Textarea value="draft" onChange={(event) => previous.push(event.target.value)} />,
      );
    });
    act(() => {
      renderer!.update(
        <Textarea value="saved prompt" onChange={(event) => current.push(event.target.value)} />,
      );
    });
    assert.deepEqual(previous, []);
    assert.deepEqual(current, []);
    act(() => renderer!.root.findByType("textarea").props.onInput(inputEvent("new dictation")));
    assert.deepEqual(previous, []);
    assert.deepEqual(current, ["new dictation"]);
  } finally {
    act(() => renderer?.unmount());
  }
});

test("multiple native events for one multiline insertion notify once", () => {
  const changes: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(
        <Textarea value="" onChange={(event) => changes.push(event.target.value)} />,
      );
    });
    assert.ok(renderer);
    const handlers = renderer.root.findByType("textarea").props;
    act(() => {
      for (let i = 0; i < 3; i++) {
        const event = inputEvent("line one\nline two");
        handlers.onInput(event);
        handlers.onChange(event);
      }
    });
    assert.deepEqual(changes, ["line one\nline two"]);
  } finally {
    act(() => renderer?.unmount());
  }
});
