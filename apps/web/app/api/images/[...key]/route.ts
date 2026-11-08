import { NextRequest, NextResponse } from "next/server";
import { getImage } from "@/lib/b2";
import { isAllowedImageKey, isMissingObjectError, safeMediaContentType } from "@/lib/image-key";

// Images are public (keys are random/unguessable) - no auth needed for caching
// This allows browser and CDN to cache images properly
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const imageKey = key.join("/");

  if (!imageKey) {
    return NextResponse.json({ error: "Key is required" }, { status: 400 });
  }

  if (!isAllowedImageKey(imageKey)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  // Generate ETag from key for cache validation
  const etag = `"${Buffer.from(imageKey).toString("base64")}"`;

  // Answered before touching B2: the ETag is a pure function of the key, so a
  // revalidation costs no GetObject and leaves no response body to abandon.
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: etag,
      },
    });
  }

  try {
    const { body, contentType } = await getImage(imageKey);

    return new NextResponse(body, {
      headers: {
        // The stored type is client-influenced (see lib/image-key.ts), so it is
        // clamped rather than echoed.
        "Content-Type": safeMediaContentType(contentType),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        // Browser cache: 1 year (immutable content)
        "Cache-Control": "public, max-age=31536000, immutable",
        // Vercel CDN cache: 1 year
        "CDN-Cache-Control": "public, max-age=31536000, immutable",
        // Vercel Edge cache
        "Vercel-CDN-Cache-Control": "public, max-age=31536000, immutable",
        // ETag for cache validation
        ETag: etag,
      },
    });
  } catch (error) {
    console.error("[Images API] Error fetching from B2:", error);
    // The route is public, so a miss is a free invocation for anyone looping
    // random keys: let the edge absorb repeats of a key that really is absent.
    // Everything else here — missing env vars, connection resets, B2 5xx — is
    // transient and must stay uncached, or one blip hides a live image for five
    // minutes in every browser and shared cache that saw it.
    const cacheControl = isMissingObjectError(error) ? "public, max-age=300" : "no-store";
    return NextResponse.json(
      { error: "Image not found" },
      { status: 404, headers: { "Cache-Control": cacheControl } },
    );
  }
}
