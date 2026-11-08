import { getComfyuiUrl } from "@/lib/comfyui-url";
import { comfyAuthHeadersForUrl } from "@/lib/comfyui-auth";

/** This POSTs a full-resolution PNG, so it needs a far longer leash than the
 *  JSON calls — but still a finite one. */
const UPLOAD_TIMEOUT_MS = 120_000;

export async function uploadImageToBackend(
  imageArrayBuffer: ArrayBuffer,
  backendType: "comfyui" | "runpod",
): Promise<string> {
  const filename = `input_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.png`;

  const formData = new FormData();
  formData.append("image", new Blob([imageArrayBuffer], { type: "image/png" }), filename);
  formData.append("overwrite", "true");

  let uploadUrl: string;
  let headers: HeadersInit = {};

  if (backendType === "runpod") {
    // No public fallback hostname on purpose: the deployed config passes an
    // ephemeral *.proxy.runpod.net URL through RUNPOD_URL, so a missing value
    // means misconfiguration, not "use the stable public host".
    const baseUrl = (process.env.RUNPOD_URL || "").trim();
    if (!baseUrl) {
      throw new Error("RunPod URL is not configured");
    }
    uploadUrl = `${baseUrl}/upload/image`;
    if (process.env.COMFYUI_API_KEY) {
      headers["X-API-Key"] = process.env.COMFYUI_API_KEY;
    }
  } else {
    const baseUrl = await getComfyuiUrl();
    uploadUrl = `${baseUrl}/upload/image`;
    headers = comfyAuthHeadersForUrl(process.env, baseUrl);
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
    headers,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload image: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return result.name || filename;
}
