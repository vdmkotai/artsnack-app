/**
 * Observed during dictation: a nonempty paste and uncancelled beforeinput, but no
 * input or DOM edit. A clipboard change before Chromium's default insertion is a
 * possible cause. Insert the event's snapshot without reading the OS clipboard
 * again. The editing command preserves selection replacement and native undo.
 */
export function pasteTextareaText(
  textarea: HTMLTextAreaElement,
  event: Pick<ClipboardEvent, "clipboardData" | "defaultPrevented" | "preventDefault">,
): void {
  const doc = textarea.ownerDocument;
  if (
    event.defaultPrevented ||
    textarea.disabled ||
    textarea.readOnly ||
    doc.activeElement !== textarea
  )
    return;

  const text = event.clipboardData?.getData("text/plain");
  if (!text) return;

  const before = textarea.value;
  let inserted = false;
  try {
    inserted = doc.execCommand("insertText", false, text);
  } catch {
    // Unsupported browsers retain their normal paste path.
  }
  // Some engines can change the value even when the command reports failure.
  // Never let their default action insert the same text a second time.
  if (inserted || textarea.value !== before) event.preventDefault();
}
