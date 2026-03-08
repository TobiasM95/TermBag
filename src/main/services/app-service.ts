import crypto from "node:crypto";
import fs from "node:fs";
import { collectLayoutSessionIds, createSingleLeafLayout, findFirstLayoutSessionId } from "../../shared/layout.js";
import { deriveTabTitle, normalizeWindowsPath } from "../../shared/paths.js";
import type {
  ActivateSessionInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  HydratedSession,
  Project,
  ProjectWorkspace,
  RenameTabInput,
  RecallHistoryResult,
  SavedTerminalSession,
  SavedWorkspaceTab,
  SessionRuntimeSummary,
  ShellProfile,
  ShellProfileAvailability,
  UpdateProjectInput,
  WorkspaceSession,
  WorkspaceTab,
} from "../../shared/types.js";
import { DatabaseService } from "./database.js";
import { PtyManager } from "./pty-manager.js";
import { ShellCatalog } from "./shell-catalog.js";

export class AppService {
  private readonly shellProfiles: ShellProfileAvailability[];

  constructor(
    private readonly database: DatabaseService,
    private readonly shellCatalog: ShellCatalog,
    private readonly ptyManager: PtyManager,
  ) {
    this.shellProfiles = shellCatalog.refreshAvailability();
    this.database.upsertShellProfiles(this.shellProfiles);
  }

  bootstrap(): BootstrapData {
    const projects = this.database.listProjects();
    return {
      projects,
      shellProfiles: this.shellProfiles,
      selectedProjectId: projects[0]?.id ?? null,
    };
  }

  getProjectWorkspace(projectId: string): ProjectWorkspace {
    const project = this.requireProject(projectId);
    const rootPathMissing = this.isConfiguredProjectRootMissing(project);
    const tabs = this.database.listTabsForProject(projectId).map((tab) =>
      this.normalizeTabState(tab),
    );
    const workspaceTabs: WorkspaceTab[] = tabs.map((tab) => ({
      ...tab,
      sessions: this.database.listSessionsForTab(tab.id).map((session) => ({
        ...session,
        runtime: this.ptyManager.getRuntimeSummary(session.id),
      })),
      rootPathMissing,
    }));

    return {
      project,
      tabs: workspaceTabs,
      selectedTabId: this.selectWorkspaceTabId(workspaceTabs),
    };
  }

  createProject(input: CreateProjectInput): ProjectWorkspace {
    const defaultProfileId =
      input.defaultShellProfileId &&
      this.shellCatalog.isAvailable(input.defaultShellProfileId)
        ? input.defaultShellProfileId
        : this.shellCatalog.resolveDefaultProfileId();

    const project = this.database.createProject({
      id: crypto.randomUUID(),
      name: input.name.trim(),
      rootPath: normalizeWindowsPath(input.rootPath),
      defaultShellProfileId: defaultProfileId,
    });

    this.createInitialTab(project, defaultProfileId);
    return this.getProjectWorkspace(project.id);
  }

  updateProject(input: UpdateProjectInput): ProjectWorkspace {
    const existing = this.requireProject(input.id);
    this.database.updateProject({
      ...existing,
      name: input.name.trim(),
      rootPath: normalizeWindowsPath(input.rootPath),
      defaultShellProfileId: input.defaultShellProfileId,
    });
    return this.getProjectWorkspace(input.id);
  }

  deleteProject(projectId: string): BootstrapData {
    const tabs = this.database.listTabsForProject(projectId);
    for (const tab of tabs) {
      this.ptyManager.closeTab(tab.id);
    }
    this.database.deleteProject(projectId);
    return this.bootstrap();
  }

  createTab(input: CreateTabInput): ProjectWorkspace {
    const project = this.requireProject(input.projectId);
    const shellProfileId = input.shellProfileId ?? project.defaultShellProfileId;
    const shellProfile = this.requireShellProfile(shellProfileId);
    const cwd = this.resolveProjectDefaultCwd(project);
    const tabId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    this.database.createTabWithInitialSession({
      tab: {
        id: tabId,
        projectId: project.id,
        title: deriveTabTitle(cwd, shellProfile.label),
        customTitle: null,
        restoreOrder: this.database.getMaxRestoreOrder(project.id) + 1,
        layout: createSingleLeafLayout(sessionId, `${sessionId}:root`),
        focusedSessionId: sessionId,
      },
      session: {
        id: sessionId,
        tabId,
        shellProfileId,
        lastKnownCwd: cwd,
        sessionOrder: 1,
      },
    });
    return this.getProjectWorkspace(project.id);
  }

  renameTab(input: RenameTabInput): ProjectWorkspace {
    const tab = this.normalizeTabState(this.requireTab(input.tabId));
    const nextCustomTitle = input.title.trim();
    const sessions = this.requireSessionsForTab(tab.id);

    this.database.updateTab({
      ...tab,
      title: nextCustomTitle || this.deriveAutomaticTabTitle(tab, sessions),
      customTitle: nextCustomTitle || null,
    });

    return this.getProjectWorkspace(tab.projectId);
  }

  closeTab(tabId: string): ProjectWorkspace {
    const tab = this.requireTab(tabId);
    if (this.database.getTabCountForProject(tab.projectId) <= 1) {
      throw new Error("A project must keep at least one terminal tab in Phase 1.");
    }

    this.ptyManager.closeTab(tabId);
    this.database.deleteTab(tabId);
    return this.getProjectWorkspace(tab.projectId);
  }

