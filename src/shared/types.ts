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

export interface SavedTerminalTab {
  id: string;
  projectId: string;
  shellProfileId: string;
  title: string;
  customTitle: string | null;
  restoreOrder: number;
  lastKnownCwd: string | null;
  wasOpen: boolean;
  lastActivatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalSnapshot {
  tabId: string;
  serializedBuffer: string;
  lineCount: number;
  byteCount: number;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  projectId: string;
  tabId: string | null;
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

export interface TabRuntimeSummary {
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

export interface WorkspaceTab extends SavedTerminalTab {
  snapshot: TerminalSnapshot | null;
  runtime: TabRuntimeSummary | null;
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

export interface ActivateTabInput {
  tabId: string;
  cols: number;
  rows: number;
}

export interface ResizeTabInput {
  tabId: string;
  cols: number;
  rows: number;
}

export interface HistoryQuery {
  projectId: string;
  limit?: number;
}

export interface RecallHistoryInput {
  tabId: string;
  commandText: string;
}

export interface HydratedTabSession {
  tabId: string;
  runtime: TabRuntimeSummary;
  liveOutput: string;
}

export type TerminalEvent =
  | {
      type: "output";
      tabId: string;
      data: string;
    }
  | {
      type: "status";
      tabId: string;
      runtime: TabRuntimeSummary;
    };

export interface BootstrapData {
  projects: Project[];
  shellProfiles: ShellProfileAvailability[];
  selectedProjectId: string | null;
}

export interface RecallHistoryResult {
  applied: boolean;
  reason: string | null;
}

export interface TermBagApi {
  bootstrap(): Promise<BootstrapData>;
  pickDirectory(initialPath?: string): Promise<string | null>;
  getProjectWorkspace(projectId: string): Promise<ProjectWorkspace>;
  createProject(input: CreateProjectInput): Promise<ProjectWorkspace>;
  updateProject(input: UpdateProjectInput): Promise<ProjectWorkspace>;
  deleteProject(projectId: string): Promise<BootstrapData>;
  createTab(input: CreateTabInput): Promise<ProjectWorkspace>;
  renameTab(input: RenameTabInput): Promise<ProjectWorkspace>;
  closeTab(tabId: string): Promise<ProjectWorkspace>;
  activateTab(input: ActivateTabInput): Promise<HydratedTabSession>;
  resizeTab(input: ResizeTabInput): Promise<void>;
  writeToTab(tabId: string, data: string): Promise<void>;
  restartTab(input: ActivateTabInput): Promise<HydratedTabSession>;
  listHistory(query: HistoryQuery): Promise<HistoryEntry[]>;
  recallHistory(input: RecallHistoryInput): Promise<RecallHistoryResult>;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
}
