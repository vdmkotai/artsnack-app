/**
 * The model files a ComfyUI graph loads, read off its loader nodes. A video
 * pod can only run a job whose every file it lists — each pod has its own disk
 * and its own downloads — so "Auto" pod selection checks exactly this list,
 * whatever the graph was built from (H3 or LTX, with or without add-ons).
 */

/** Loader node → the inputs that name a file. A node a pod does not have at
 *  all (an add-on's custom node) lists nothing, so it disqualifies the pod. */
const FILE_INPUTS: Record<string, readonly string[]> = {
  UNETLoader: ["unet_name"],
  LoraLoaderModelOnly: ["lora_name"],
  CLIPLoader: ["clip_name"],
  DualCLIPLoader: ["clip_name1", "clip_name2"],
  VAELoader: ["vae_name"],
  VAELoaderKJ: ["vae_name"],
  LatentUpscaleModelLoader: ["model_name"],
  FrameInterpolationModelLoader: ["model_name"],
  MinimaxH3LatentUpscaler3D: ["model_name"],
};

export type GraphModelFile = { node: string; input: string; file: string };

export function graphModelFiles(
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
): GraphModelFile[] {
  const seen = new Set<string>();
  const files: GraphModelFile[] = [];
  for (const { class_type: node, inputs } of Object.values(graph)) {
    for (const input of FILE_INPUTS[node] ?? []) {
      const file = inputs[input];
      const key = `${node}\u0000${input}\u0000${file}`;
      if (typeof file !== "string" || !file || seen.has(key)) continue;
      seen.add(key);
      files.push({ node, input, file });
    }
  }
  return files;
}
