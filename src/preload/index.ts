import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc.js";
import type {
  ActivateSessionInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  HistoryQuery,
  HydratedSession,
  ProjectWorkspace,
  RenameTabInput,
  RecallHistoryInput,
  RecallHistoryResult,
  ResizeSessionInput,
  TermBagApi,
  TerminalEvent,
  UpdateProjectInput,
} from "../shared/types.js";

const api: TermBagApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap) as Promise<BootstrapData>,
  pickDirectory: (initialPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, initialPath) as Promise<string | null>,
  readClipboardText: () =>
    ipcRenderer.invoke(IPC_CHANNELS.readClipboardText) as Promise<string>,
  writeClipboardText: (text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeClipboardText, text) as Promise<void>,
  setWindowTheme: (theme) =>
    ipcRenderer.invoke(IPC_CHANNELS.setWindowTheme, theme) as Promise<void>,
  getProjectWorkspace: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getProjectWorkspace, projectId) as Promise<ProjectWorkspace>,
  createProject: (input: CreateProjectInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createProject, input) as Promise<ProjectWorkspace>,
  updateProject: (input: UpdateProjectInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateProject, input) as Promise<ProjectWorkspace>,
  deleteProject: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProject, projectId) as Promise<BootstrapData>,
  createTab: (input: CreateTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createTab, input) as Promise<ProjectWorkspace>,
  renameTab: (input: RenameTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameTab, input) as Promise<ProjectWorkspace>,
  closeTab: (tabId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeTab, tabId) as Promise<ProjectWorkspace>,
  activateSession: (input: ActivateSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.activateSession, input) as Promise<HydratedSession>,
  resizeSession: (input: ResizeSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.resizeSession, input) as Promise<void>,
  writeToSession: (sessionId: string, data: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeToSession, sessionId, data) as Promise<void>,
  restartSession: (input: ActivateSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.restartSession, input) as Promise<HydratedSession>,
  listHistory: (query: HistoryQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.listHistory, query) as Promise<HistoryEntry[]>,
  recallHistory: (input: RecallHistoryInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.recallHistory, input) as Promise<RecallHistoryResult>,
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) =>
      listener(payload);
    ipcRenderer.on(IPC_CHANNELS.terminalEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.terminalEvent, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("termbag", api);
