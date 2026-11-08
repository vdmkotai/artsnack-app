import { useAction } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMMKV } from "react-native-mmkv";

import { api } from "@/convex/_generated/api";
import { SAMPLERS, SCHEDULERS } from "@/lib/comfy-catalog";

const store = createMMKV({ id: "artsnack.local-composer" });
const FORM_KEY = "form";

export type LoraSlot = {
  enabled: boolean;
  loraName: string;
  strengthModel: number;
  strengthClip: number;
};

export type LocalForm = {
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  batchSize: number;
  loras: LoraSlot[];
};

export const DEFAULT_LOCAL_FORM: LocalForm = {
  prompt: "",
  negativePrompt: "",
  checkpoint: "",
  width: 1024,
  height: 1024,
  // -1 is the pod's own "pick one", which is what a fresh form should do.
  seed: -1,
  steps: 30,
  cfg: 7,
  sampler: "dpmpp_2m",
  scheduler: "karras",
  denoise: 1,
  batchSize: 4,
  loras: [],
};

function load(): LocalForm {
  const raw = store.getString(FORM_KEY);
  if (!raw) return DEFAULT_LOCAL_FORM;
  try {
    return { ...DEFAULT_LOCAL_FORM, ...(JSON.parse(raw) as Partial<LocalForm>) };
  } catch {
    return DEFAULT_LOCAL_FORM;
  }
}

/**
 * The self-hosted composer.
 *
 * Unlike the API side there is nothing to clamp against — the pod accepts what
 * it accepts, and `boundParams` in Convex is what refuses a value it would choke
 * on. So this is state and a submit, and the catalogue that fills the pickers.
 */
export function useLocalComposer() {
  const [form, setFormState] = useState<LocalForm>(load);
  const [catalog, setCatalog] = useState<{
    checkpoints: string[];
    loras: string[];
    samplers: readonly string[];
    schedulers: readonly string[];
    error?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCatalog = useAction(api.podCatalog.catalog);
  const generate = useAction(api.podSubmit.generate);

  const setForm = useCallback((patch: Partial<LocalForm>) => {
    setFormState((previous) => {
      const next = { ...previous, ...patch };
      store.set(FORM_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /**
   * Discards a probe that a later one has already superseded, and gives the failure
   * somewhere to go.
   *
   * `refresh` is a button as well as a mount effect, so two can be in flight at once —
   * tapping ↻ twice on a slow pod put the older answer on screen after the newer one.
   * And the promise had no rejection handler at all: the action returns its errors in
   * the result, but a Convex transport failure or an expired token rejects, which
   * showed up as an unhandled rejection and a dot that stayed grey with no explanation.
   */
  const probe = useRef(0);

  const refresh = useCallback(() => {
    const token = ++probe.current;
    void fetchCatalog({})
      .then((result) => {
        if (token !== probe.current) return;
        setCatalog(result);
        // A pod that came up after the form did leaves the checkpoint unset;
        // adopting the first one it reports beats an empty picker.
        setFormState((previous) => {
          if (previous.checkpoint || result.checkpoints.length === 0) return previous;
          const next = { ...previous, checkpoint: result.checkpoints[0] };
          store.set(FORM_KEY, JSON.stringify(next));
          return next;
        });
      })
      .catch((cause: unknown) => {
        if (token !== probe.current) return;
        setCatalog({
          checkpoints: [],
          loras: [],
          samplers: SAMPLERS,
          schedulers: SCHEDULERS,
          error: cause instanceof Error ? cause.message : "Could not reach the backend",
        });
      });
  }, [fetchCatalog]);

  useEffect(refresh, [refresh]);

  /**
   * Recreate: everything a past run used, restored verbatim.
   *
   * There is nothing to match against the catalogue — the row was produced by
   * this pod with these exact names — so the settings are taken as they are.
   * What *can* have changed is the pod: a checkpoint or LoRA
   * uninstalled since is reported rather than silently dropped, because a
   * missing name reaches ComfyUI as a hard error at submit time.
   */
  const recreate = useCallback(
    (restored: LocalForm) => {
      setForm(restored);
      const missing: string[] = [];
      if (catalog && restored.checkpoint && !catalog.checkpoints.includes(restored.checkpoint)) {
        missing.push(`Checkpoint "${restored.checkpoint}" is not installed.`);
      }
      for (const slot of restored.loras) {
        if (catalog && slot.loraName && !catalog.loras.includes(slot.loraName)) {
          missing.push(`LoRA "${slot.loraName}" is not installed.`);
        }
      }
      return missing;
    },
    [catalog, setForm],
  );

  /** Resolves to whether a job was actually started, so the caller can navigate. */
  const submit = useCallback(async (): Promise<boolean> => {
    if (submitting || form.prompt.trim().length === 0) return false;
    setSubmitting(true);
    setError(null);
    try {
      await generate({ formState: form, backend: "comfyui" });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the generation");
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [submitting, form, generate]);

  return {
    form,
    setForm,
    catalog,
    refresh,
    recreate,
    submit,
    submitting,
    error,
    online: catalog !== null && !catalog.error,
    /**
     * A checkpoint the pod is actually holding, not merely a non-empty string.
     *
     * The form persists across launches, so `checkpoint` keeps whatever the last pod
     * had installed — and the pod is routinely a different one, or off. Submitting then
     * reaches ComfyUI as a hard node error minutes later, after a queue wait, phrased
     * in ComfyUI's terms. The button is the right place to say no: with no pod there is
     * nothing to submit to, and the status line above already says which it is.
     */
    canSubmit:
      form.prompt.trim().length > 0 &&
      !submitting &&
      catalog !== null &&
      catalog.checkpoints.includes(form.checkpoint) &&
      form.loras.every((slot) => !slot.enabled || catalog.loras.includes(slot.loraName)),
  };
}
