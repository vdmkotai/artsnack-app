/**
 * The S3 signing region for a Backblaze B2 endpoint.
 *
 * B2's S3 endpoints name their region (`s3.<region>.backblazeb2.com`), and a
 * request signed for any other region is refused, so the region is read off
 * `B2_ENDPOINT` rather than configured twice. `B2_REGION` overrides it for an
 * endpoint that does not follow that pattern (another S3-compatible store, or
 * a custom domain in front of B2); with neither, this throws rather than guess.
 */
export function b2Region(endpoint: string, explicit?: string | null): string {
  const override = explicit?.trim();
  if (override) return override;
  const match = endpoint.trim().match(/^(?:https?:\/\/)?s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/i);
  if (match) return match[1].toLowerCase();
  throw new Error(
    `Cannot tell the S3 region from B2_ENDPOINT "${endpoint}" — set B2_REGION to the bucket's region`,
  );
}
