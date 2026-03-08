import { create } from "zustand";
import type {
  ApplyLayoutPresetInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  Project,
  ProjectWorkspace,
  RenameTabInput,
  SetFocusedSessionInput,
  SessionRuntimeSummary,
  ShellProfileAvailability,
  TerminalEvent,
  UpdateProjectInput,
} from "../../shared/types";

interface AppState {
  bootstrapped: boolean;
  loading: boolean;
  error: string | null;
  projects: Project[];
  shellProfiles: ShellProfileAvailability[];
  selectedProjectId: string | null;
  workspaces: Record<string, ProjectWorkspace>;
  historyEntries: HistoryEntry[];
  historyLoading: boolean;
  historyError: string | null;
  clearError(): void;
  bootstrap(): Promise<void>;
  loadProjectWorkspace(projectId: string): Promise<void>;
  selectProject(projectId: string): void;
  setSelectedTab(projectId: string, tabId: string): void;
  createProject(input: CreateProjectInput): Promise<void>;
  updateProject(input: UpdateProjectInput): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  createTab(input: CreateTabInput): Promise<void>;
  renameTab(input: RenameTabInput): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  applyLayoutPreset(input: ApplyLayoutPresetInput): Promise<void>;
  setFocusedSession(input: SetFocusedSessionInput): Promise<void>;
  loadHistory(projectId: string): Promise<void>;
  applyTerminalEvent(event: TerminalEvent): void;
  setTabRuntime(projectId: string, runtime: SessionRuntimeSummary): void;
}

const LAST_ACTIVE_TABS_STORAGE_KEY = "termbag-last-active-tabs";
const SELECTED_PROJECT_STORAGE_KEY = "termbag-selected-project-id";

function mergeWorkspace(
  workspaces: Record<string, ProjectWorkspace>,
  workspace: ProjectWorkspace,
): Record<string, ProjectWorkspace> {
  return {
    ...workspaces,
    [workspace.project.id]: workspace,
  };
}

function upsertProject(projects: Project[], project: Project): Project[] {
  const existingIndex = projects.findIndex((entry) => entry.id === project.id);
  if (existingIndex === -1) {
    return [...projects, project];
  }

  const nextProjects = [...projects];
  nextProjects[existingIndex] = project;
  return nextProjects;
}

function applyRuntimeToWorkspaces(
  workspaces: Record<string, ProjectWorkspace>,
  runtime: SessionRuntimeSummary,
): Record<string, ProjectWorkspace> {
  const workspace = workspaces[runtime.projectId];
  if (!workspace) {
    return workspaces;
  }

  return {
    ...workspaces,
    [runtime.projectId]: {
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (tab.id !== runtime.tabId) {
          return tab;
        }

        return {
          ...tab,
          sessions: tab.sessions.map((session) =>
            session.id === runtime.sessionId ? { ...session, runtime } : session,
          ),
        };
      }),
    },
  };
}

function getStoredLastActiveTabs(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LAST_ACTIVE_TABS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function persistLastActiveTabs(lastActiveTabs: Record<string, string>): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    LAST_ACTIVE_TABS_STORAGE_KEY,
    JSON.stringify(lastActiveTabs),
  );
}

function getStoredSelectedProjectId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const value = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
  return value && value.trim() ? value : null;
}

function persistSelectedProjectId(projectId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  if (projectId) {
    window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
    return;
  }

  window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
}

