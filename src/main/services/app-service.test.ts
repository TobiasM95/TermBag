import { describe, expect, it } from "vitest";
import { flattenLayoutLeafSessionIds } from "../../shared/layout.js";
import type {
  HistoryEntry,
  PersistedTabLayout,
  Project,
  SavedTerminalSession,
  SavedWorkspaceTab,
  SessionRuntimeSummary,
  ShellProfile,
  ShellProfileAvailability,
  TemplateTab,
  WorkspaceTemplate,
} from "../../shared/types.js";
import { AppService } from "./app-service.js";

class FakeDatabaseService {
  private readonly projects = new Map<string, Project>();
  private readonly tabs = new Map<string, SavedWorkspaceTab>();
  private readonly sessions = new Map<string, SavedTerminalSession>();
  private readonly shellProfiles = new Map<string, ShellProfile>();
  private readonly templates = new Map<string, WorkspaceTemplate>();

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

  listTemplates(): WorkspaceTemplate[] {
    return [...this.templates.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.name.localeCompare(right.name),
    );
  }

  getTemplate(templateId: string): WorkspaceTemplate | null {
    return this.templates.get(templateId) ?? null;
  }

  createTemplate(params: { id: string; name: string; tabs: TemplateTab[] }): WorkspaceTemplate {
    const timestamp = new Date().toISOString();
    const template: WorkspaceTemplate = {
      id: params.id,
      name: params.name,
      tabs: params.tabs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.templates.set(template.id, template);
    return template;
  }

  updateTemplate(template: WorkspaceTemplate): WorkspaceTemplate {
    this.templates.set(template.id, {
      ...template,
      updatedAt: new Date().toISOString(),
    });
    return this.templates.get(template.id)!;
  }

  deleteTemplate(templateId: string): void {
    this.templates.delete(templateId);
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

  createTabWithSessions(params: {
    tab: {
      id: string;
      projectId: string;
      title: string;
      customTitle: string | null;
      restoreOrder: number;
      layout: PersistedTabLayout;
      focusedSessionId: string;
    };
    sessions: Array<{
      id: string;
      tabId: string;
      shellProfileId: string;
      lastKnownCwd: string | null;
      sessionOrder: number;
      createdAt?: string;
      updatedAt?: string;
    }>;
  }): { tab: SavedWorkspaceTab; sessions: SavedTerminalSession[] } {
    const timestamp = new Date().toISOString();
    const tab: SavedWorkspaceTab = {
      ...params.tab,
      wasOpen: true,
      lastActivatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tabs.set(tab.id, tab);

    const sessions = params.sessions.map((paramsSession) => {
      const session: SavedTerminalSession = {
        ...paramsSession,
        createdAt: paramsSession.createdAt ?? timestamp,
        updatedAt: paramsSession.updatedAt ?? timestamp,
      };
      this.sessions.set(session.id, session);
      return session;
    });

    return { tab, sessions };
  }

  updateTab(tab: SavedWorkspaceTab): SavedWorkspaceTab {
    this.tabs.set(tab.id, tab);
    return tab;
  }

  updateSession(session: SavedTerminalSession): SavedTerminalSession {
    this.sessions.set(session.id, session);
    return session;
  }

  createSession(params: {
    id: string;
    tabId: string;
    shellProfileId: string;
    lastKnownCwd: string | null;
    sessionOrder: number;
    createdAt?: string;
    updatedAt?: string;
  }): SavedTerminalSession {
    const timestamp = new Date().toISOString();
    const session: SavedTerminalSession = {
      ...params,
      createdAt: params.createdAt ?? timestamp,
      updatedAt: params.updatedAt ?? timestamp,
    };
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

  async closeTab(tabId: string): Promise<void> {
    this.closedTabIds.push(tabId);
  }

  async shutdown(): Promise<void> {}

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

  it("still enforces the minimum-one-tab rule and closes all sessions when a tab is removed", async () => {
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

    await expect(service.closeTab(firstTabId)).rejects.toThrow(
      "A project must keep at least one terminal tab in Phase 1.",
    );

    const withSecondTab = service.createTab({ projectId: workspace.project.id });
    expect(withSecondTab.tabs).toHaveLength(2);

    const afterClose = await service.closeTab(firstTabId);
    expect(afterClose.tabs).toHaveLength(1);
    expect(ptyManager.closedTabIds).toContain(firstTabId);
  });

  it("applies layout presets by creating visible sessions and caching hidden ones", () => {
    const service = new AppService(
      new FakeDatabaseService() as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });
    const initialTab = workspace.tabs[0]!;
    const initialSession = initialTab.sessions[0]!;

    const expandedWorkspace = service.applyLayoutPreset({
      tabId: initialTab.id,
      presetId: "grid_2x2",
    });
    const expandedTab = expandedWorkspace.tabs[0]!;

    expect(expandedTab.sessions).toHaveLength(4);
    expect(flattenLayoutLeafSessionIds(expandedTab.layout)).toEqual(
      expandedTab.sessions.slice(0, 4).map((session) => session.id),
    );
    expect(
      expandedTab.sessions
        .slice(1)
        .every((session) => session.lastKnownCwd === initialSession.lastKnownCwd),
    ).toBe(true);
    expect(
      expandedTab.sessions
        .slice(1)
        .every((session) => session.shellProfileId === initialSession.shellProfileId),
    ).toBe(true);

    const hiddenFocusSessionId = expandedTab.sessions[3]!.id;
    service.setFocusedSession({
      tabId: expandedTab.id,
      sessionId: hiddenFocusSessionId,
    });

    const collapsedWorkspace = service.applyLayoutPreset({
      tabId: expandedTab.id,
      presetId: "single",
    });
    const collapsedTab = collapsedWorkspace.tabs[0]!;

    expect(collapsedTab.sessions).toHaveLength(4);
    expect(collapsedTab.focusedSessionId).toBe(initialSession.id);
    expect(flattenLayoutLeafSessionIds(collapsedTab.layout)).toEqual([initialSession.id]);
    expect(collapsedTab.sessions[3]!.id).toBe(hiddenFocusSessionId);
  });

  it("persists focused session changes for visible panes", () => {
    const service = new AppService(
      new FakeDatabaseService() as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });
    const tabId = workspace.tabs[0]!.id;

    const splitWorkspace = service.applyLayoutPreset({
      tabId,
      presetId: "split_vertical",
    });
    const splitTab = splitWorkspace.tabs[0]!;
    const secondSessionId = splitTab.sessions[1]!.id;

    const focusedWorkspace = service.setFocusedSession({
      tabId,
      sessionId: secondSessionId,
    });
    const focusedTab = focusedWorkspace.tabs[0]!;

    expect(focusedTab.focusedSessionId).toBe(secondSessionId);
    expect(flattenLayoutLeafSessionIds(focusedTab.layout)).toEqual(
      splitTab.sessions.slice(0, 2).map((session) => session.id),
    );
  });

  it("saves templates from visible panes only and encodes working directories optionally", () => {
    const database = new FakeDatabaseService();
    const service = new AppService(
      database as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });
    const tabId = workspace.tabs[0]!.id;
    service.applyLayoutPreset({ tabId, presetId: "grid_2x2" });
    service.applyLayoutPreset({ tabId, presetId: "split_vertical" });

    const visibleSessions = database.listSessionsForTab(tabId);
    database.updateSession({
      ...visibleSessions[0]!,
      lastKnownCwd: "C:\\Work\\Repo",
    });
    database.updateSession({
      ...visibleSessions[1]!,
      lastKnownCwd: "C:\\Work\\Repo\\src",
    });
    database.updateSession({
      ...visibleSessions[2]!,
      lastKnownCwd: "D:\\External",
    });

    service.saveProjectAsTemplate({
      projectId: workspace.project.id,
      name: "Visible only",
      includeWorkingDirectories: true,
    });

    const [template] = database.listTemplates();
    expect(template).toBeTruthy();
    expect(template!.tabs).toHaveLength(1);
    expect(template!.tabs[0]!.panes).toHaveLength(2);
    expect(template!.tabs[0]!.panes[0]!.cwd).toEqual({
      kind: "relative",
      value: ".",
    });
    expect(template!.tabs[0]!.panes[1]!.cwd).toEqual({
      kind: "relative",
      value: "src",
    });
  });

  it("applies templates in append and replace modes", async () => {
    const database = new FakeDatabaseService();
    const service = new AppService(
      database as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });
    const originalTabId = workspace.tabs[0]!.id;

    database.createTemplate({
      id: "template-1",
      name: "Two tabs",
      tabs: [
        {
          title: "API",
          focusedPaneId: "pane-1",
          layout: {
            version: 1,
            root: { id: "pane-1:root", kind: "leaf", paneId: "pane-1" },
          },
          panes: [{ id: "pane-1", shellProfileId: "pwsh", cwd: null }],
        },
        {
          title: "UI",
          focusedPaneId: "pane-2",
          layout: {
            version: 1,
            root: { id: "pane-2:root", kind: "leaf", paneId: "pane-2" },
          },
          panes: [{ id: "pane-2", shellProfileId: "pwsh", cwd: null }],
        },
      ],
    });

    const appended = await service.applyTemplate({
      projectId: workspace.project.id,
      templateId: "template-1",
      mode: "append",
    });
    expect(appended.tabs).toHaveLength(3);
    expect(appended.selectedTabId).toBe(appended.tabs[1]!.id);
    expect(appended.tabs[1]!.title).toBe("API");
    expect(appended.tabs[2]!.title).toBe("UI");
    expect(appended.tabs[0]!.id).toBe(originalTabId);

    const replaced = await service.applyTemplate({
      projectId: workspace.project.id,
      templateId: "template-1",
      mode: "replace",
    });
    expect(replaced.tabs).toHaveLength(2);
    expect(replaced.tabs.every((tab) => tab.title === "API" || tab.title === "UI")).toBe(true);
    expect(replaced.tabs.some((tab) => tab.id === originalTabId)).toBe(false);
    expect(replaced.selectedTabId).toBe(replaced.tabs[0]!.id);
  });

