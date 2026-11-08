import { useAction, useMutation } from "convex/react";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { mediaUrl } from "@/lib/media-url";

export type EnhanceMode = "img2img" | "upscale" | "refine" | "facefix";

export const ENHANCE_LABELS: Record<EnhanceMode, string> = {
  upscale: "Upscale",
  facefix: "Fix faces",
  refine: "Refine",
  img2img: "Img2img",
};

/**
 * Enhancement, run on an image that already exists.
 *
 * It stopped being a section: these are four things you do *to* a picture, and
 * that is how they are reached — from a long press on the picture. The source
 * goes to Convex storage first because the pod needs bytes, not a URL, and only
 * Convex can hand it those.
 */
export function useEnhance() {
  const uploadUrl = useMutation(api.grokGenerations.generateRefUploadUrl);
  const enhance = useAction(api.enhanceProcessor.enhance);
  const [running, setRunning] = useState<EnhanceMode | null>(null);

  /**
   * `sourceGenerationId` is what makes Face Fix keep the picture's own style: the
   * action reads the checkpoint, prompt and LoRAs off that row and re-renders the
   * face with them. Absent — a hosted-API result — it falls back,
   * which is what every enhancement did before.
   */
  const run = useCallback(
    async (mode: EnhanceMode, b2Key: string, sourceGenerationId?: Id<"generations">) => {
      if (running) return;
      setRunning(mode);
      try {
        const blob = await fetch(mediaUrl(b2Key)).then((response) => response.blob());
        const response = await fetch(await uploadUrl(), {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: blob,
        });
        // Checked, as the reference upload now is: parsing the body regardless
        // produced an undefined storage id, which reached the action and failed
        // there with an error about the wrong thing.
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
        const { storageId } = (await response.json()) as { storageId?: Id<"_storage"> };
        if (!storageId) throw new Error("Upload returned no storage id");

        const result = await enhance({
          mode,
          sourceStorageId: storageId,
          sourceB2Key: b2Key,
          sourceGenerationId,
        });
        if (result.warning) {
          // Not a failure — the detector found nothing to work on, and saying so
          // beats an error that implies something broke.
          Alert.alert(ENHANCE_LABELS[mode], result.warning);
        }
      } catch (error) {
        Alert.alert(
          `${ENHANCE_LABELS[mode]} failed`,
          error instanceof Error ? error.message : "Unknown error",
        );
      } finally {
        setRunning(null);
      }
    },
    [running, uploadUrl, enhance],
  );

  return { run, running };
}
