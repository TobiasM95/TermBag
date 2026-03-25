import type { SnapshotFormat } from "./snapshot.js";

export type HistorySource = "integration" | "input_capture" | "heuristic";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultShellProfileId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShellProfile {
  id: string;
  label: string;
  executable: string;
  argsJson: string;
  platform: "win32";
  supportsIntegration: boolean;
  sortOrder: number;
}

export interface ShellProfileAvailability extends ShellProfile {
  available: boolean;
}

export interface LayoutLeafNode {
  id: string;
  kind: "leaf";
  sessionId: string;
}

export interface LayoutSplitNode {
  id: string;
  kind: "split";
  direction: "row" | "column";
  sizes: number[];
  children: TabLayoutNode[];
}

export type TabLayoutNode = LayoutLeafNode | LayoutSplitNode;

export interface PersistedTabLayout {
  version: 1;
  root: TabLayoutNode;
}

export interface TemplatePathReference {
  kind: "relative" | "absolute";
  value: string;
}

export interface TemplateLayoutLeafNode {
  id: string;
  kind: "leaf";
  paneId: string;
}

export interface TemplateLayoutSplitNode {
  id: string;
  kind: "split";
  direction: "row" | "column";
  sizes: number[];
  children: TemplateLayoutNode[];
}

export type TemplateLayoutNode = TemplateLayoutLeafNode | TemplateLayoutSplitNode;

export interface TemplateTabLayout {
  version: 1;
  root: TemplateLayoutNode;
}

export interface TemplatePane {
  id: string;
  shellProfileId: string;
  cwd: TemplatePathReference | null;
  borderColor?: string | null;
}

export interface TemplateTab {
  title: string;
  layout: TemplateTabLayout;
  focusedPaneId: string;
  panes: TemplatePane[];
}

export interface TemplateDefinition {
  name: string;
  tabs: TemplateTab[];
}

