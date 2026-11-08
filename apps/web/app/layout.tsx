import type { Metadata } from "next";
import { preconnect, prefetchDNS } from "react-dom";
import { Geist_Mono, Geist, Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ConvexClientProvider } from "@/components/convex-client-provider";
import { TabNav } from "@/components/tab-nav";
import { DesktopChrome } from "@/components/desktop-chrome";
import { MediaCacheRegistrar } from "@/components/media-cache";
import { ConvexWarmup } from "@/components/convex-warmup";
import { SearchProvider } from "@/components/search-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
import { cn } from "@/lib/utils";

// Inter is the UI face (--font-sans), Geist the heading face (--font-heading),
// and Geist Mono the numeric/code one (--font-mono, resolved in globals.css).
// The shadcn preset ships fonts with its palette; applying one without the
// other makes a generated theme look half-applied.
const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistHeading = Geist({ subsets: ["latin"], variable: "--font-heading" });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  // Numbers and code only — not worth a render-blocking preload on every page;
  // it arrives with the first text that uses it.
  preload: false,
});

/**
 * Origins every page talks to before it can show anything: Convex for data
 * (the WebSocket opens only once the JS has run) and the media CDN for the
 * first thumbnails. Warming DNS and TLS from the HTML head starts both while
 * the bundle is still downloading.
 */
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;
const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL;

export const metadata: Metadata = {
  title: "ArtSnack — AI Art Generator",
  description: "Generate stunning AI artwork with custom models and LoRAs",
  icons: {
    icon: "/favicon.svg",
  },
  // A private instance, not a product. Belt and braces with app/robots.ts and
  // the X-Robots-Tag header in next.config.ts, so a crawler is excluded whether
  // it reads robots.txt, the meta tag, or only the response headers.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (CONVEX_URL) {
    prefetchDNS(CONVEX_URL);
    preconnect(CONVEX_URL);
  }
  if (MEDIA_URL) preconnect(MEDIA_URL);
  return (
    <html lang="en" className={cn("dark", "font-sans", inter.variable, geistHeading.variable)}>
      <body
        className={`${geistMono.variable} antialiased min-h-screen bg-background font-sans text-foreground`}
      >
        <ClerkProvider>
          <ConvexClientProvider>
            <NuqsAdapter>
              <SearchProvider>
                <DesktopChrome />
                <MediaCacheRegistrar />
                <ConvexWarmup />
                <TabNav />
                <main>{children}</main>
              </SearchProvider>
            </NuqsAdapter>
            <Toaster position="top-center" richColors />
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
