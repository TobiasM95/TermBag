import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from "electron";
import { IPC_CHANNELS } from "../shared/ipc.js";
import type {
  ActivateSessionInput,
  ApplyLayoutPresetInput,
  CreateProjectInput,
  CreateTabInput,
  HistoryQuery,
  RenameTabInput,
  RecallHistoryInput,
  ResizeSessionInput,
  SetFocusedSessionInput,
  UpdateProjectInput,
} from "../shared/types.js";
import { describeStartupFailure } from "./startup-errors.js";
import {
  captureWindowState,
  loadWindowState,
  persistWindowState,
  toBrowserWindowOptions,
} from "./services/window-state.js";

interface AppServiceContract {
  bootstrap(): unknown;
  getProjectWorkspace(projectId: string): unknown;
  createProject(input: CreateProjectInput): unknown;
  updateProject(input: UpdateProjectInput): unknown;
  deleteProject(projectId: string): unknown;
  createTab(input: CreateTabInput): unknown;
  renameTab(input: RenameTabInput): unknown;
  closeTab(tabId: string): unknown;
  applyLayoutPreset(input: ApplyLayoutPresetInput): unknown;
  setFocusedSession(input: SetFocusedSessionInput): unknown;
  activateSession(input: ActivateSessionInput): unknown;
  resizeSession(sessionId: string, cols: number, rows: number): void;
  writeToSession(sessionId: string, data: string): void;
  restartSession(input: ActivateSessionInput): unknown;
  listHistory(projectId: string, limit?: number): unknown;
  recallHistory(sessionId: string, commandText: string): unknown;
  prepareForQuit(): Promise<void>;
  shutdown(): void;
}

let mainWindow: BrowserWindow | null = null;
let appService: AppServiceContract | null = null;
let startupComplete = false;
let fatalErrorShown = false;
let quitting = false;
const APP_ID = "com.tobiasm95.termbag";
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, "../..");
const TITLEBAR_HEIGHT = 32;
const APP_ICON_PATH = path.join(REPO_ROOT, "build", "icon.ico");

app.setAppUserModelId(APP_ID);

function getPreloadPath(): string {
  return path.resolve(CURRENT_DIR, "../preload/index.js");
}

function getTitleBarOverlayForTheme(theme: "dark" | "light") {
  return {
    color: theme === "dark" ? "#080808" : "#ffffff",
    symbolColor: theme === "dark" ? "#e08421" : "#111111",
    height: TITLEBAR_HEIGHT,
  };
}

