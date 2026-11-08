/**
 * Bounds for the numeric parameters /api/generate and /api/enhance feed straight
 * into KSampler and EmptyLatentImage.
 *
 * There is no cancel path anywhere in the app — nothing calls ComfyUI's
 * /interrupt — so a single request carrying `width: 16384` occupies the
 * hourly-billed pod until someone restarts it by hand. The ranges are wider than
 * the form's own inputs (steps 1-100, cfg 1-20, 512-2048px, batch 1/2/4/8/12) on
 * purpose: this is a backstop against a malformed request, not a second copy of
 * the UI's ergonomics, and it must never reject something the app's own buttons
 * can produce.
 */
export const WORKFLOW_PARAM_LIMITS = {
  steps: { min: 1, max: 150 },
  // KSampler itself accepts a CFG of 0, but nothing in this app can ask for one:
  // the slider, the input's `min` and its on-blur clamp all floor at 1. So a 0
  // arriving here is a cleared field, not a choice — see readBoundedNumber.
  cfg: { min: 1, max: 30 },
  width: { min: 64, max: 2048 },
  height: { min: 64, max: 2048 },
  batchSize: { min: 1, max: 12 },
} as const;

export type WorkflowParamName = keyof typeof WORKFLOW_PARAM_LIMITS;

/** Thrown for a value the caller should answer with 400, mirroring how
 *  lib/video/intake.ts signals a bad payload to /api/generate-video. */
export class WorkflowParamError extends Error {}

/**
 * Coerce one request field and check it against its bounds.
 *
 * Absent means absent — `undefined`, `null` and `""` take the caller's default,
 * because every one of these fields is optional in both routes. So does 0 for
 * every field whose floor is above 0, which here is all of them: the generate
 * form yields 0 from `Number(e.target.value) || 0` the moment a numeric input is
 * cleared and persists that to localStorage, so a reload can post a 0 the user
 * never chose. Those keep taking the caller's default, exactly as the routes'
 * old `Number(x) || 20` did. Anything else that is present is either a usable
 * number in range or a rejection: silently substituting a default would turn a
 * mistyped 2000 into a quietly different image the user has to pay to redo.
 */
export function readBoundedNumber(name: WorkflowParamName, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new WorkflowParamError(`${name} must be a number`);
  }

  const { min, max } = WORKFLOW_PARAM_LIMITS[name];
  if (value === 0 && min > 0) {
    return fallback;
  }

  if (value < min || value > max) {
    throw new WorkflowParamError(`${name} must be between ${min} and ${max}`);
  }

  return value;
}
