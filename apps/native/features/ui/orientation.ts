import * as ScreenOrientation from "expo-screen-orientation";

/**
 * The app is portrait. Only a video in fullscreen rotates.
 *
 * `app.config.ts` declares landscape because iOS intersects a presented view
 * controller's supported orientations with the ones in Info.plist — without it
 * `AVPlayerViewController` could not rotate in fullscreen either. So the app
 * locks itself back to portrait here, and expo-video's own fullscreen controller
 * overrides that for as long as it is on screen.
 *
 * The viewer used to lift this lock. It should not have: a paging list cannot
 * keep its offset across a width change, so rotating jumped to a neighbouring
 * image and left the pager stranded between two pages — and the video went black
 * because the page it thought was active was no longer the one on screen.
 */
export function lockPortrait(): void {
  void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
}
