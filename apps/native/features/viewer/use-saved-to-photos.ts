import { File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import * as MediaLibrary from "expo-media-library";
import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import { createMMKV } from "react-native-mmkv";

const store = createMMKV({ id: "artsnack.saved-to-photos" });

/**
 * Whether a given output has already been put in Photos, and how to put it
 * there.
 *
 * The record is local. Saving needs only the narrow *Add to Photos* permission,
 * which grants no read access, so the library cannot be asked whether it already
 * holds something. That makes this per-device and able to go stale if a photo is
 * deleted by hand — accepted deliberately: the question the checkmark answers is
 * "have I already taken this?", and a local record answers exactly that. Reading
 * the truth would cost full library access for a tick.
 */
export function useSavedToPhotos() {
  const [version, setVersion] = useState(0);
  /**
   * Keys currently being fetched.
   *
   * The checkmark only appears once the download and the asset creation have both
   * finished, which on a 12 MB clip over cellular is several seconds of a button that
   * looks untouched — so it gets tapped again, and the second tap downloads the whole
   * file a second time and files a duplicate in Photos.
   */
  const inFlight = useRef(new Set<string>()).current;

  const saved = useCallback(
    (key: string) => {
      // `version` is read so this callback is recreated after a save and the
      // caller re-renders. The value itself carries no meaning.
      void version;
      return store.getBoolean(key) ?? false;
    },
    [version],
  );

  const save = useCallback(
    async (key: string, url: string, kind: "image" | "video") => {
      if (inFlight.has(key)) return;
      inFlight.add(key);
      let downloaded: File | undefined;
      try {
        const permission = await MediaLibrary.requestPermissionsAsync(true);
        if (!permission.granted) {
          Alert.alert(
            "Photos access needed",
            "ArtSnack only asks to add to your library, never to read it.",
          );
          return;
        }

        // Fetched to a temporary file first: Photos takes a local file, and
        // expo-image's cache is keyed by a transformed URL rather than holding the
        // original bytes.
        //
        // The destination is named rather than left to the URL, because the native
        // side derives the media type from the extension and refuses outright a
        // file that has none.
        downloaded = await File.downloadFileAsync(
          url,
          new File(Paths.cache, `artsnack-${Date.now()}.${extensionFor(key, kind)}`),
        );

        // `MediaLibrary.createAssetAsync` was deprecated in SDK 57 and now throws
        // instead of warning — which is what "Could not save" was reporting. This is
        // the class-based replacement.
        await MediaLibrary.Asset.create(downloaded.uri);

        store.set(key, true);
        setVersion((value) => value + 1);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        Alert.alert("Could not save", error instanceof Error ? error.message : "Unknown error");
      } finally {
        inFlight.delete(key);
        try {
          downloaded?.delete();
        } catch {
          // The system clears its own cache directory; a leftover is not worth
          // reporting over a save that otherwise succeeded.
        }
      }
    },
    [inFlight],
  );

  return { saved, save };
}

/** The B2 key's own extension where it has a usable one, else the media's default. */
function extensionFor(key: string, kind: "image" | "video"): string {
  const candidate = key.split("/").pop()?.split(".").pop()?.toLowerCase();
  if (candidate && /^[a-z0-9]{2,4}$/.test(candidate)) return candidate;
  return kind === "video" ? "mp4" : "png";
}
