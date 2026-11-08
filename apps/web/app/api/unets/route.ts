import { NextRequest, NextResponse } from "next/server";
import { noCacheFetch } from "@/lib/no-cdn-cache";
import { getComfyuiUrl } from "@/lib/comfyui-url";
import { catalogCacheHeaders } from "@/lib/catalog-cache";
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
 * UNET lists change only when a file lands on the pod volume. Memo per backend
 * for a short TTL, successes only — same shape as lib/comfyui-url.ts. The
 * upstream hop keeps noCacheFetch: RunPod's Cloudflare layer caches GETs for
 * minutes.
 */
const cache = new Map<BackendType, { unets: string[]; at: number }>();
const TTL_MS = 60_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const backend = (searchParams.get("backend") || "comfyui") as BackendType;

  if (backend !== "comfyui" && backend !== "runpod") {
    return NextResponse.json(
      {
        unets: [],
        error: `Invalid backend: ${backend}`,
      },
      { status: 400 },
    );
  }

  const cached = cache.get(backend);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ unets: cached.unets }, { headers: catalogCacheHeaders(true) });
  }

  const { baseUrl, headers } = await getBackendConfig(backend);

  if (!baseUrl) {
    console.error(`[UNETs API] ${backend} base URL is not configured`);
    return NextResponse.json(
      { unets: [], error: `${backend} URL is not configured` },
      { status: 502 },
    );
  }

  try {
    const response = await noCacheFetch(`${baseUrl}/object_info/UNETLoader`, {
      headers,
    });

    if (!response.ok) {
      console.error("[UNETs API] Failed to fetch:", response.status);
      return NextResponse.json(
        {
          unets: [],
          error: `Backend returned ${response.status}`,
        },
        { status: 502 },
      );
    }

    const data = await response.json();
    const unetNames: string[] = data?.UNETLoader?.input?.required?.unet_name?.[0] || [];

    // An empty list is not a success: a pod that is still booting can answer
    // /object_info without the node's choices filled in, and caching that would
    // pin an empty dropdown for the whole TTL after the pod is ready.
    if (unetNames.length > 0) {
      cache.set(backend, { unets: unetNames, at: Date.now() });
    }

    return NextResponse.json(
      { unets: unetNames },
      { headers: catalogCacheHeaders(unetNames.length > 0) },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[UNETs API] Error:", errorMessage);
    return NextResponse.json(
      {
        unets: [],
        error: `Connection failed: ${errorMessage}`,
      },
      { status: 502 },
    );
  }
}
