export type ImageSize = { width: number; height: number };
export const IMAGE_SIZE_MIN = 512;
export const IMAGE_SIZE_MAX = 2048;
export const IMAGE_SIZE_STEP = 8;
export const IMAGE_SCALE_STEP = 0.05;
export const IMAGE_SIZE_PRESETS = [
  { id: "square", label: "Square", x: 1, y: 1, width: 1024, height: 1024 },
  { id: "photo", label: "Photo", x: 4, y: 3, width: 1024, height: 768 },
  { id: "classic", label: "Classic", x: 3, y: 2, width: 1152, height: 768 },
  { id: "wide", label: "Wide", x: 16, y: 9, width: 1280, height: 720 },
  { id: "panorama", label: "Panorama", x: 7, y: 3, width: 1344, height: 576 },
] as const;
export function snapDimension(value: number) {
  return Math.min(
    IMAGE_SIZE_MAX,
    Math.max(
      IMAGE_SIZE_MIN,
      Math.round((Number.isFinite(value) ? value : IMAGE_SIZE_MIN) / IMAGE_SIZE_STEP) *
        IMAGE_SIZE_STEP,
    ),
  );
}
export function matchingSizePreset({ width, height }: ImageSize) {
  return IMAGE_SIZE_PRESETS.find(
    (p) =>
      Math.max(width, height) * p.y === Math.min(width, height) * p.x ||
      presetSizes(p.x, p.y, height > width).some(
        (size) => size.width === width && size.height === height,
      ),
  );
}
/** Fine scale stops, rounded to the latent grid while retaining the selected preset. */
export function presetSizes(x: number, y: number, portrait: boolean): ImageSize[] {
  const preset = IMAGE_SIZE_PRESETS.find((p) => p.x === x && p.y === y);
  const baseWidth = preset?.width ?? 1024;
  const baseHeight = preset?.height ?? (baseWidth * y) / x;
  const min = Math.ceil(IMAGE_SIZE_MIN / (Math.min(baseWidth, baseHeight) * IMAGE_SCALE_STEP));
  const max = Math.floor(IMAGE_SIZE_MAX / (Math.max(baseWidth, baseHeight) * IMAGE_SCALE_STEP));
  return Array.from({ length: max - min + 1 }, (_, i) => {
    const scale = (min + i) * IMAGE_SCALE_STEP;
    const width = snapDimension(baseWidth * scale);
    const height = snapDimension(baseHeight * scale);
    return portrait ? { width: height, height: width } : { width, height };
  });
}
/** Fit both sides together before rounding; clamping them independently stretches images. */
export function resizeLocked(size: ImageSize, axis: keyof ImageSize, value: number): ImageSize {
  const ratio = size.width / size.height;
  const requestedWidth = axis === "width" ? value : value * ratio;
  const width = Math.min(
    Math.min(IMAGE_SIZE_MAX, IMAGE_SIZE_MAX * ratio),
    Math.max(Math.max(IMAGE_SIZE_MIN, IMAGE_SIZE_MIN * ratio), requestedWidth),
  );
  return { width: snapDimension(width), height: snapDimension(width / ratio) };
}
