import { getComfyUIBackend } from "./comfyui";
import { getRunPodBackend } from "./runpod";
import type { GenerationBackend } from "./types";

export function getBackend(type: "comfyui" | "runpod"): GenerationBackend {
  if (type === "comfyui") {
    return getComfyUIBackend();
  }

  return getRunPodBackend();
}

export { BaseBackend } from "./base";
export { getComfyUIBackend } from "./comfyui";
export { getRunPodBackend } from "./runpod";
export type {
  GenerationBackend,
  GenerationImage,
  GenerationResult,
  GenerationStatus,
  GenerationWorkflow,
  HealthCheckResult,
} from "./types";