  async activateSession(input: ActivateSessionInput): Promise<HydratedSession> {
    const session = this.requireSession(input.sessionId);
    const tab = this.normalizeTabState(this.requireTab(session.tabId));
    const project = this.requireProject(tab.projectId);
    const shellProfile = this.requireShellProfile(session.shellProfileId);
    this.database.markTabActivated(tab.id);

    const activated = await this.ptyManager.activateSession(
      input,
      project,
      this.requireTab(tab.id),
      this.requireSession(session.id),
      shellProfile,
    );

    return {
      sessionId: input.sessionId,
      runtime: activated.runtime,
      serializedState: activated.serializedState,
      replayRevision: activated.replayRevision,
    };
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    this.ptyManager.resizeSession(sessionId, cols, rows);
  }

  writeToSession(sessionId: string, data: string): void {
    this.ptyManager.writeToSession(sessionId, data);
  }

  async restartSession(input: ActivateSessionInput): Promise<HydratedSession> {
    const session = this.requireSession(input.sessionId);
    const tab = this.normalizeTabState(this.requireTab(session.tabId));
    const project = this.requireProject(tab.projectId);
    const shellProfile = this.requireShellProfile(session.shellProfileId);
    const restarted = await this.ptyManager.restartSession(
      input,
      project,
      tab,
      session,
      shellProfile,
    );

    return {
      sessionId: session.id,
      runtime: restarted.runtime,
      serializedState: restarted.serializedState,
      replayRevision: restarted.replayRevision,
    };
  }

  listHistory(projectId: string, limit = 100): HistoryEntry[] {
    this.requireProject(projectId);
    return this.database.listHistoryForProject(projectId, limit);
  }

  recallHistory(sessionId: string, commandText: string): RecallHistoryResult {
    return this.ptyManager.recallHistory(sessionId, commandText);
  }

  shutdown(): void {
    this.ptyManager.shutdown();
    this.database.close();
  }

  async prepareForQuit(): Promise<void> {
    await this.ptyManager.persistSnapshots();
    this.database.close();
  }

  private createInitialTab(project: Project, shellProfileId: string): void {
    const shellProfile = this.requireShellProfile(shellProfileId);
    const cwd = this.resolveProjectDefaultCwd(project);
    const tabId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    this.database.createTabWithInitialSession({
      tab: {
        id: tabId,
        projectId: project.id,
        title: deriveTabTitle(cwd, shellProfile.label),
        customTitle: null,
        restoreOrder: 1,
        layout: createSingleLeafLayout(sessionId, `${sessionId}:root`),
        focusedSessionId: sessionId,
      },
      session: {
        id: sessionId,
        tabId,
        shellProfileId,
        lastKnownCwd: cwd,
        sessionOrder: 1,
      },
    });
  }

  private normalizeTabState(tab: SavedWorkspaceTab): SavedWorkspaceTab {
    const sessions = this.requireSessionsForTab(tab.id);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const hasValidFocusedSession = sessionIds.has(tab.focusedSessionId);
    const layoutSessionIds = collectLayoutSessionIds(tab.layout);
    const hasValidLayout =
      layoutSessionIds.length > 0 && layoutSessionIds.every((sessionId) => sessionIds.has(sessionId));
    const focusedSessionId =
      tab.focusedSessionId ||
      findFirstLayoutSessionId(tab.layout) ||
      sessions[0]!.id;
    const normalizedFocusedSessionId = hasValidFocusedSession ? focusedSessionId : sessions[0]!.id;
    const normalizedLayout = hasValidLayout
      ? tab.layout
      : createSingleLeafLayout(normalizedFocusedSessionId, `${normalizedFocusedSessionId}:root`);

    if (
      normalizedFocusedSessionId === tab.focusedSessionId &&
      normalizedLayout === tab.layout
    ) {
      return tab;
    }

    return this.database.updateTab({
      ...tab,
      focusedSessionId: normalizedFocusedSessionId,
      layout: normalizedLayout,
    });
  }

  private deriveAutomaticTabTitle(
    tab: SavedWorkspaceTab,
    sessions: SavedTerminalSession[],
  ): string {
    const focusedSession =
      sessions.find((session) => session.id === tab.focusedSessionId) ?? sessions[0]!;
    const shellProfile = this.requireShellProfile(focusedSession.shellProfileId);
    return deriveTabTitle(focusedSession.lastKnownCwd, shellProfile.label);
  }

  private requireProject(projectId: string): Project {
    const project = this.database.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  private requireTab(tabId: string): SavedWorkspaceTab {
    const tab = this.database.getTab(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    return tab;
  }

  private requireSession(sessionId: string): SavedTerminalSession {
    const session = this.database.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private requireSessionsForTab(tabId: string): SavedTerminalSession[] {
    const sessions = this.database.listSessionsForTab(tabId);
    if (sessions.length === 0) {
      throw new Error(`Tab has no sessions: ${tabId}`);
    }
    return sessions;
  }

  private requireShellProfile(shellProfileId: string): ShellProfile {
    const profile = this.database
      .listShellProfiles()
      .find((entry) => entry.id === shellProfileId);

    if (!profile) {
      throw new Error(`Shell profile not found: ${shellProfileId}`);
    }
    return profile;
  }

  private resolveProjectDefaultCwd(project: Project): string | null {
    const rootPath = project.rootPath.trim();
    if (!rootPath) {
      return null;
    }

    return fs.existsSync(rootPath) ? rootPath : null;
  }

  private isConfiguredProjectRootMissing(project: Project): boolean {
    const rootPath = project.rootPath.trim();
    return rootPath.length > 0 && !fs.existsSync(rootPath);
  }

  private selectWorkspaceTabId(tabs: WorkspaceTab[]): string | null {
    if (tabs.length === 0) {
      return null;
    }

    const sorted = [...tabs].sort(
      (left, right) =>
        right.lastActivatedAt.localeCompare(left.lastActivatedAt) ||
        left.restoreOrder - right.restoreOrder,
    );
    return sorted[0]?.id ?? tabs[0]?.id ?? null;
  }
}
