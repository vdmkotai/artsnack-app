"use client";

import * as React from "react";

import { findScrollParent, splitLayoutQuery } from "@/hooks/use-scroll-root";

/**
 * Which grid clips may hold a source and which may play, decided for the whole
 * grid at once rather than by each tile for itself.
 *
 * Every tile used to run two IntersectionObservers of its own against the
 * viewport, which got three things wrong. Nothing capped playback, so a tall
 * window of clips decoded all of them at once. The viewport was the wrong root:
 * the results sit in an `overflow-y-auto` column, and an observer watching the
 * viewport only reports an element clipped by that column once it is really on
 * screen — the 600px "load ahead" and 100px "play ahead" margins never applied,
 * so tiles dropped their clip the moment they left the column and fetched it
 * again on the way back. And two observers per tile is a few hundred observers
 * on a long feed.
 *
 * Here one observer per scroll container finds the tiles near it, and on each
 * scroll frame the few visible tiles nearest the container's centre are the
 * ones allowed to play.
 */

/** How many clips of one grid may play at the same time. */
export const MAX_PLAYING_CLIPS = 4;
/** A tile this close to the scroll box keeps its source and frame. */
const NEAR_MARGIN = "100% 0px";
/** A playing tile keeps its slot unless a rival is clearly closer to the centre. */
const PLAYING_BIAS = 0.75;

export type VideoVisibility = {
  /** Within about a screen of the scroll box. */
  near: boolean;
  /** One of the clips allowed to play right now. */
  playing: boolean;
  /** Has played since it last came near; worth keeping its source until it goes far. */
  warm: boolean;
};

const IDLE: VideoVisibility = { near: false, playing: false, warm: false };

type Tile = {
  element: HTMLElement;
  eligible: boolean;
  near: boolean;
  state: VideoVisibility;
  notify: (state: VideoVisibility) => void;
  group: Group | null;
};

type Group = {
  root: HTMLElement | null;
  observer: IntersectionObserver;
  tiles: Set<Tile>;
  frame: number;
  dispose: () => void;
};

const groups = new Map<HTMLElement | null, Group>();
const tilesByElement = new Map<Element, Tile>();
let breakpointBound = false;

function setState(tile: Tile, next: VideoVisibility) {
  const current = tile.state;
  if (
    current.near === next.near &&
    current.playing === next.playing &&
    current.warm === next.warm
  ) {
    return;
  }
  tile.state = next;
  tile.notify(next);
}

function rank(group: Group) {
  const box = group.root
    ? group.root.getBoundingClientRect()
    : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  const centreX = (box.left + box.right) / 2;
  const centreY = (box.top + box.bottom) / 2;

  const candidates: { tile: Tile; distance: number }[] = [];
  for (const tile of group.tiles) {
    if (!tile.near || !tile.eligible) continue;
    const rect = tile.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const visible =
      rect.bottom > box.top &&
      rect.top < box.bottom &&
      rect.right > box.left &&
      rect.left < box.right;
    if (!visible) continue;
    // Vertical distance dominates: a feed is read top to bottom.
    const distance = Math.hypot(
      ((rect.left + rect.right) / 2 - centreX) * 0.5,
      (rect.top + rect.bottom) / 2 - centreY,
    );
    candidates.push({
      tile,
      distance: tile.state.playing ? distance * PLAYING_BIAS : distance,
    });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const playing = new Set(candidates.slice(0, MAX_PLAYING_CLIPS).map((entry) => entry.tile));

  for (const tile of group.tiles) {
    const isPlaying = playing.has(tile);
    setState(tile, {
      near: tile.near,
      playing: isPlaying,
      warm: tile.near && (isPlaying || tile.state.warm),
    });
  }
}

function schedule(group: Group) {
  if (group.frame) return;
  group.frame = requestAnimationFrame(() => {
    group.frame = 0;
    rank(group);
  });
}

function groupFor(root: HTMLElement | null): Group {
  const existing = groups.get(root);
  if (existing) return existing;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const tile = tilesByElement.get(entry.target);
        if (tile) tile.near = entry.isIntersecting;
      }
      schedule(group);
    },
    { root, rootMargin: NEAR_MARGIN, threshold: 0 },
  );
  const onMove = () => schedule(group);
  const scroller: HTMLElement | Window = root ?? window;
  scroller.addEventListener("scroll", onMove, { passive: true });
  window.addEventListener("resize", onMove, { passive: true });

  const group: Group = {
    root,
    observer,
    tiles: new Set(),
    frame: 0,
    dispose: () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
      if (group.frame) cancelAnimationFrame(group.frame);
      groups.delete(root);
    },
  };
  groups.set(root, group);
  return group;
}

function attach(tile: Tile) {
  const group = groupFor(findScrollParent(tile.element));
  tile.group = group;
  group.tiles.add(tile);
  tilesByElement.set(tile.element, tile);
  group.observer.observe(tile.element);
}

function detach(tile: Tile) {
  const group = tile.group;
  if (!group) return;
  group.observer.unobserve(tile.element);
  group.tiles.delete(tile);
  tilesByElement.delete(tile.element);
  tile.group = null;
  if (group.tiles.size === 0) group.dispose();
  else schedule(group);
}

/**
 * Crossing `lg` turns the results column's `overflow-y` between `auto` and
 * `visible`, so the scroll parent each tile was filed under is the wrong one
 * afterwards. Every tile is re-filed.
 */
function bindBreakpoint() {
  if (breakpointBound) return;
  breakpointBound = true;
  splitLayoutQuery().addEventListener("change", () => {
    for (const tile of [...tilesByElement.values()]) {
      detach(tile);
      tile.near = false;
      attach(tile);
    }
  });
}

/**
 * The grid's verdict for one clip tile.
 *
 * `eligible` false takes the tile out of the running entirely — a full-screen
 * view covering the grid, a clip that failed — so its slot goes to a neighbour.
 */
export function useVideoVisibility(
  ref: React.RefObject<HTMLElement | null>,
  eligible: boolean,
): VideoVisibility {
  const [state, setVisibility] = React.useState<VideoVisibility>(IDLE);
  const tileRef = React.useRef<Tile | null>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    bindBreakpoint();
    const tile: Tile = {
      element,
      eligible: true,
      near: false,
      state: IDLE,
      notify: setVisibility,
      group: null,
    };
    attach(tile);
    tileRef.current = tile;
    return () => {
      detach(tile);
      tileRef.current = null;
    };
  }, [ref]);

  React.useEffect(() => {
    const tile = tileRef.current;
    if (!tile || tile.eligible === eligible) return;
    tile.eligible = eligible;
    if (tile.group) schedule(tile.group);
  }, [eligible]);

  return state;
}

/**
 * Lets go of a clip's decoder and buffered media. Dropping the `src` attribute
 * alone does not: removing it does not run the load algorithm, so everything
 * stays resident until `load()` is called.
 */
export function releaseVideo(video: HTMLVideoElement) {
  if (!video.paused) video.pause();
  if (!video.hasAttribute("src") && video.currentSrc === "") return;
  video.removeAttribute("src");
  video.load();
}
