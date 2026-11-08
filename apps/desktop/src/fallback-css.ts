/**
 * Injected into every page the shell loads. The web app, when it is new enough
 * to know about the shell, tags `<html data-desktop>` and applies its own
 * layout (apps/web/components/desktop-chrome.tsx, globals.css). These rules
 * only bite when it has not — an older deploy, a Clerk-hosted page — so the
 * window is always draggable and never puts the traffic lights on top of the
 * first navigation tab.
 *
 * `-webkit-app-region` is computed as a set of rectangles in DOM order: drag
 * adds, no-drag subtracts. Fixed overlays and portal roots come after the
 * header in the DOM, so marking them no-drag keeps a lightbox's close button
 * clickable even where it overlaps the header band.
 */
export const FALLBACK_CSS = `
html:not([data-desktop]) body > header:first-of-type {
  -webkit-app-region: drag;
}
html:not([data-desktop]) body > header:first-of-type :is(a, button, input, textarea, select, [role="button"]) {
  -webkit-app-region: no-drag;
}
html:not([data-desktop]) :is(.fixed, [role="dialog"], [role="menu"], [role="listbox"]),
html:not([data-desktop]) body > :not(header):not(main) {
  -webkit-app-region: no-drag;
}
`;

/**
 * Added on top while the traffic lights are visible, removed in full screen,
 * and rebuilt on every zoom change: the buttons are native and do not zoom,
 * so the CSS-pixel padding has to grow as the page shrinks.
 */
export function fallbackInsetCss(zoomFactor: number): string {
  const px = Math.ceil(88 / (zoomFactor > 0 ? zoomFactor : 1));
  return `
html:not([data-desktop]) body > header:first-of-type > div:first-child {
  padding-left: ${px}px;
}
`;
}

/**
 * Pages the shell does not control at all — Clerk's hosted sign-in, an OAuth
 * consent screen — get a slim drag strip so the window is still movable.
 */
export const FOREIGN_PAGE_CSS = `
html::before {
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 28px;
  z-index: 2147483647;
  pointer-events: none;
  -webkit-app-region: drag;
}
`;
