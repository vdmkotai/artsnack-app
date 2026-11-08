/* The viewer is a root-level route, not a screen inside a tab stack: the tab bar
 * has to be absent from the hierarchy while a photograph is full-bleed, and the
 * only reliable way to get that is to not be under the tab navigator at all.
 *
 * Both the Library and Favourites reach it with `router.push("/viewer", …)`; the
 * `source` param tells it which feed to page through. */
export { default } from "@/features/viewer/viewer-screen";
