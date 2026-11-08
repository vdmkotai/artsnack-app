import { NextRequest, NextResponse } from "next/server";
import { getBackend } from "@/lib/backends";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const backendType = searchParams.get("backend") as "comfyui" | "runpod" | null;

  if (!backendType || !["comfyui", "runpod"].includes(backendType)) {
    return NextResponse.json(
      { error: "Invalid backend. Use ?backend=comfyui or ?backend=runpod" },
      { status: 400 },
    );
  }

  try {
    const backend = getBackend(backendType);
    const result = await backend.healthCheck();

    return NextResponse.json({
      online: result.online,
      latency: result.latency ?? 0,
      backend: backendType,
      error: result.error,
    });
  } catch (error) {
    console.error(`[BackendHealth API] ${backendType} check threw:`, error);
    return NextResponse.json({
      online: false,
      latency: 0,
      backend: backendType,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
