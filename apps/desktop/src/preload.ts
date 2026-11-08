import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBridge,
  DesktopEvent,
  DesktopState,
} from "../../../packages/shared/desktop-bridge";

/**
 * The renderer's only window into the shell. Sandboxed and context-isolated:
 * the page sees a plain object with data and subscriptions, nothing it could
 * use to reach Node or the main process beyond the two named channels.
 *
 * The one synchronous call fetches the initial state so the very first render
 * of the web app already knows the platform and full-screen status — waiting
 * for an async reply would paint the header once without the traffic-light
 * inset and once with it.
 */
let state = ipcRenderer.sendSync("desktop:state") as DesktopState;

const stateListeners = new Set<(state: DesktopState) => void>();
const eventListeners = new Set<(event: DesktopEvent) => void>();

ipcRenderer.on("desktop:state", (_event, next: DesktopState) => {
  state = next;
  for (const listener of stateListeners) listener(state);
});

ipcRenderer.on("desktop:event", (_event, payload: DesktopEvent) => {
  for (const listener of eventListeners) listener(payload);
});

const bridge: DesktopBridge = {
  getState: () => state,
  subscribe(listener) {
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  },
  onEvent(listener) {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  },
  openApp() {
    ipcRenderer.send("desktop:open-app");
  },
  signInWithBrowser() {
    ipcRenderer.send("desktop:sign-in-with-browser");
  },
};

contextBridge.exposeInMainWorld("artsnackDesktop", bridge);
