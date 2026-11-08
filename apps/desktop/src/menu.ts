import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { APP_URL, PRODUCT_NAME } from "./config";

export interface MenuActions {
  newWindow(): void;
  zoomIn(win: BrowserWindow): void;
  zoomOut(win: BrowserWindow): void;
  zoomReset(win: BrowserWindow): void;
  goHome(win: BrowserWindow): void;
}

function focused(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}

/**
 * A native macOS menu. Zoom is implemented here rather than with Electron's
 * `zoomIn`/`zoomOut` roles so it walks Chrome's presets and reports the new
 * level to the page; the extra `⌘=` binding is what makes the unshifted key
 * work, which is what everyone actually presses.
 */
export function installMenu(actions: MenuActions): void {
  const withWindow =
    (fn: (win: BrowserWindow) => void): (() => void) =>
    () => {
      const win = focused();
      if (win) fn(win);
    };

  const template: MenuItemConstructorOptions[] = [
    {
      label: PRODUCT_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => actions.newWindow() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: withWindow(actions.zoomReset),
        },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: withWindow(actions.zoomIn) },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: withWindow(actions.zoomIn),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+numadd",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: withWindow(actions.zoomIn),
        },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: withWindow(actions.zoomOut) },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+numsub",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: withWindow(actions.zoomOut),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "History",
      submenu: [
        {
          label: "Back",
          accelerator: "CmdOrCtrl+[",
          click: withWindow((win) => {
            if (win.webContents.navigationHistory.canGoBack()) {
              win.webContents.navigationHistory.goBack();
            }
          }),
        },
        {
          label: "Forward",
          accelerator: "CmdOrCtrl+]",
          click: withWindow((win) => {
            if (win.webContents.navigationHistory.canGoForward()) {
              win.webContents.navigationHistory.goForward();
            }
          }),
        },
        { type: "separator" },
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: withWindow(actions.goHome) },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
        { type: "separator" },
        { role: "window" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: APP_URL ? `Open ${APP_URL.hostname} in Browser` : "Open in Browser",
          enabled: APP_URL !== null,
          click: () => {
            const win = focused();
            const url = win?.webContents.getURL();
            const target = url && url.startsWith("http") ? url : APP_URL?.toString();
            if (target) void shell.openExternal(target);
          },
        },
        {
          label: "Copy Current URL",
          accelerator: "CmdOrCtrl+Shift+C",
          click: withWindow((win) => {
            const url = win.webContents.getURL();
            if (url.startsWith("http")) clipboard.writeText(url);
          }),
        },
        { type: "separator" },
        {
          label: `${PRODUCT_NAME} ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
