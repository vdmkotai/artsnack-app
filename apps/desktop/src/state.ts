import { app, screen, type Rectangle } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Everything the shell remembers between launches. One small JSON file in the
 * app's userData directory; a missing or corrupt file just means defaults.
 */
export interface PersistedState {
  bounds?: Rectangle;
  fullScreen?: boolean;
  zoomFactor?: number;
}

const FILE = () => join(app.getPath("userData"), "window-state.json");

export function loadState(): PersistedState {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as PersistedState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let pending: NodeJS.Timeout | null = null;
let current: PersistedState | null = null;

export function saveState(patch: PersistedState): void {
  current = { ...(current ?? loadState()), ...patch };
  if (pending) clearTimeout(pending);
  pending = setTimeout(flush, 250);
}

export function flush(): void {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  if (!current) return;
  try {
    mkdirSync(dirname(FILE()), { recursive: true });
    writeFileSync(FILE(), JSON.stringify(current, null, 2));
  } catch {
    // Losing window state is not worth a dialog.
  }
}

/**
 * Saved bounds are only useful if they still land on a connected display —
 * a window restored onto a monitor that was unplugged is a window nobody can
 * see. Otherwise pick a comfortable default centred on the primary display.
 */
export function initialBounds(saved?: Rectangle): Rectangle {
  if (saved) {
    const onSomeDisplay = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        saved.x >= a.x - 50 &&
        saved.y >= a.y - 50 &&
        saved.x < a.x + a.width - 100 &&
        saved.y < a.y + a.height - 100
      );
    });
    if (onSomeDisplay) return saved;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1480, Math.round(workArea.width * 0.9));
  const height = Math.min(940, Math.round(workArea.height * 0.92));
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  };
}
