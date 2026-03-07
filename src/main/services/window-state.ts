import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow, Rectangle } from "electron";

export interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

const DEFAULT_WINDOW_STATE: PersistedWindowState = {
  width: 1440,
  height: 920,
  isMaximized: false,
};

export function loadWindowState(userDataPath: string): PersistedWindowState {
  const statePath = getWindowStatePath(userDataPath);

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedWindowState>;
    return {
      width:
        typeof parsed.width === "number" && parsed.width > 0
          ? parsed.width
          : DEFAULT_WINDOW_STATE.width,
      height:
        typeof parsed.height === "number" && parsed.height > 0
          ? parsed.height
          : DEFAULT_WINDOW_STATE.height,
      x: typeof parsed.x === "number" ? parsed.x : undefined,
      y: typeof parsed.y === "number" ? parsed.y : undefined,
      isMaximized: parsed.isMaximized === true,
    };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

export function persistWindowState(
  userDataPath: string,
  state: PersistedWindowState,
): void {
  const statePath = getWindowStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function captureWindowState(window: BrowserWindow): PersistedWindowState {
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  return {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: window.isMaximized(),
  };
}

export function toBrowserWindowOptions(state: PersistedWindowState): Pick<
  Electron.BrowserWindowConstructorOptions,
  "width" | "height" | "x" | "y"
> {
  return {
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
  };
}

function getWindowStatePath(userDataPath: string): string {
  return path.join(userDataPath, "window-state.json");
}
