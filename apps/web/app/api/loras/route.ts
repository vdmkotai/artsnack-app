import { NextRequest, NextResponse } from "next/server";
import { noCacheFetch } from "@/lib/no-cdn-cache";
import { getComfyuiUrl } from "@/lib/comfyui-url";
import { catalogCacheHeaders, catalogVersion, memoIsFresh } from "@/lib/catalog-cache";
import { comfyAuthHeadersForUrl } from "@/lib/comfyui-auth";

type BackendType = "comfyui" | "runpod";

async function getBackendConfig(
  backend: BackendType,
): Promise<{ baseUrl: string; headers: HeadersInit }> {
  let headers: HeadersInit = {};

  if (backend === "runpod") {
    // No public fallback hostname: the deployed config passes an ephemeral
    // *.proxy.runpod.net URL through RUNPOD_URL, so an empty value is a
    // misconfiguration and must not silently resolve to a stable public host.
    const baseUrl = (process.env.RUNPOD_URL || "").trim();
    // Harmless if the pod ignores it; makes turning auth on pod-side an env change.
    if (process.env.COMFYUI_API_KEY) {
      headers["X-API-Key"] = process.env.COMFYUI_API_KEY;
    }
    return { baseUrl, headers };
  }

  const baseUrl = await getComfyuiUrl();
  headers = comfyAuthHeadersForUrl(process.env, baseUrl);

  return { baseUrl, headers };
}

/**
 * LoRA lists change only when a file lands on the pod volume, but /generate and
 * /enhance re-ask on every mount. Memo per backend for a short TTL, successes
 * only — same shape as lib/comfyui-url.ts. The upstream hop keeps noCacheFetch:
 * RunPod's Cloudflare layer caches GETs for minutes. A `?v=` the memo has not
 * seen bypasses it: a download just landed (catalog-cache.ts).
 */
const cache = new Map<BackendType, { loras: string[]; at: number; version: string | null }>();
const TTL_MS = 60_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const backend = (searchParams.get("backend") || "comfyui") as BackendType;

  if (backend !== "comfyui" && backend !== "runpod") {
    return NextResponse.json(
      {
        loras: [],
        error: `Invalid backend: ${backend}`,
      },
      { status: 400 },
    );
  }

  const version = catalogVersion(request);
  const cached = cache.get(backend);
  if (cached && memoIsFresh(cached, version, TTL_MS)) {
    return NextResponse.json({ loras: cached.loras }, { headers: catalogCacheHeaders(true) });
  }

  const { baseUrl, headers } = await getBackendConfig(backend);

  if (!baseUrl) {
    console.error(`[LoRAs API] ${backend} base URL is not configured`);
    return NextResponse.json(
      { loras: [], error: `${backend} URL is not configured` },
      { status: 502 },
    );
  }

  try {
    const response = await noCacheFetch(`${baseUrl}/object_info/LoraLoader`, {
      headers,
    });

    if (!response.ok) {
      console.error("[LoRAs API] Failed to fetch:", response.status);
      return NextResponse.json(
        {
          loras: [],
          error: `Backend returned ${response.status}`,
        },
        { status: 502 },
      );
    }

    const data = await response.json();
    const loraNames: string[] = data?.LoraLoader?.input?.required?.lora_name?.[0] || [];

    // An empty list is not a success: a pod that is still booting can answer
    // /object_info without the node's choices filled in, and caching that would
    // pin an empty dropdown for the whole TTL after the pod is ready.
    if (loraNames.length > 0) {
      cache.set(backend, { loras: loraNames, at: Date.now(), version });
    }

    return NextResponse.json(
      { loras: loraNames },
      { headers: catalogCacheHeaders(loraNames.length > 0) },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[LoRAs API] Error:", errorMessage);
    return NextResponse.json(
      {
        loras: [],
        error: `Connection failed: ${errorMessage}`,
      },
      { status: 502 },
    );
  }
}
