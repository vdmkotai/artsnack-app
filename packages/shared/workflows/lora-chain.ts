/**
 * The LoRA chain shared by /api/generate and /api/enhance.
 *
 * Both routes build a ComfyUI graph with the same node numbering — "4" is the
 * checkpoint loader, "6"/"7" the positive/negative CLIPTextEncode and "3" the
 * KSampler — so the chaining is genuinely one behaviour, and it lived in two
 * files character-for-character identical. A divergence between the copies would
 * make the same LoRA stack behave differently in Generate and Enhance with no
 * error anywhere, which is exactly the kind of break a test cannot catch when
 * the code is inline in a route.
 */

export interface LoraInput {
  enabled: boolean;
  loraName: string;
  strengthModel: number;
  strengthClip: number;
}

/**
 * Which nodes consume the end of the chain.
 *
 * The default is the sampler-shaped graph the numbering comment above describes.
 * Face Fix is the exception: it has no KSampler at all — the model and clip go
 * into one or two FaceDetailer nodes instead, and the second one only exists
 * when the eye pass is on. So the ids are a parameter, and a listed id that is
 * absent from the graph is skipped rather than conjured into existence.
 */
export interface LoraChainTargets {
  /** Nodes with a `model` input to re-point. */
  model: string[];
  /** Nodes with a `clip` input to re-point. */
  clip: string[];
}

const DEFAULT_TARGETS: LoraChainTargets = { model: ["3"], clip: ["6", "7"] };

/**
 * Inserts a LoraLoader per enabled LoRA and re-points the consuming nodes' model
 * and clip inputs at the end of the chain. Mutates `workflow` in place and is a
 * no-op when nothing is enabled.
 */
export function applyLoraChain(
  workflow: Record<string, object>,
  loras: LoraInput[],
  targets: LoraChainTargets = DEFAULT_TARGETS,
): void {
  const activeLoras = (loras || []).filter((l) => l.enabled && l.loraName && l.loraName !== "None");

  if (activeLoras.length === 0) {
    return;
  }

  let prevModelOutput: [string, number] = ["4", 0];
  let prevClipOutput: [string, number] = ["4", 1];

  activeLoras.forEach((lora, index) => {
    const nodeId = `lora_${index}`;
    workflow[nodeId] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: lora.loraName,
        strength_model: lora.strengthModel,
        strength_clip: lora.strengthClip,
        model: prevModelOutput,
        clip: prevClipOutput,
      },
    };
    prevModelOutput = [nodeId, 0];
    prevClipOutput = [nodeId, 1];
  });

  const repoint = (nodeId: string, input: "model" | "clip", from: [string, number]) => {
    const node = workflow[nodeId] as { inputs?: object } | undefined;
    if (!node) return;
    workflow[nodeId] = { ...node, inputs: { ...node.inputs, [input]: from } };
  };

  for (const nodeId of targets.model) repoint(nodeId, "model", prevModelOutput);
  for (const nodeId of targets.clip) repoint(nodeId, "clip", prevClipOutput);
}