function applyPreferredSelectedTab(
  workspace: ProjectWorkspace,
  lastActiveTabs: Record<string, string>,
): ProjectWorkspace {
  const preferredTabId = lastActiveTabs[workspace.project.id];
  if (!preferredTabId) {
    return workspace;
  }

  const matchingTab = workspace.tabs.find((tab) => tab.id === preferredTabId);
  if (!matchingTab) {
    return workspace;
  }

  return {
    ...workspace,
    selectedTabId: preferredTabId,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  bootstrapped: false,
  loading: false,
  error: null,
  projects: [],
  shellProfiles: [],
  selectedProjectId: null,
  workspaces: {},
  historyEntries: [],
  historyLoading: false,
  historyError: null,

  clearError() {
    set({ error: null });
  },

  async bootstrap() {
    set({ loading: true, error: null });
    try {
      const data = (await window.termbag.bootstrap()) as BootstrapData;
      const storedSelectedProjectId = getStoredSelectedProjectId();
      const selectedProjectId = data.projects.some(
        (project) => project.id === storedSelectedProjectId,
      )
        ? storedSelectedProjectId
        : data.selectedProjectId;
      persistSelectedProjectId(selectedProjectId);
      set({
        bootstrapped: true,
        loading: false,
        projects: data.projects,
        shellProfiles: data.shellProfiles,
        selectedProjectId,
      });

      if (selectedProjectId) {
        await get().loadProjectWorkspace(selectedProjectId);
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to bootstrap the app.",
      });
    }
  },

  async loadProjectWorkspace(projectId: string) {
    try {
      const workspace = applyPreferredSelectedTab(
        await window.termbag.getProjectWorkspace(projectId),
        getStoredLastActiveTabs(),
      );
      set((state) => ({
        workspaces: mergeWorkspace(state.workspaces, workspace),
        projects: upsertProject(state.projects, workspace.project),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to load workspace.",
      });
    }
  },

  selectProject(projectId: string) {
    persistSelectedProjectId(projectId);
    set({ selectedProjectId: projectId, historyError: null });
    if (!get().workspaces[projectId]) {
      void get().loadProjectWorkspace(projectId);
    }
  },

  setSelectedTab(projectId: string, tabId: string) {
    const nextLastActiveTabs = {
      ...getStoredLastActiveTabs(),
      [projectId]: tabId,
    };
    persistLastActiveTabs(nextLastActiveTabs);

    set((state) => {
      const workspace = state.workspaces[projectId];
      if (!workspace) {
        return state;
      }

      return {
        workspaces: {
          ...state.workspaces,
          [projectId]: {
            ...workspace,
            selectedTabId: tabId,
          },
        },
      };
    });
  },

  async createProject(input: CreateProjectInput) {
    set({ loading: true, error: null });
    try {
      const workspace = await window.termbag.createProject(input);
      if (workspace.selectedTabId) {
        persistLastActiveTabs({
          ...getStoredLastActiveTabs(),
          [workspace.project.id]: workspace.selectedTabId,
        });
      }
      persistSelectedProjectId(workspace.project.id);
      set((state) => ({
        loading: false,
        selectedProjectId: workspace.project.id,
        projects: upsertProject(state.projects, workspace.project),
        workspaces: mergeWorkspace(state.workspaces, workspace),
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to create project.",
      });
    }
  },

  async updateProject(input: UpdateProjectInput) {
    set({ loading: true, error: null });
    try {
      const workspace = await window.termbag.updateProject(input);
      set((state) => ({
        loading: false,
        projects: upsertProject(state.projects, workspace.project),
        workspaces: mergeWorkspace(state.workspaces, workspace),
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to update project.",
      });
    }
  },

  async deleteProject(projectId: string) {
    set({ loading: true, error: null });
    try {
      const bootstrapData = await window.termbag.deleteProject(projectId);
      set((state) => {
        const nextWorkspaces = { ...state.workspaces };
        delete nextWorkspaces[projectId];
        const nextSelectedProjectId = bootstrapData.selectedProjectId;
        persistSelectedProjectId(nextSelectedProjectId);
        return {
          loading: false,
          projects: bootstrapData.projects,
          shellProfiles: bootstrapData.shellProfiles,
          selectedProjectId: nextSelectedProjectId,
          workspaces: nextWorkspaces,
        };
      });

      if (bootstrapData.selectedProjectId) {
        await get().loadProjectWorkspace(bootstrapData.selectedProjectId);
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to delete project.",
      });
    }
  },

  async createTab(input: CreateTabInput) {
    set({ loading: true, error: null });
    try {
      const workspace = applyPreferredSelectedTab(
        await window.termbag.createTab(input),
        getStoredLastActiveTabs(),
      );
      set((state) => ({
        loading: false,
        workspaces: mergeWorkspace(state.workspaces, workspace),
        projects: upsertProject(state.projects, workspace.project),
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to create tab.",
      });
    }
  },

  async renameTab(input: RenameTabInput) {
    set({ loading: true, error: null });
    try {
      const workspace = applyPreferredSelectedTab(
        await window.termbag.renameTab(input),
        getStoredLastActiveTabs(),
      );
      set((state) => ({
        loading: false,
        workspaces: mergeWorkspace(state.workspaces, workspace),
        projects: upsertProject(state.projects, workspace.project),
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to rename tab.",
      });
    }
  },

  async closeTab(tabId: string) {
    set({ loading: true, error: null });
    try {
      const workspace = applyPreferredSelectedTab(
        await window.termbag.closeTab(tabId),
        getStoredLastActiveTabs(),
      );
      set((state) => ({
        loading: false,
        workspaces: mergeWorkspace(state.workspaces, workspace),
        projects: upsertProject(state.projects, workspace.project),
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to close tab.",
      });
    }
  },

  async applyLayoutPreset(input: ApplyLayoutPresetInput) {
    set({ loading: true, error: null });
    try {
      const workspace = applyPreferredSelectedTab(
        await window.termbag.applyLayoutPreset(input),
        getStoredLastActiveTabs(),
      );
      set((state) => ({
        loading: false,
        workspaces: mergeWorkspace(state.workspaces, workspace),
        projects: upsertProject(state.projects, workspace.project),
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to apply layout.",
      });
    }
  },

  async setFocusedSession(input: SetFocusedSessionInput) {
    try {
      const workspace = applyPreferredSelectedTab(
        await window.termbag.setFocusedSession(input),
        getStoredLastActiveTabs(),
      );
      set((state) => ({
        workspaces: mergeWorkspace(state.workspaces, workspace),
        projects: upsertProject(state.projects, workspace.project),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to focus terminal pane.",
      });
    }
  },

  async loadHistory(projectId: string) {
    set({ historyLoading: true, historyError: null });
    try {
      const historyEntries = await window.termbag.listHistory({ projectId, limit: 150 });
      set({ historyEntries, historyLoading: false });
    } catch (error) {
      set({
        historyLoading: false,
        historyError:
          error instanceof Error ? error.message : "Failed to load command history.",
      });
    }
  },

  applyTerminalEvent(event: TerminalEvent) {
    if (event.type === "status") {
      set((state) => ({
        workspaces: applyRuntimeToWorkspaces(state.workspaces, event.runtime),
      }));
    }
  },

  setTabRuntime(projectId: string, runtime: SessionRuntimeSummary) {
    set((state) => ({
      workspaces: applyRuntimeToWorkspaces(state.workspaces, {
        ...runtime,
        projectId,
      }),
    }));
  },
}));
