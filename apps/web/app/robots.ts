import type { MetadataRoute } from "next";

/**
 * Keep the whole app out of search results.
 *
 * This is a private instance, not a product: there is nothing here that should
 * be discoverable, and the sign-in page is the only thing a crawler could even
 * reach. Paired with the `robots: { index: false }` metadata in the root layout
 * and the `X-Robots-Tag` header in next.config.ts, so a page is excluded
 * whether the crawler reads robots.txt, the meta tag, or only the headers.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
