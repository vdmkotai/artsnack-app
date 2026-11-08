import { Keyboard } from "react-native";
import { router } from "expo-router";

import type { PromptTarget } from "./prompt-editor";

/**
 * Open the prompt editor on one of the two fields.
 *
 * A function rather than an inline `router.push` at each of the three call sites,
 * because the keyboard dismissal is not optional and is easy to leave out: the
 * composer's other sheets all do it (see `(create)/index.tsx`), and without it a
 * keyboard raised by something else stays up over the modal that opens next.
 */
export function openPrompt(field: PromptTarget): void {
  Keyboard.dismiss();
  // `/edit-prompt`, not `/prompt`: `(create)` already has a `/prompts` route — the
  // saved-prompt library — and two routes a character apart is a mistake waiting to
  // be made by whoever reads this next.
  router.push({ pathname: "/edit-prompt", params: { field } });
}
