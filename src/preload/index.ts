import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc.js";
import type {
  ActivateTabInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  HistoryQuery,
  HydratedTabSession,
  ProjectWorkspace,
  RecallHistoryInput,
  RecallHistoryResult,
  ResizeTabInput,
  TermBagApi,
  TerminalEvent,
  UpdateProjectInput,
} from "../shared/types.js";

const api: TermBagApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap) as Promise<BootstrapData>,
  pickDirectory: (initialPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, initialPath) as Promise<string | null>,
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
  closeTab: (tabId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeTab, tabId) as Promise<ProjectWorkspace>,
  activateTab: (input: ActivateTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.activateTab, input) as Promise<HydratedTabSession>,
  resizeTab: (input: ResizeTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.resizeTab, input) as Promise<void>,
  writeToTab: (tabId: string, data: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeToTab, tabId, data) as Promise<void>,
  restartTab: (input: ActivateTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.restartTab, input) as Promise<HydratedTabSession>,
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
