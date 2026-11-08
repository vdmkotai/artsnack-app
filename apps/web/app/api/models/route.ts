import { NextResponse } from "next/server";
import { noCacheFetch } from "@/lib/no-cdn-cache";
import { getComfyuiUrl } from "@/lib/comfyui-url";
import { catalogCacheHeaders, catalogVersion, memoIsFresh } from "@/lib/catalog-cache";
import { comfyAuthHeadersForUrl } from "@/lib/comfyui-auth";

const SAMPLERS = [
  "euler",
  "euler_ancestral",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ddim",
  "uni_pc",
  "uni_pc_bh2",
];

const SCHEDULERS = [
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta",
];

/**
 * Checkpoints change only when a .safetensors file lands on the pod volume, but
 * every /generate and /enhance mount re-asks. Memo the successful answer for a
 * short TTL — same shape as lib/comfyui-url.ts. The upstream hop keeps using
 * noCacheFetch: RunPod's Cloudflare layer caches GETs for minutes, so dropping
 * the cache-bust nonce would buy far worse staleness than this TTL. A `?v=`
 * the memo has not seen bypasses it: a download just landed (catalog-cache.ts).
 */
let cache: { checkpoints: string[]; at: number; version: string | null } | null = null;
const TTL_MS = 60_000;

export async function GET(request: Request) {
  const version = catalogVersion(request);
  if (cache && memoIsFresh(cache, version, TTL_MS)) {
    return NextResponse.json(
      { checkpoints: cache.checkpoints, samplers: SAMPLERS, schedulers: SCHEDULERS },
      { headers: catalogCacheHeaders(true) },
    );
  }

  const comfyuiUrl = await getComfyuiUrl();
  try {
    const headers = comfyAuthHeadersForUrl(process.env, comfyuiUrl);

    const response = await noCacheFetch(`${comfyuiUrl}/object_info/CheckpointLoaderSimple`, {
      headers,
    });

    if (!response.ok) {
      console.error("[Models API] Failed to fetch:", response.status);
      return NextResponse.json(
        {
          checkpoints: [],
          samplers: SAMPLERS,
          schedulers: SCHEDULERS,
          error: `Backend returned ${response.status}`,
        },
        { status: 502 },
      );
    }

    const data = await response.json();
    const checkpoints: string[] =
      data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];

    // An empty list is not a success: a pod that is still booting can answer
    // /object_info without the node's choices filled in, and caching that would
    // pin an empty dropdown for the whole TTL after the pod is ready.
    if (checkpoints.length > 0) {
      cache = { checkpoints, at: Date.now(), version };
    }

    return NextResponse.json(
      {
        checkpoints,
        samplers: SAMPLERS,
        schedulers: SCHEDULERS,
      },
      { headers: catalogCacheHeaders(checkpoints.length > 0) },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[Models API] Error:", errorMessage);
    return NextResponse.json(
      {
        checkpoints: [],
        samplers: SAMPLERS,
        schedulers: SCHEDULERS,
        error: `Connection failed: ${errorMessage}`,
      },
      { status: 502 },
    );
  }
}
