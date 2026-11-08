import { createContext, use, type ReactNode } from "react";

import { useLocalComposer } from "@/features/local/use-local-composer";

import { setEngine, useEngine, type Engine } from "./engine-store";
import { useComposer } from "./use-composer";

type Composers = {
  api: ReturnType<typeof useComposer>;
  local: ReturnType<typeof useLocalComposer>;
  engine: Engine;
  setEngine: (next: Engine) => void;
};

const ComposerContext = createContext<Composers | null>(null);

/**
 * Both composers' state lives on the stack, not on a screen.
 *
 * The engine picker, the parameter sheet and the prompt library are separate
 * routes that all edit the same form, so the form cannot belong to the screen.
 * That was a live bug: the Create screen called `useComposer()` a second time, so
 * picking Grok in the sheet wrote to the provider's copy while the header kept
 * rendering the screen's — the label stayed on Seedream until the app restarted.
 *
 * The self-hosted composer is here for the same reason, and gets its catalogue
 * warm before the form is first looked at.
 */
export function ComposerProvider({ children }: { children: ReactNode }) {
  const api = useComposer();
  const local = useLocalComposer();
  const engine = useEngine();

  return <ComposerContext value={{ api, local, engine, setEngine }}>{children}</ComposerContext>;
}

export function useComposerContext(): Composers {
  const composers = use(ComposerContext);
  if (!composers) throw new Error("useComposerContext used outside ComposerProvider");
  return composers;
}