export interface WorkspaceTemplate extends TemplateDefinition {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateExportFile {
  version: 1;
  kind: "template";
  template: TemplateDefinition;
}

export interface TemplateLibraryExportFile {
  version: 1;
  kind: "template-library";
  templates: TemplateDefinition[];
}

export type LayoutPresetId =
  | "single"
  | "split_horizontal"
  | "split_vertical"
  | "grid_2x2"
  | "main_left_stack_right"
  | "stack_left_main_right";

export interface SavedWorkspaceTab {
  id: string;
  projectId: string;
  title: string;
  customTitle: string | null;
  restoreOrder: number;
  layout: PersistedTabLayout;
  focusedSessionId: string;
  wasOpen: boolean;
  lastActivatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedTerminalSession {
  id: string;
  tabId: string;
  shellProfileId: string;
  lastKnownCwd: string | null;
  borderColor: string | null;
  sessionOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalSnapshot {
  sessionId: string;
  snapshotFormat: SnapshotFormat;
  transcriptText: string;
  serializedState: string;
  viewportOffsetFromBottom: number;
  byteCount: number;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  projectId: string;
  tabId: string | null;
  sessionId: string | null;
  shellProfileId: string;
  cwd: string | null;
  commandText: string;
  source: HistorySource;
  createdAt: string;
}

export type RuntimeStatus =
  | "not_started"
  | "running"
  | "exited"
  | "error";

export interface SessionRuntimeSummary {
  sessionId: string;
  tabId: string;
  projectId: string;
  started: boolean;
  status: RuntimeStatus;
  pid: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  promptTrackingValid: boolean;
  currentInputBuffer: string;
  alternateScreenActive: boolean;
  sessionOutputByteCount: number;
  currentCwd: string | null;
  shellProfileId: string;
}

export interface WorkspaceSession extends SavedTerminalSession {
  runtime: SessionRuntimeSummary | null;
}

export interface WorkspaceTab extends SavedWorkspaceTab {
  sessions: WorkspaceSession[];
  rootPathMissing: boolean;
}

export interface ProjectWorkspace {
  project: Project;
  tabs: WorkspaceTab[];
  selectedTabId: string | null;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  defaultShellProfileId?: string;
}

export interface UpdateProjectInput {
  id: string;
  name: string;
  rootPath: string;
  defaultShellProfileId: string;
}

export interface CreateTabInput {
  projectId: string;
  shellProfileId?: string;
}

export interface RenameTabInput {
  tabId: string;
  title: string;
}

export interface SaveProjectAsTemplateInput {
  projectId: string;
  name: string;
  includeWorkingDirectories: boolean;
}

export interface RenameTemplateInput {
  templateId: string;
  name: string;
}

export type ApplyTemplateMode = "replace" | "append";

export interface ApplyTemplateInput {
  projectId: string;
  templateId: string;
  mode: ApplyTemplateMode;
}

export interface ApplyLayoutPresetInput {
  tabId: string;
  presetId: LayoutPresetId;
}

export interface SetFocusedSessionInput {
  tabId: string;
  sessionId: string;
}

export interface SetSessionBorderColorInput {
  sessionId: string;
  borderColor: string | null;
}

export interface ActivateSessionInput {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface ResizeSessionInput {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface HistoryQuery {
  sessionId: string;
  limit?: number;
}

export interface RecallHistoryInput {
  sessionId: string;
  commandText: string;
}

export interface HydratedSession {
  sessionId: string;
  runtime: SessionRuntimeSummary;
  serializedState: string;
  viewportOffsetFromBottom: number;
  replayRevision: number;
}

export type TerminalEvent =
  | {
      type: "output";
      sessionId: string;
      tabId: string;
      data: string;
      sequence: number;
    }
  | {
      type: "status";
      sessionId: string;
      tabId: string;
      runtime: SessionRuntimeSummary;
    };

export interface BootstrapData {
  projects: Project[];
  shellProfiles: ShellProfileAvailability[];
  templates: WorkspaceTemplate[];
  selectedProjectId: string | null;
}

export interface RecallHistoryResult {
  applied: boolean;
  reason: string | null;
}

export interface TemplateImportResult {
  templates: WorkspaceTemplate[];
  importedCount: number;
  filePath: string | null;
}

export interface TemplateExportResult {
  filePath: string | null;
}

export interface TermBagApi {
  bootstrap(): Promise<BootstrapData>;
  pickDirectory(initialPath?: string): Promise<string | null>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  setWindowTheme(theme: "dark" | "light"): Promise<void>;
  getProjectWorkspace(projectId: string): Promise<ProjectWorkspace>;
  createProject(input: CreateProjectInput): Promise<ProjectWorkspace>;
  updateProject(input: UpdateProjectInput): Promise<ProjectWorkspace>;
  deleteProject(projectId: string): Promise<BootstrapData>;
  saveProjectAsTemplate(input: SaveProjectAsTemplateInput): Promise<WorkspaceTemplate[]>;
  renameTemplate(input: RenameTemplateInput): Promise<WorkspaceTemplate[]>;
  deleteTemplate(templateId: string): Promise<WorkspaceTemplate[]>;
  applyTemplate(input: ApplyTemplateInput): Promise<ProjectWorkspace>;
  importTemplates(): Promise<TemplateImportResult>;
  exportTemplate(templateId: string): Promise<TemplateExportResult>;
  exportAllTemplates(): Promise<TemplateExportResult>;
  createTab(input: CreateTabInput): Promise<ProjectWorkspace>;
  renameTab(input: RenameTabInput): Promise<ProjectWorkspace>;
  closeTab(tabId: string): Promise<ProjectWorkspace>;
  applyLayoutPreset(input: ApplyLayoutPresetInput): Promise<ProjectWorkspace>;
  setFocusedSession(input: SetFocusedSessionInput): Promise<ProjectWorkspace>;
  setSessionBorderColor(input: SetSessionBorderColorInput): Promise<ProjectWorkspace>;
  activateSession(input: ActivateSessionInput): Promise<HydratedSession>;
  resizeSession(input: ResizeSessionInput): void;
  writeToSession(sessionId: string, data: string): void;
  restartSession(input: ActivateSessionInput): Promise<HydratedSession>;
  listHistory(query: HistoryQuery): Promise<HistoryEntry[]>;
  recallHistory(input: RecallHistoryInput): Promise<RecallHistoryResult>;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
}