  it("falls back to the project default shell when a template shell is unavailable", async () => {
    const database = new FakeDatabaseService();
    const service = new AppService(
      database as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    const workspace = service.createProject({
      name: "Repo",
      rootPath: "C:\\Work\\Repo",
    });

    database.createTemplate({
      id: "template-shell-fallback",
      name: "Fallback",
      tabs: [
        {
          title: "Fallback",
          focusedPaneId: "pane-1",
          layout: {
            version: 1,
            root: { id: "pane-1:root", kind: "leaf", paneId: "pane-1" },
          },
          panes: [{ id: "pane-1", shellProfileId: "missing-shell", cwd: null }],
        },
      ],
    });

    const applied = await service.applyTemplate({
      projectId: workspace.project.id,
      templateId: "template-shell-fallback",
      mode: "append",
    });
    const appliedSession = applied.tabs[1]!.sessions[0]!;

    expect(appliedSession.shellProfileId).toBe("pwsh");
  });

  it("imports templates with deterministic suffixes on name conflicts", () => {
    const database = new FakeDatabaseService();
    const service = new AppService(
      database as never,
      new FakeShellCatalog() as never,
      new FakePtyManager() as never,
    );

    database.createTemplate({
      id: "existing-template",
      name: "Starter",
      tabs: [
        {
          title: "Tab",
          focusedPaneId: "pane-1",
          layout: {
            version: 1,
            root: { id: "pane-1:root", kind: "leaf", paneId: "pane-1" },
          },
          panes: [{ id: "pane-1", shellProfileId: "pwsh", cwd: null }],
        },
      ],
    });

    const result = service.importTemplates(
      JSON.stringify({
        version: 1,
        kind: "template-library",
        templates: [
          {
            name: "Starter",
            tabs: [
              {
                title: "Tab A",
                focusedPaneId: "pane-a",
                layout: {
                  version: 1,
                  root: { id: "pane-a:root", kind: "leaf", paneId: "pane-a" },
                },
                panes: [{ id: "pane-a", shellProfileId: "pwsh", cwd: null }],
              },
            ],
          },
          {
            name: "Starter",
            tabs: [
              {
                title: "Tab B",
                focusedPaneId: "pane-b",
                layout: {
                  version: 1,
                  root: { id: "pane-b:root", kind: "leaf", paneId: "pane-b" },
                },
                panes: [{ id: "pane-b", shellProfileId: "pwsh", cwd: null }],
              },
            ],
          },
        ],
      }),
    );

    expect(result.importedCount).toBe(2);
    expect(result.templates.map((template) => template.name)).toContain("Starter");
    expect(result.templates.map((template) => template.name)).toContain("Starter (Imported)");
    expect(result.templates.map((template) => template.name)).toContain("Starter (Imported 2)");
  });
});
