import { ATLAS_RATIOS, parseDimensions } from "./atlas-dimensions";

export type SizeOption = { value: string; width: number; height: number };
export type SizeGroup = { ratio: string; aspect: number; options: SizeOption[] };
export type SizeOptions = { groups: SizeGroup[]; specials: string[] };

/**
 * Words a size enum may carry beside its pixel values. GPT Image 2.5 offers
 * `auto` in the same list as `1024x1024`; it is a real choice, shown as its own
 * shapeless option rather than making the whole list fall back to a select.
 */
const SIZE_WORDS = new Set(["auto"]);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Group only actual enum values; never synthesize a size the provider did not offer. */
export function dimensionOptionGroups(options: readonly (string | number)[]): SizeOptions | null {
  if (options.length === 0) return null;
  const groups = new Map<string, SizeGroup>();
  const specials: string[] = [];
  for (const value of options) {
    if (typeof value !== "string") return null;
    if (SIZE_WORDS.has(value)) {
      specials.push(value);
      continue;
    }
    const size = parseDimensions(value);
    if (!size || size.width <= 0 || size.height <= 0) return null;
    const aspect = size.width / size.height;
    const nearest = ATLAS_RATIOS.map((ratio) => {
      const [w, h] = ratio.split(":").map(Number);
      return { ratio, aspect: w / h, error: Math.abs(aspect / (w / h) - 1) };
    }).sort((a, b) => a.error - b.error)[0];
    const divisor = gcd(size.width, size.height);
    const ratio =
      nearest.error <= 0.025 ? nearest.ratio : `${size.width / divisor}:${size.height / divisor}`;
    const group = groups.get(ratio) ?? {
      ratio,
      aspect: nearest.error <= 0.025 ? nearest.aspect : aspect,
      options: [],
    };
    group.options.push({ value, ...size });
    groups.set(ratio, group);
  }
  if (groups.size === 0) return null;
  return {
    groups: [...groups.values()].map((group) => ({
      ...group,
      options: group.options.sort((a, b) => a.width * a.height - b.width * b.height),
    })),
    specials,
  };
}
