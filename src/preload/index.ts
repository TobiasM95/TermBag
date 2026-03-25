import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc.js";
import type {
  ActivateSessionInput,
  ApplyTemplateInput,
  ApplyLayoutPresetInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  HistoryQuery,
  HydratedSession,
  ProjectWorkspace,
  SetSessionBorderColorInput,
  RenameTemplateInput,
  RenameTabInput,
  RecallHistoryInput,
  RecallHistoryResult,
  ResizeSessionInput,
  SaveProjectAsTemplateInput,
  SetFocusedSessionInput,
  TermBagApi,
  TemplateExportResult,
  TemplateImportResult,
  TerminalEvent,
  UpdateProjectInput,
  WorkspaceTemplate,
} from "../shared/types.js";

const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
let terminalEventBridgeRegistered = false;

function ensureTerminalEventBridge(): void {
  if (terminalEventBridgeRegistered) {
    return;
  }

  ipcRenderer.on(
    IPC_CHANNELS.terminalEvent,
    (_event: Electron.IpcRendererEvent, payload: TerminalEvent) => {
      for (const listener of terminalEventListeners) {
        listener(payload);
      }
    },
  );
  terminalEventBridgeRegistered = true;
}

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
  saveProjectAsTemplate: (input: SaveProjectAsTemplateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveProjectAsTemplate, input) as Promise<
      WorkspaceTemplate[]
    >,
  renameTemplate: (input: RenameTemplateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameTemplate, input) as Promise<WorkspaceTemplate[]>,
  deleteTemplate: (templateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteTemplate, templateId) as Promise<
      WorkspaceTemplate[]
    >,
  applyTemplate: (input: ApplyTemplateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.applyTemplate, input) as Promise<ProjectWorkspace>,
  importTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.importTemplates) as Promise<TemplateImportResult>,
  exportTemplate: (templateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportTemplate, templateId) as Promise<TemplateExportResult>,
  exportAllTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.exportAllTemplates) as Promise<TemplateExportResult>,
  createTab: (input: CreateTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createTab, input) as Promise<ProjectWorkspace>,
  renameTab: (input: RenameTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameTab, input) as Promise<ProjectWorkspace>,
  closeTab: (tabId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeTab, tabId) as Promise<ProjectWorkspace>,
  applyLayoutPreset: (input: ApplyLayoutPresetInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.applyLayoutPreset, input) as Promise<ProjectWorkspace>,
  setFocusedSession: (input: SetFocusedSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setFocusedSession, input) as Promise<ProjectWorkspace>,
  setSessionBorderColor: (input: SetSessionBorderColorInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSessionBorderColor, input) as Promise<ProjectWorkspace>,
  activateSession: (input: ActivateSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.activateSession, input) as Promise<HydratedSession>,
  resizeSession: (input: ResizeSessionInput) => {
    ipcRenderer.send(IPC_CHANNELS.resizeSession, input);
  },
  writeToSession: (sessionId: string, data: string) => {
    ipcRenderer.send(IPC_CHANNELS.writeToSession, sessionId, data);
  },
  restartSession: (input: ActivateSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.restartSession, input) as Promise<HydratedSession>,
  listHistory: (query: HistoryQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.listHistory, query) as Promise<HistoryEntry[]>,
  recallHistory: (input: RecallHistoryInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.recallHistory, input) as Promise<RecallHistoryResult>,
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => {
    ensureTerminalEventBridge();
    terminalEventListeners.add(listener);
    return () => {
      terminalEventListeners.delete(listener);
    };
  },
};

contextBridge.exposeInMainWorld("termbag", api);