async function createWindow(): Promise<void> {
  const windowState = loadWindowState(app.getPath("userData"));
  mainWindow = new BrowserWindow({
    ...toBrowserWindowOptions(windowState),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0e1318",
    icon: APP_ICON_PATH,
    titleBarStyle: "hidden",
    titleBarOverlay: getTitleBarOverlayForTheme("dark"),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(REPO_ROOT, "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const persistCurrentWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    persistWindowState(app.getPath("userData"), captureWindowState(mainWindow));
  };

  mainWindow.on("resize", persistCurrentWindowState);
  mainWindow.on("move", persistCurrentWindowState);
  mainWindow.on("maximize", persistCurrentWindowState);
  mainWindow.on("unmaximize", persistCurrentWindowState);
  mainWindow.on("close", persistCurrentWindowState);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.bootstrap, () => appService!.bootstrap());
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (_event, initialPath?: string) => {
    const dialogOptions: OpenDialogOptions = {
      properties: ["openDirectory"],
      defaultPath: initialPath && initialPath.trim() ? initialPath : undefined,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled) {
      return null;
    }

    return result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.readClipboardText, () => clipboard.readText());
  ipcMain.handle(IPC_CHANNELS.writeClipboardText, (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle(IPC_CHANNELS.setWindowTheme, (_event, theme: "dark" | "light") => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setTitleBarOverlay(getTitleBarOverlayForTheme(theme));
  });
  ipcMain.handle(IPC_CHANNELS.getProjectWorkspace, (_event, projectId: string) =>
    appService!.getProjectWorkspace(projectId),
  );
  ipcMain.handle(IPC_CHANNELS.createProject, (_event, input: CreateProjectInput) =>
    appService!.createProject(input),
  );
  ipcMain.handle(IPC_CHANNELS.updateProject, (_event, input: UpdateProjectInput) =>
    appService!.updateProject(input),
  );
  ipcMain.handle(IPC_CHANNELS.deleteProject, (_event, projectId: string) =>
    appService!.deleteProject(projectId),
  );
  ipcMain.handle(IPC_CHANNELS.createTab, (_event, input: CreateTabInput) =>
    appService!.createTab(input),
  );
  ipcMain.handle(IPC_CHANNELS.renameTab, (_event, input: RenameTabInput) =>
    appService!.renameTab(input),
  );
  ipcMain.handle(IPC_CHANNELS.closeTab, (_event, tabId: string) =>
    appService!.closeTab(tabId),
  );
  ipcMain.handle(IPC_CHANNELS.applyLayoutPreset, (_event, input: ApplyLayoutPresetInput) =>
    appService!.applyLayoutPreset(input),
  );
  ipcMain.handle(IPC_CHANNELS.setFocusedSession, (_event, input: SetFocusedSessionInput) =>
    appService!.setFocusedSession(input),
  );
  ipcMain.handle(IPC_CHANNELS.activateSession, (_event, input: ActivateSessionInput) =>
    appService!.activateSession(input),
  );
  ipcMain.handle(IPC_CHANNELS.resizeSession, (_event, input: ResizeSessionInput) => {
    appService!.resizeSession(input.sessionId, input.cols, input.rows);
  });
  ipcMain.handle(IPC_CHANNELS.writeToSession, (_event, sessionId: string, data: string) => {
    appService!.writeToSession(sessionId, data);
  });
  ipcMain.handle(IPC_CHANNELS.restartSession, (_event, input: ActivateSessionInput) =>
    appService!.restartSession(input),
  );
  ipcMain.handle(IPC_CHANNELS.listHistory, (_event, query: HistoryQuery) =>
    appService!.listHistory(query.projectId, query.limit),
  );
  ipcMain.handle(IPC_CHANNELS.recallHistory, (_event, input: RecallHistoryInput) =>
    appService!.recallHistory(input.sessionId, input.commandText),
  );
}

async function showFatalStartupError(error: unknown): Promise<void> {
  if (fatalErrorShown) {
    return;
  }
  fatalErrorShown = true;

  const failure = describeStartupFailure(error);
  try {
    await app.whenReady();
  } catch {
    // Best effort only.
  }
  dialog.showErrorBox(failure.title, failure.message);
  app.quit();
}

async function bootstrapApp(): Promise<void> {
  const [
    { AppService },
    { DatabaseService },
    { PtyManager },
    { ShellCatalog },
  ] = await Promise.all([
    import("./services/app-service.js"),
    import("./services/database.js"),
    import("./services/pty-manager.js"),
    import("./services/shell-catalog.js"),
  ]);

  const shellCatalog = new ShellCatalog();
  const database = new DatabaseService(path.join(app.getPath("userData"), "termbag.sqlite"));
  const ptyManager = new PtyManager(database, shellCatalog, (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IPC_CHANNELS.terminalEvent, event);
  });
  appService = new AppService(database, shellCatalog, ptyManager);
  registerIpcHandlers();
  await createWindow();
  startupComplete = true;

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}

process.on("uncaughtException", (error) => {
  if (!startupComplete) {
    void showFatalStartupError(error);
    return;
  }
  console.error(error);
});

process.on("unhandledRejection", (reason) => {
  if (!startupComplete) {
    void showFatalStartupError(reason);
    return;
  }
  console.error(reason);
});

app.whenReady().then(bootstrapApp).catch((error) => {
  void showFatalStartupError(error);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitting) {
    return;
  }

  event.preventDefault();
  quitting = true;
  const prepare = appService
    ? appService.prepareForQuit()
    : Promise.resolve();
  void prepare
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      app.exit(0);
    });
});
