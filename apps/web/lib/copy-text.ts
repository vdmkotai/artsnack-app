import { toast } from "sonner";

/**
 * Copies text to the clipboard and says so, or says why not.
 *
 * `navigator.clipboard` is undefined on an insecure origin — plain http on a
 * LAN, which `bun dev` serves — so reading `.writeText` off it throws
 * synchronously, before any promise exists. A trailing `.catch()` never sees
 * that. And a copy that silently does nothing is worse than one that fails
 * loudly, because the user walks away believing they have the text.
 *
 * Returns whether it worked, so callers can show a tick.
 */
export async function copyText(text: string, label = "Prompt"): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast.error("Clipboard is unavailable here — it needs a secure (https) page");
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error(`Could not copy the ${label.toLowerCase()}`);
    return false;
  }
}
