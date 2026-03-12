import crypto from "node:crypto";
import fs from "node:fs";
import {
  collectLayoutSessionIds,
  createLayoutFromPreset,
  createSingleLeafLayout,
  findFirstLayoutSessionId,
  flattenLayoutLeafSessionIds,
  getLayoutPresetLeafCount,
} from "../../shared/layout.js";
import { deriveTabTitle, normalizeWindowsPath } from "../../shared/paths.js";
import {
  findFirstTemplatePaneId,
  mapPersistedLayoutToTemplateLayout,
  mapTemplateLayoutToPersistedLayout,
  parseTemplateDocument,
  serializeTemplateDocument,
  serializeTemplateLibraryDocument,
} from "../../shared/templates.js";
import type {
  ActivateSessionInput,
  ApplyTemplateInput,
  ApplyLayoutPresetInput,
  BootstrapData,
  CreateProjectInput,
  CreateTabInput,
  HistoryEntry,
  HydratedSession,
  Project,
  ProjectWorkspace,
  RenameTabInput,
  RenameTemplateInput,
  RecallHistoryResult,
  SaveProjectAsTemplateInput,
  SavedTerminalSession,
  SavedWorkspaceTab,
  SetFocusedSessionInput,
  ShellProfile,
  ShellProfileAvailability,
  TemplateDefinition,
  TemplateTab,
  UpdateProjectInput,
  WorkspaceTemplate,
  WorkspaceTab,
} from "../../shared/types.js";
import { DatabaseService } from "./database.js";
import { PtyManager } from "./pty-manager.js";
import { ShellCatalog } from "./shell-catalog.js";
import {
  encodeTemplatePathReference,
  resolveTemplatePathReference,
} from "./template-paths.js";

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
      templates: this.database.listTemplates(),
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

  async deleteProject(projectId: string): Promise<BootstrapData> {
    const tabs = this.database.listTabsForProject(projectId);
    await Promise.all(tabs.map((tab) => this.ptyManager.closeTab(tab.id)));
    this.database.deleteProject(projectId);
    return this.bootstrap();
  }

  saveProjectAsTemplate(input: SaveProjectAsTemplateInput): WorkspaceTemplate[] {
    const project = this.requireProject(input.projectId);
    const name = input.name.trim();
    if (!name) {
      throw new Error("Template name is required.");
    }

    const tabs = this.database
      .listTabsForProject(project.id)
      .map((tab) => this.normalizeTabState(tab));
    if (tabs.length === 0) {
      throw new Error("Cannot save a template from a project with no tabs.");
    }

    this.database.createTemplate({
      id: crypto.randomUUID(),
      name,
      tabs: tabs.map((tab) =>
        this.extractTemplateTab(project, tab, input.includeWorkingDirectories),
      ),
    });

    return this.database.listTemplates();
  }

  renameTemplate(input: RenameTemplateInput): WorkspaceTemplate[] {
    const template = this.requireTemplate(input.templateId);
    const name = input.name.trim();
    if (!name) {
      throw new Error("Template name is required.");
    }

    this.database.updateTemplate({
      ...template,
      name,
    });

    return this.database.listTemplates();
  }

  deleteTemplate(templateId: string): WorkspaceTemplate[] {
    this.requireTemplate(templateId);
    this.database.deleteTemplate(templateId);
    return this.database.listTemplates();
  }

  async applyTemplate(input: ApplyTemplateInput): Promise<ProjectWorkspace> {
    const project = this.requireProject(input.projectId);
    const template = this.requireTemplate(input.templateId);
    if (template.tabs.length === 0) {
      throw new Error("Template does not contain any tabs.");
    }

    const previousTabs =
      input.mode === "replace" ? this.database.listTabsForProject(project.id) : [];
    const firstRestoreOrder =
      input.mode === "append" ? this.database.getMaxRestoreOrder(project.id) + 1 : 1;
    const createdTabIds: string[] = [];

    for (const [index, templateTab] of template.tabs.entries()) {
      const created = this.materializeTemplateTab(
        project,
        templateTab,
        firstRestoreOrder + index,
      );
      createdTabIds.push(created.tab.id);
    }

    if (input.mode === "replace") {
      await Promise.all(previousTabs.map((tab) => this.ptyManager.closeTab(tab.id)));
      for (const tab of previousTabs) {
        this.database.deleteTab(tab.id);
      }
    }

    const workspace = this.getProjectWorkspace(project.id);
    return {
      ...workspace,
      selectedTabId: createdTabIds[0] ?? workspace.selectedTabId,
    };
  }

  importTemplates(serialized: string): {
    templates: WorkspaceTemplate[];
    importedCount: number;
  } {
    const definitions = parseTemplateDocument(serialized);
    const existingNames = new Set(this.database.listTemplates().map((template) => template.name));

    for (const definition of definitions) {
      const name = this.createImportedTemplateName(definition.name, existingNames);
      existingNames.add(name);
      this.database.createTemplate({
        id: crypto.randomUUID(),
        name,
        tabs: definition.tabs,
      });
    }

    return {
      templates: this.database.listTemplates(),
      importedCount: definitions.length,
    };
  }

  exportTemplate(templateId: string): string {
    const template = this.requireTemplate(templateId);
    return serializeTemplateDocument(this.toTemplateDefinition(template));
  }

  exportAllTemplates(): string {
    return serializeTemplateLibraryDocument(
      this.database.listTemplates().map((template) => this.toTemplateDefinition(template)),
    );
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

  async closeTab(tabId: string): Promise<ProjectWorkspace> {
    const tab = this.requireTab(tabId);
    if (this.database.getTabCountForProject(tab.projectId) <= 1) {
      throw new Error("A project must keep at least one terminal tab in Phase 1.");
    }

    await this.ptyManager.closeTab(tabId);
    this.database.deleteTab(tabId);
    return this.getProjectWorkspace(tab.projectId);
  }

  applyLayoutPreset(input: ApplyLayoutPresetInput): ProjectWorkspace {
    const tab = this.normalizeTabState(this.requireTab(input.tabId));
    let sessions = this.requireSessionsForTab(tab.id);
    const requiredLeafCount = getLayoutPresetLeafCount(input.presetId);

    if (sessions.length < requiredLeafCount) {
      const sourceSession = this.resolvePresetSourceSession(tab, sessions);
      for (let sessionOrder = sessions.length + 1; sessionOrder <= requiredLeafCount; sessionOrder += 1) {
        const nextSession = this.database.createSession({
          id: crypto.randomUUID(),
          tabId: tab.id,
          shellProfileId: sourceSession.shellProfileId,
          lastKnownCwd: sourceSession.lastKnownCwd,
          sessionOrder,
        });
        sessions = [...sessions, nextSession];
      }
    }

    const visibleSessionIds = sessions
      .slice(0, requiredLeafCount)
      .map((session) => session.id);
    const nextLayout = createLayoutFromPreset(input.presetId, visibleSessionIds);
    const nextFocusedSessionId = visibleSessionIds.includes(tab.focusedSessionId)
      ? tab.focusedSessionId
      : visibleSessionIds[0]!;

    this.database.updateTab({
      ...tab,
      layout: nextLayout,
      focusedSessionId: nextFocusedSessionId,
      title:
        tab.customTitle ??
        this.deriveAutomaticTabTitleForFocusedSessionId(nextFocusedSessionId, sessions),
    });

    return this.getProjectWorkspace(tab.projectId);
  }

  setFocusedSession(input: SetFocusedSessionInput): ProjectWorkspace {
    const tab = this.normalizeTabState(this.requireTab(input.tabId));
    const sessions = this.requireSessionsForTab(tab.id);
    const targetSession = sessions.find((session) => session.id === input.sessionId);
    if (!targetSession) {
      throw new Error(`Session does not belong to tab: ${input.sessionId}`);
    }

    this.database.updateTab({
      ...tab,
      focusedSessionId: targetSession.id,
      title:
        tab.customTitle ??
        this.deriveAutomaticTabTitleForFocusedSessionId(targetSession.id, sessions),
    });

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

  listHistory(sessionId: string, limit = 100): HistoryEntry[] {
    this.requireSession(sessionId);
    return this.database.listHistoryForSession(sessionId, limit);
  }

  recallHistory(sessionId: string, commandText: string): RecallHistoryResult {
    return this.ptyManager.recallHistory(sessionId, commandText);
  }

  async shutdown(): Promise<void> {
    await this.ptyManager.shutdown();
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

  private deriveAutomaticTabTitleForFocusedSessionId(
    focusedSessionId: string,
    sessions: SavedTerminalSession[],
  ): string {
    const focusedSession =
      sessions.find((session) => session.id === focusedSessionId) ?? sessions[0]!;
    const shellProfile = this.requireShellProfile(focusedSession.shellProfileId);
    return deriveTabTitle(focusedSession.lastKnownCwd, shellProfile.label);
  }

  private resolvePresetSourceSession(
    tab: SavedWorkspaceTab,
    sessions: SavedTerminalSession[],
  ): SavedTerminalSession {
    const firstVisibleSessionId = flattenLayoutLeafSessionIds(tab.layout)[0];
    return (
      sessions.find((session) => session.id === firstVisibleSessionId) ??
      sessions.find((session) => session.id === tab.focusedSessionId) ??
      sessions[0]!
    );
  }

  private extractTemplateTab(
    project: Project,
    tab: SavedWorkspaceTab,
    includeWorkingDirectories: boolean,
  ): TemplateTab {
    const sessions = this.requireSessionsForTab(tab.id);
    const sessionIdsById = new Map(sessions.map((session) => [session.id, session]));
    const visibleSessionIds = flattenLayoutLeafSessionIds(tab.layout);
    if (visibleSessionIds.length === 0) {
      throw new Error(`Tab has no visible panes: ${tab.id}`);
    }

    const panes = visibleSessionIds.map((sessionId) => {
      const session = sessionIdsById.get(sessionId);
      if (!session) {
        throw new Error(`Tab layout references a missing session: ${sessionId}`);
      }

      return {
        id: session.id,
        shellProfileId: session.shellProfileId,
        cwd: includeWorkingDirectories
          ? encodeTemplatePathReference(project.rootPath, session.lastKnownCwd)
          : null,
      };
    });

    return {
      title: tab.title,
      layout: mapPersistedLayoutToTemplateLayout(tab.layout),
      focusedPaneId: visibleSessionIds.includes(tab.focusedSessionId)
        ? tab.focusedSessionId
        : visibleSessionIds[0]!,
      panes,
    };
  }

  private materializeTemplateTab(
    project: Project,
    templateTab: TemplateTab,
    restoreOrder: number,
  ): { tab: SavedWorkspaceTab; sessions: SavedTerminalSession[] } {
    const tabId = crypto.randomUUID();
    const paneSessionIds = new Map<string, string>();
    const sessions = templateTab.panes.map((pane, index) => {
      const sessionId = crypto.randomUUID();
      paneSessionIds.set(pane.id, sessionId);

      return {
        id: sessionId,
        tabId,
        shellProfileId: this.resolveTemplateShellProfileId(project, pane.shellProfileId),
        lastKnownCwd: resolveTemplatePathReference(project.rootPath, pane.cwd),
        sessionOrder: index + 1,
      };
    });

    const focusedPaneId =
      templateTab.panes.some((pane) => pane.id === templateTab.focusedPaneId)
        ? templateTab.focusedPaneId
        : findFirstTemplatePaneId(templateTab.layout);
    const focusedSessionId =
      (focusedPaneId ? paneSessionIds.get(focusedPaneId) : null) ??
      sessions[0]?.id;
    if (!focusedSessionId) {
      throw new Error("Template tab does not contain any panes.");
    }

    return this.database.createTabWithSessions({
      tab: {
        id: tabId,
        projectId: project.id,
        title: templateTab.title,
        customTitle: templateTab.title,
        restoreOrder,
        layout: mapTemplateLayoutToPersistedLayout(templateTab.layout, paneSessionIds),
        focusedSessionId,
      },
      sessions,
    });
  }

  private resolveTemplateShellProfileId(project: Project, shellProfileId: string): string {
    return this.shellCatalog.isAvailable(shellProfileId)
      ? shellProfileId
      : project.defaultShellProfileId;
  }

  private toTemplateDefinition(template: WorkspaceTemplate): TemplateDefinition {
    return {
      name: template.name,
      tabs: template.tabs,
    };
  }

  private createImportedTemplateName(
    desiredName: string,
    existingNames: Set<string>,
  ): string {
    if (!existingNames.has(desiredName)) {
      return desiredName;
    }

    let suffix = 1;
    while (true) {
      const candidate =
        suffix === 1 ? `${desiredName} (Imported)` : `${desiredName} (Imported ${suffix})`;
      if (!existingNames.has(candidate)) {
        return candidate;
      }
      suffix += 1;
    }
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

  private requireTemplate(templateId: string): WorkspaceTemplate {
    const template = this.database.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    return template;
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
