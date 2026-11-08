"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useDesktop, useTrafficLightInset } from "@/hooks/use-desktop";

/**
 * Everything the page does differently inside the macOS shell that is not a
 * layout decision of one component:
 *
 * - tags `<html data-desktop>` so globals.css can turn the header into the
 *   window's drag region and keep floating overlays out of it;
 * - on the pages that render no header (sign-in, no-access) supplies a bare
 *   drag strip, since a frameless window with no drag region cannot be moved;
 * - surfaces the shell's zoom level and finished downloads as toasts, the
 *   way a browser would show them in its own chrome.
 *
 * Renders nothing in a browser. Mounted once, in the root layout.
 */
export function DesktopChrome() {
  const desktop = useDesktop();
  const inset = useTrafficLightInset();
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;
    if (!desktop) {
      delete root.dataset.desktop;
      delete root.dataset.desktopInset;
      return;
    }
    root.dataset.desktop = desktop.platform;
    if (inset !== null) root.dataset.desktopInset = "";
    else delete root.dataset.desktopInset;
  }, [desktop, inset]);

  useEffect(() => {
    const bridge = window.artsnackDesktop;
    if (!bridge) return;
    return bridge.onEvent((event) => {
      if (event.type === "zoom") {
        toast(`Zoom ${Math.round(event.zoomFactor * 100)}%`, {
          id: "desktop-zoom",
          duration: 1200,
          position: "bottom-center",
        });
      } else if (event.type === "download") {
        if (event.state === "completed") {
          toast.success(`Saved ${event.filename} to Downloads`);
        } else if (event.state === "interrupted") {
          toast.error(`Download of ${event.filename} failed`);
        }
      }
    });
  }, [desktop]);

  if (!desktop) return null;

  // Same list as TabNav's chromeless routes: where there is no header there
  // is no drag region, so this strip stands in for it.
  const chromeless =
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/no-access");
  if (!chromeless) return null;

  return <div aria-hidden data-desktop-drag className="fixed inset-x-0 top-0 z-40 h-14" />;
}
