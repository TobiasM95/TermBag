import crypto from "node:crypto";
import fs from "node:fs";
import { deriveTabTitle, normalizeWindowsPath } from "../../shared/paths.js";
import type {
  ActivateTabInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  HydratedTabSession,
  Project,
  ProjectWorkspace,
  RenameTabInput,
  RecallHistoryResult,
  ShellProfile,
  ShellProfileAvailability,
  UpdateProjectInput,
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
    const tabs = this.database.listTabsForProject(projectId);
    const snapshots = new Map(
      this.database
        .listSnapshotsForProject(projectId)
        .map((snapshot) => [snapshot.tabId, snapshot]),
    );

    const workspaceTabs: WorkspaceTab[] = tabs.map((tab) => ({
      ...tab,
      snapshot: snapshots.get(tab.id) ?? null,
      runtime: this.ptyManager.getRuntimeSummary(tab.id),
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

    this.database.createTab({
      id: crypto.randomUUID(),
      projectId: project.id,
      shellProfileId,
      title: deriveTabTitle(cwd, shellProfile.label),
      restoreOrder: this.database.getMaxRestoreOrder(project.id) + 1,
      lastKnownCwd: cwd,
    });
    return this.getProjectWorkspace(project.id);
  }

  renameTab(input: RenameTabInput): ProjectWorkspace {
    const tab = this.requireTab(input.tabId);
    const shellProfile = this.requireShellProfile(tab.shellProfileId);
    const nextCustomTitle = input.title.trim();

    this.database.updateTab({
      ...tab,
      title:
        nextCustomTitle ||
        deriveTabTitle(tab.lastKnownCwd, shellProfile.label),
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

  async activateTab(input: ActivateTabInput): Promise<HydratedTabSession> {
    const tab = this.requireTab(input.tabId);
    const project = this.requireProject(tab.projectId);
    const shellProfile = this.requireShellProfile(tab.shellProfileId);
    this.database.markTabActivated(tab.id);

    const activated = await this.ptyManager.activateTab(
      input,
      project,
      this.requireTab(input.tabId),
      shellProfile,
    );

    return {
      tabId: input.tabId,
      runtime: activated.runtime,
      liveOutput: activated.liveOutput,
    };
  }

  resizeTab(tabId: string, cols: number, rows: number): void {
    this.ptyManager.resizeTab(tabId, cols, rows);
  }

  writeToTab(tabId: string, data: string): void {
    this.ptyManager.writeToTab(tabId, data);
  }

  async restartTab(input: ActivateTabInput): Promise<HydratedTabSession> {
    const tab = this.requireTab(input.tabId);
    const project = this.requireProject(tab.projectId);
    const shellProfile = this.requireShellProfile(tab.shellProfileId);
    const restarted = await this.ptyManager.restartTab(input, project, tab, shellProfile);

    return {
      tabId: tab.id,
      runtime: restarted.runtime,
      liveOutput: restarted.liveOutput,
    };
  }

  listHistory(projectId: string, limit = 100): HistoryEntry[] {
    this.requireProject(projectId);
    return this.database.listHistoryForProject(projectId, limit);
  }

  recallHistory(tabId: string, commandText: string): RecallHistoryResult {
    return this.ptyManager.recallHistory(tabId, commandText);
  }

  shutdown(): void {
    this.ptyManager.shutdown();
    this.database.close();
  }

  private createInitialTab(project: Project, shellProfileId: string): void {
    const shellProfile = this.requireShellProfile(shellProfileId);
    const cwd = this.resolveProjectDefaultCwd(project);
    this.database.createTab({
      id: crypto.randomUUID(),
      projectId: project.id,
      shellProfileId,
      title: deriveTabTitle(cwd, shellProfile.label),
      restoreOrder: 1,
      lastKnownCwd: cwd,
    });
  }

  private requireProject(projectId: string): Project {
    const project = this.database.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  private requireTab(tabId: string) {
    const tab = this.database.getTab(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    return tab;
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
