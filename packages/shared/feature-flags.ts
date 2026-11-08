/**
 * Per-user switches for parts of the UI that are only sometimes wanted.
 *
 * They hide, they do not disable: a flag off takes a provider's tab out of the
 * API switcher, and nothing else. Its results stay in the grid, reproducing one
 * still restores its settings, and the server accepts its jobs as before — so
 * turning a flag off can never strand work already running.
 *
 * Every flag defaults to on. A stored row only ever records a departure from
 * that, which is why an absent row, an absent field and a flag added after the
 * row was written all read the same way.
 */

export const FEATURE_FLAGS = [
  {
    key: "higgsfield",
    label: "Higgsfield",
    description: "Show the Higgsfield tab in the API provider switcher.",
  },
  {
    key: "fal",
    label: "fal.ai",
    description: "Show the fal.ai tab (Seedream and Seedance) in the API provider switcher.",
  },
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = { higgsfield: true, fal: true };

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return FEATURE_FLAGS.some((flag) => flag.key === value);
}

/** Stored overrides over the defaults; anything that is not a boolean is ignored. */
export function resolveFeatureFlags(
  stored: Partial<Record<string, unknown>> | null | undefined,
): FeatureFlags {
  const flags = { ...DEFAULT_FEATURE_FLAGS };
  if (!stored) return flags;
  for (const { key } of FEATURE_FLAGS) {
    const value = stored[key];
    if (typeof value === "boolean") flags[key] = value;
  }
  return flags;
}
