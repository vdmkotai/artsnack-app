import { Directory, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { clearVideoCacheAsync, getCurrentVideoCacheSize, setVideoCacheSizeAsync } from "expo-video";
import { createMMKV } from "react-native-mmkv";

const settings = createMMKV({ id: "artsnack.storage" });
const LIMIT_KEY = "cache-limit-bytes";

const GB = 1024 * 1024 * 1024;
/** Trailing 0 means no cap — see `applyCacheLimits` for what each library does with it. */
export const CACHE_LIMIT_CHOICES = [1 * GB, 2 * GB, 4 * GB, 8 * GB, 0] as const;
const DEFAULT_LIMIT = 4 * GB;

/**
 * What "no limit" has to become for video.
 *
 * The two libraries read zero in opposite ways. SDWebImage, behind expo-image, treats
 * `maxDiskSize = 0` as unlimited. expo-video's `VideoCacheManager.limitCacheSize`
 * deletes every file that is not currently open until the total is at or below the
 * number given — so zero is not "no cap", it is "keep nothing", and picking "No limit"
 * emptied the video cache on the spot and kept it empty. A number larger than any
 * phone's free space is the same thing as no cap, and is what the library can express.
 */
const NO_VIDEO_CAP = 64 * GB;

/**
 * Where SDWebImage puts its disk cache, which is where expo-image's images are.
 *
 * `Image.getCachePathAsync(key)` resolves to null unless that exact key is already on
 * disk — it checks `diskImageExists` first — so the empty string it used to be called
 * with could only ever answer null, and the Storage screen reported 0 MB however many
 * gigabytes were cached. There is no size getter, so the directory is measured, and
 * the name is SDWebImage's default because expo-image constructs `SDImageCache.shared`
 * without a namespace.
 */
const IMAGE_CACHE_DIRECTORY = "com.hackemist.SDImageCache";

export function cacheLimit(): number {
  return settings.getNumber(LIMIT_KEY) ?? DEFAULT_LIMIT;
}

export function setCacheLimit(bytes: number) {
  settings.set(LIMIT_KEY, bytes);
  // Fire and forget, but not silently: `setVideoCacheSizeAsync` rejects while a player
  // is registered, and a limit that did not take hold while the screen shows the new
  // number is the kind of thing that is only ever noticed as "it forgets my setting".
  void applyCacheLimits().catch((error: unknown) => {
    console.warn("Cache limit not applied:", error);
  });
}

/**
 * Both libraries cache to disk and survive a relaunch, but their defaults are
 * wrong here in opposite directions: expo-video caps at 1 GB, and expo-image has
 * no size cap at all yet expires entries after a week — SDWebImage's
 * `maxDiskAge`, which `configureCache` does not expose.
 *
 * Neither setting is a guarantee. Both caches live in `Caches`, which iOS may
 * purge when the device runs short of space, so the Storage screen reports sizes
 * and offers to clear them rather than promising anything.
 */
export async function applyCacheLimits() {
  const limit = cacheLimit();
  Image.configureCache({ maxDiskSize: limit });
  await setVideoCacheSizeAsync(limit === 0 ? NO_VIDEO_CAP : limit);
}

/** expo-image exposes no size getter, so the directory is measured instead. */
export async function imageCacheBytes(): Promise<number> {
  try {
    const directory = new Directory(Paths.cache, IMAGE_CACHE_DIRECTORY);
    if (!directory.exists) return 0;
    return directorySize(directory);
  } catch {
    return 0;
  }
}

/** expo-video reports its own. */
export function videoCacheBytes(): number {
  return getCurrentVideoCacheSize();
}

export async function clearImageCache() {
  await Image.clearDiskCache();
  await Image.clearMemoryCache();
}

export async function clearVideoCache() {
  await clearVideoCacheAsync();
}

function directorySize(directory: Directory): number {
  let total = 0;
  for (const entry of directory.list()) {
    if (entry instanceof Directory) total += directorySize(entry);
    else total += entry.size ?? 0;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  if (bytes < GB) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}
