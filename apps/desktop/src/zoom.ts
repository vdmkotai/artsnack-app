/**
 * Chrome's zoom presets, so ⌘+ / ⌘− feel exactly like the browser the web app
 * was built in rather than stepping by an arbitrary constant.
 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], factor));
}

/** The next preset strictly above `current`, or the ceiling. */
export function zoomIn(current: number): number {
  const next = ZOOM_STEPS.find((step) => step > current + 1e-6);
  return next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

/** The next preset strictly below `current`, or the floor. */
export function zoomOut(current: number): number {
  const lower = ZOOM_STEPS.filter((step) => step < current - 1e-6);
  return lower.length ? lower[lower.length - 1] : ZOOM_STEPS[0];
}
