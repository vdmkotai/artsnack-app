"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { pasteTextareaText } from "@/lib/paste-text";

function Textarea({
  className,
  onChange,
  onInput,
  onPaste,
  ...props
}: React.ComponentProps<"textarea">) {
  const lastInputEvent = React.useRef<Event | null>(null);
  const lastValue = React.useRef(String(props.value ?? props.defaultValue ?? ""));

  React.useLayoutEffect(() => {
    if (props.value !== undefined) lastValue.current = String(props.value);
  }, [props.value]);

  // React's change plugin can miss an external edit made through the element's
  // JS value setter: its value tracker already thinks the new text is current.
  // The native input event still arrives. Accept either path, once per edit,
  // so a controlled field doesn't erase that edit on its next render.
  const notifyChange = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (lastInputEvent.current === event.nativeEvent) return;
    lastInputEvent.current = event.nativeEvent;
    const nextValue = event.currentTarget.value;
    // Chromium can emit several input events for one multiline insertion, all
    // carrying the same final value. Match onChange's value-change semantics.
    if (lastValue.current === nextValue) return;
    lastValue.current = nextValue;
    // A textarea has no editable descendants: the input target is the textarea,
    // just as it is for React's synthesized ChangeEvent.
    onChange?.(event as React.ChangeEvent<HTMLTextAreaElement>);
  };

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-md border border-input bg-input/20 px-2 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-xs/relaxed dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
      onPaste={(event) => {
        onPaste?.(event);
        pasteTextareaText(event.currentTarget, event);
      }}
      onChange={onChange ? notifyChange : undefined}
      onInput={(event) => {
        onInput?.(event);
        if (onChange) notifyChange(event);
      }}
    />
  );
}

export { Textarea };
