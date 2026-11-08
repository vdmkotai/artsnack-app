import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";

import type { FavouritesFilter } from "@/features/feed/use-favourites-feed";

/**
 * The Favourites screen's scope — which folder, which media type, which
 * providers and checkpoints — on the stack rather than on a screen.
 *
 * The filter panel is its own route (a form sheet), and a value owned by the
 * grid screen would be invisible to the sheet that edits it. The web keeps this
 * state in the URL; there is no URL here, and nothing is persisted — a filter is
 * a way of looking, not a setting.
 */
type Favourites = {
  /** `undefined` = every folder, `"none"` = the unfiled pool, else a folder id. */
  folder: string | undefined;
  setFolder: (folder: string | undefined) => void;
  mediaType: "image" | "video" | undefined;
  setMediaType: (mediaType: "image" | "video" | undefined) => void;
  providers: string[];
  toggleProvider: (value: string) => void;
  checkpoints: string[];
  toggleCheckpoint: (value: string) => void;
  clearFilters: () => void;
  /** How many of the three filter dimensions are narrowing — the folder is scope, not a filter. */
  filterCount: number;
  /** The same state in the shape `useFavouritesFeed` passes to the server. */
  filter: FavouritesFilter;
};

const FavouritesContext = createContext<Favourites | null>(null);

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function FavouritesProvider({ children }: { children: ReactNode }) {
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [mediaType, setMediaType] = useState<"image" | "video" | undefined>(undefined);
  const [providers, setProviders] = useState<string[]>([]);
  const [checkpoints, setCheckpoints] = useState<string[]>([]);

  const toggleProvider = useCallback((value: string) => {
    setProviders((previous) => toggled(previous, value));
  }, []);
  const toggleCheckpoint = useCallback((value: string) => {
    setCheckpoints((previous) => toggled(previous, value));
  }, []);
  const clearFilters = useCallback(() => {
    setMediaType(undefined);
    setProviders([]);
    setCheckpoints([]);
  }, []);

  const filterCount =
    (mediaType ? 1 : 0) + (providers.length > 0 ? 1 : 0) + (checkpoints.length > 0 ? 1 : 0);

  const filter = useMemo<FavouritesFilter>(
    () => ({ folderId: folder, mediaType, providers, checkpoints }),
    [folder, mediaType, providers, checkpoints],
  );

  const value = useMemo(
    () => ({
      folder,
      setFolder,
      mediaType,
      setMediaType,
      providers,
      toggleProvider,
      checkpoints,
      toggleCheckpoint,
      clearFilters,
      filterCount,
      filter,
    }),
    [
      folder,
      mediaType,
      providers,
      toggleProvider,
      checkpoints,
      toggleCheckpoint,
      clearFilters,
      filterCount,
      filter,
    ],
  );

  return <FavouritesContext value={value}>{children}</FavouritesContext>;
}

export function useFavourites(): Favourites {
  const value = use(FavouritesContext);
  if (!value) throw new Error("useFavourites used outside FavouritesProvider");
  return value;
}
