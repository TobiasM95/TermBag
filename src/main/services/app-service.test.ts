import { describe, expect, it } from "vitest";
import type {
  HistoryEntry,
  PersistedTabLayout,
  Project,
  SavedTerminalSession,
  SavedWorkspaceTab,
  SessionRuntimeSummary,
  ShellProfile,
  ShellProfileAvailability,
} from "../../shared/types.js";
import { AppService } from "./app-service.js";

class FakeDatabaseService {
  private readonly projects = new Map<string, Project>();
  private readonly tabs = new Map<string, SavedWorkspaceTab>();
  private readonly sessions = new Map<string, SavedTerminalSession>();
  private readonly shellProfiles = new Map<string, ShellProfile>();

  upsertShellProfiles(profiles: ShellProfileAvailability[]): void {
    for (const profile of profiles) {
      this.shellProfiles.set(profile.id, profile);
    }
  }

  listShellProfiles(): ShellProfile[] {
    return [...this.shellProfiles.values()].sort((left, right) => left.sortOrder - right.sortOrder);
  }

  listProjects(): Project[] {
    return [...this.projects.values()];
  }

  getProject(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  createProject(params: {
    id: string;
    name: string;
    rootPath: string;
    defaultShellProfileId: string;
  }): Project {
    const timestamp = new Date().toISOString();
    const project: Project = {
      id: params.id,
      name: params.name,
      rootPath: params.rootPath,
      defaultShellProfileId: params.defaultShellProfileId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.set(project.id, project);
    return project;
  }

  updateProject(project: Project): Project {
    this.projects.set(project.id, project);
    return project;
  }

  deleteProject(projectId: string): void {
    this.projects.delete(projectId);
  }

  listTabsForProject(projectId: string): SavedWorkspaceTab[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.projectId === projectId)
      .sort((left, right) => left.restoreOrder - right.restoreOrder);
  }

  getTab(tabId: string): SavedWorkspaceTab | null {
    return this.tabs.get(tabId) ?? null;
  }

  listSessionsForTab(tabId: string): SavedTerminalSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.tabId === tabId)
      .sort((left, right) => left.sessionOrder - right.sessionOrder);
  }

  getSession(sessionId: string): SavedTerminalSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getTabCountForProject(projectId: string): number {
    return this.listTabsForProject(projectId).length;
  }

  getMaxRestoreOrder(projectId: string): number {
    const tabs = this.listTabsForProject(projectId);
    return tabs[tabs.length - 1]?.restoreOrder ?? 0;
  }

  createTabWithInitialSession(params: {
    tab: {
      id: string;
      projectId: string;
      title: string;
      customTitle: string | null;
      restoreOrder: number;
      layout: PersistedTabLayout;
      focusedSessionId: string;
    };
    session: {
      id: string;
      tabId: string;
      shellProfileId: string;
      lastKnownCwd: string | null;
      sessionOrder: number;
    };
  }) {
    const timestamp = new Date().toISOString();
    const tab: SavedWorkspaceTab = {
      ...params.tab,
      wasOpen: true,
      lastActivatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const session: SavedTerminalSession = {
      ...params.session,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tabs.set(tab.id, tab);
    this.sessions.set(session.id, session);
    return { tab, session };
  }

  updateTab(tab: SavedWorkspaceTab): SavedWorkspaceTab {
    this.tabs.set(tab.id, tab);
    return tab;
  }

  updateSession(session: SavedTerminalSession): SavedTerminalSession {
    this.sessions.set(session.id, session);
    return session;
  }

  markTabActivated(tabId: string): SavedWorkspaceTab {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    const updated = {
      ...tab,
      wasOpen: true,
      lastActivatedAt: new Date().toISOString(),
    };
    this.tabs.set(tabId, updated);
    return updated;
  }

  deleteTab(tabId: string): void {
    this.tabs.delete(tabId);
    for (const session of [...this.sessions.values()]) {
      if (session.tabId === tabId) {
        this.sessions.delete(session.id);
      }
    }
  }

  listHistoryForProject(_projectId: string, _limit = 100): HistoryEntry[] {
    return [];
  }

  touchProject(_projectId: string): void {}

  close(): void {}
}

class FakeShellCatalog {
  readonly profiles: ShellProfileAvailability[] = [
    {
      id: "pwsh",
      label: "PowerShell 7",
      executable: "pwsh.exe",
      argsJson: "[]",
      platform: "win32",
      supportsIntegration: true,
      sortOrder: 1,
      available: true,
    },
  ];

  refreshAvailability(): ShellProfileAvailability[] {
    return this.profiles;
  }

  isAvailable(shellProfileId: string): boolean {
    return this.profiles.some((profile) => profile.id === shellProfileId && profile.available);
  }

  resolveDefaultProfileId(): string {
    return "pwsh";
  }
}

class FakePtyManager {
  closedTabIds: string[] = [];

  getRuntimeSummary(_sessionId: string): SessionRuntimeSummary | null {
    return null;
  }

  closeTab(tabId: string): void {
    this.closedTabIds.push(tabId);
  }

  shutdown(): void {}

  async persistSnapshots(): Promise<void> {}
}

describe("AppService", () => {
  it("creates tabs with one focused session and a single-leaf layout", () => {
    const service = new AppService(
      new FakeDatabaseService() as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });

    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.tabs[0]!.sessions).toHaveLength(1);
    expect(workspace.tabs[0]!.focusedSessionId).toBe(workspace.tabs[0]!.sessions[0]!.id);
    expect(workspace.tabs[0]!.layout.root.kind).toBe("leaf");
    if (workspace.tabs[0]!.layout.root.kind === "leaf") {
      expect(workspace.tabs[0]!.layout.root.sessionId).toBe(
        workspace.tabs[0]!.sessions[0]!.id,
      );
    }
  });

  it("still enforces the minimum-one-tab rule and closes all sessions when a tab is removed", () => {
    const ptyManager = new FakePtyManager();
    const service = new AppService(
      new FakeDatabaseService() as never,
      new FakeShellCatalog() as never,
      ptyManager as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });
    const firstTabId = workspace.tabs[0]!.id;

    expect(() => service.closeTab(firstTabId)).toThrow(
      "A project must keep at least one terminal tab in Phase 1.",
    );

    const withSecondTab = service.createTab({ projectId: workspace.project.id });
    expect(withSecondTab.tabs).toHaveLength(2);

    const afterClose = service.closeTab(firstTabId);
    expect(afterClose.tabs).toHaveLength(1);
    expect(ptyManager.closedTabIds).toContain(firstTabId);
  });
});
