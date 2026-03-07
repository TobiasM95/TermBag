import { create } from "zustand";
import type {
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  Project,
  ProjectWorkspace,
  ShellProfileAvailability,
  TabRuntimeSummary,
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
  bootstrap(): Promise<void>;
  loadProjectWorkspace(projectId: string): Promise<void>;
  selectProject(projectId: string): void;
  setSelectedTab(projectId: string, tabId: string): void;
  createProject(input: CreateProjectInput): Promise<void>;
  updateProject(input: UpdateProjectInput): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  createTab(input: CreateTabInput): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  loadHistory(projectId: string): Promise<void>;
  applyTerminalEvent(event: TerminalEvent): void;
  setTabRuntime(projectId: string, runtime: TabRuntimeSummary): void;
}

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
  const filtered = projects.filter((entry) => entry.id !== project.id);
  return [project, ...filtered].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function applyRuntimeToWorkspaces(
  workspaces: Record<string, ProjectWorkspace>,
  runtime: TabRuntimeSummary,
): Record<string, ProjectWorkspace> {
  const workspace = workspaces[runtime.projectId];
  if (!workspace) {
    return workspaces;
  }

  return {
    ...workspaces,
    [runtime.projectId]: {
      ...workspace,
      tabs: workspace.tabs.map((tab) =>
        tab.id === runtime.tabId ? { ...tab, runtime } : tab,
      ),
    },
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

  async bootstrap() {
    set({ loading: true, error: null });
    try {
      const data = (await window.termbag.bootstrap()) as BootstrapData;
      set({
        bootstrapped: true,
        loading: false,
        projects: data.projects,
        shellProfiles: data.shellProfiles,
        selectedProjectId: data.selectedProjectId,
      });

      if (data.selectedProjectId) {
        await get().loadProjectWorkspace(data.selectedProjectId);
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
      const workspace = await window.termbag.getProjectWorkspace(projectId);
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
    set({ selectedProjectId: projectId, historyError: null });
    if (!get().workspaces[projectId]) {
      void get().loadProjectWorkspace(projectId);
    }
  },

  setSelectedTab(projectId: string, tabId: string) {
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
        return {
          loading: false,
          projects: bootstrapData.projects,
          shellProfiles: bootstrapData.shellProfiles,
          selectedProjectId: bootstrapData.selectedProjectId,
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
      const workspace = await window.termbag.createTab(input);
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

  async closeTab(tabId: string) {
    set({ loading: true, error: null });
    try {
      const workspace = await window.termbag.closeTab(tabId);
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

  setTabRuntime(projectId: string, runtime: TabRuntimeSummary) {
    set((state) => ({
      workspaces: applyRuntimeToWorkspaces(state.workspaces, {
        ...runtime,
        projectId,
      }),
    }));
  },
}));
