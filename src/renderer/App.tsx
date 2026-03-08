import { useEffect, useMemo, useState } from "react";
import { TerminalPane } from "./components/TerminalPane";
import { useAppStore } from "./store/app-store";
import type {
  CreateProjectInput,
  LayoutPresetId,
  PersistedTabLayout,
  Project,
  ShellProfileAvailability,
  TabLayoutNode,
  UpdateProjectInput,
  WorkspaceSession,
  WorkspaceTab,
} from "../shared/types";

type ModalState =
  | { mode: "create" }
  | { mode: "edit"; project: Project }
  | null;

type TabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
} | null;

type RenameTabState = {
  tabId: string;
  title: string;
} | null;

type ThemeMode = "dark" | "light";
type TabAlignment = "left" | "center" | "right";
type ProjectSortMode = "created" | "alphabetical";
type ScrollbarMode = "minimal" | "aggressive";
type HotkeyModifier = "control" | "alt" | "meta";

const THEME_STORAGE_KEY = "termbag-theme-mode";
const TAB_ALIGNMENT_STORAGE_KEY = "termbag-tab-alignment";
const PROJECT_SORT_STORAGE_KEY = "termbag-project-sort-mode";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "termbag-sidebar-collapsed";
const SCROLLBAR_MODE_STORAGE_KEY = "termbag-scrollbar-mode";
const PROJECT_HOTKEY_MODIFIER_STORAGE_KEY = "termbag-project-hotkey-modifier";
const TAB_HOTKEY_MODIFIER_STORAGE_KEY = "termbag-tab-hotkey-modifier";

type LayoutPresetDefinition = {
  id: LayoutPresetId;
  label: string;
  description: string;
};

const LAYOUT_PRESETS: LayoutPresetDefinition[] = [
  {
    id: "single",
    label: "Single",
    description: "One shell filling the entire workspace.",
  },
  {
    id: "split_horizontal",
    label: "Horizontal split",
    description: "Two shells stacked top and bottom.",
  },
  {
    id: "split_vertical",
    label: "Vertical split",
    description: "Two shells side by side.",
  },
  {
    id: "grid_2x2",
    label: "2x2 grid",
    description: "Four shells in an even grid.",
  },
  {
    id: "main_left_stack_right",
    label: "1 left 2 right",
    description: "One large pane on the left with two stacked on the right.",
  },
  {
    id: "stack_left_main_right",
    label: "2 left 1 right",
    description: "Two stacked panes on the left with one large pane on the right.",
  },
];

function detectMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform =
    navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac/i.test(platform);
}

function getSupportedHotkeyModifiers(isMacPlatform: boolean): HotkeyModifier[] {
  return isMacPlatform ? ["meta", "control", "alt"] : ["control", "alt"];
}

function getDefaultProjectHotkeyModifier(isMacPlatform: boolean): HotkeyModifier {
  return isMacPlatform ? "meta" : "control";
}

function getDefaultTabHotkeyModifier(isMacPlatform: boolean): HotkeyModifier {
  return isMacPlatform ? "control" : "alt";
}

function getStoredHotkeyModifier(
  storageKey: string,
  supportedModifiers: HotkeyModifier[],
  fallback: HotkeyModifier,
): HotkeyModifier {
  if (typeof window === "undefined") {
    return fallback;
  }

  const stored = window.localStorage.getItem(storageKey);
  return stored && supportedModifiers.includes(stored as HotkeyModifier)
    ? (stored as HotkeyModifier)
    : fallback;
}

function getModifierLabel(modifier: HotkeyModifier, isMacPlatform: boolean): string {
  switch (modifier) {
    case "meta":
      return isMacPlatform ? "Command" : "Meta";
    case "alt":
      return isMacPlatform ? "Option" : "Alt";
    case "control":
    default:
      return isMacPlatform ? "Control" : "Ctrl";
  }
}

function getHotkeySlot(event: KeyboardEvent): number | null {
  const match = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
  if (!match) {
    return null;
  }

  const digit = Number.parseInt(match[1] ?? "", 10);
  if (Number.isNaN(digit)) {
    return null;
  }

  return digit === 0 ? 10 : digit;
}

function matchesHotkeyModifier(event: KeyboardEvent, modifier: HotkeyModifier): boolean {
  const modifierPressed =
    (modifier === "control" && event.ctrlKey) ||
    (modifier === "alt" && event.altKey) ||
    (modifier === "meta" && event.metaKey);

  return (
    modifierPressed &&
    !event.shiftKey &&
    (modifier === "control" || !event.ctrlKey) &&
    (modifier === "alt" || !event.altKey) &&
    (modifier === "meta" || !event.metaKey)
  );
}

function findFallbackHotkeyModifier(
  supportedModifiers: HotkeyModifier[],
  blockedModifier: HotkeyModifier,
  preferredModifier: HotkeyModifier,
): HotkeyModifier {
  if (preferredModifier !== blockedModifier && supportedModifiers.includes(preferredModifier)) {
    return preferredModifier;
  }

  return (
    supportedModifiers.find((modifier) => modifier !== blockedModifier) ?? preferredModifier
  );
}

function getIndexedShortcutLabel(
  modifier: HotkeyModifier,
  slot: number,
  isMacPlatform: boolean,
): string {
  return `${getModifierLabel(modifier, isMacPlatform)}+${slot === 10 ? "0" : String(slot)}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  // xterm routes keyboard input through a hidden textarea. App hotkeys should
  // still win there unless the user holds Shift to intentionally pass through.
  if (target.closest(".xterm-helper-textarea")) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function consumeShortcutEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function getShellLabel(shellProfileId: string): string {
  switch (shellProfileId) {
    case "pwsh":
      return "PowerShell 7";
    case "powershell":
      return "Windows PowerShell";
    case "cmd":
      return "Command Prompt";
    default:
      return shellProfileId;
  }
}

function isTwoLeafSplit(
  node: TabLayoutNode,
  direction: "row" | "column",
): boolean {
  return (
    node.kind === "split" &&
    node.direction === direction &&
    node.children.length === 2 &&
    node.children[0]?.kind === "leaf" &&
    node.children[1]?.kind === "leaf"
  );
}

function detectLayoutPresetId(layout: PersistedTabLayout): LayoutPresetId | null {
  const { root } = layout;

  if (root.kind === "leaf") {
    return "single";
  }

  if (isTwoLeafSplit(root, "column")) {
    return "split_horizontal";
  }

  if (isTwoLeafSplit(root, "row")) {
    return "split_vertical";
  }

  if (
    root.direction === "column" &&
    root.children.length === 2 &&
    root.children[0] &&
    root.children[1] &&
    isTwoLeafSplit(root.children[0], "row") &&
    isTwoLeafSplit(root.children[1], "row")
  ) {
    return "grid_2x2";
  }

  if (
    root.direction === "row" &&
    root.children.length === 2 &&
    root.children[0]?.kind === "leaf" &&
    root.children[1] &&
    isTwoLeafSplit(root.children[1], "column")
  ) {
    return "main_left_stack_right";
  }

  if (
    root.direction === "row" &&
    root.children.length === 2 &&
    root.children[0] &&
    isTwoLeafSplit(root.children[0], "column") &&
    root.children[1]?.kind === "leaf"
  ) {
    return "stack_left_main_right";
  }

  return null;
}

export function App() {
  const hasPreloadApi =
    typeof window !== "undefined" && typeof window.termbag !== "undefined";
  const isMacPlatform = useMemo(() => detectMacPlatform(), []);
  const supportedHotkeyModifiers = useMemo(
    () => getSupportedHotkeyModifiers(isMacPlatform),
    [isMacPlatform],
  );

  const {
    bootstrapped,
    loading,
    error,
    projects,
    shellProfiles,
    selectedProjectId,
    workspaces,
    historyEntries,
    historyLoading,
    historyError,
    bootstrap,
    loadProjectWorkspace,
    selectProject,
    setSelectedTab,
    createProject,
    updateProject,
    deleteProject,
    createTab,
    renameTab,
    closeTab,
    applyLayoutPreset,
    setFocusedSession,
    loadHistory,
    applyTerminalEvent,
    clearError,
  } = useAppStore();

  const [modalState, setModalState] = useState<ModalState>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const [shellPickerOpen, setShellPickerOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState>(null);
  const [renameTabState, setRenameTabState] = useState<RenameTabState>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  });
  const [recallNotice, setRecallNotice] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return "dark";
    }

    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" ? "light" : "dark";
  });
  const [tabAlignment, setTabAlignment] = useState<TabAlignment>(() => {
    if (typeof window === "undefined") {
      return "left";
    }

    const stored = window.localStorage.getItem(TAB_ALIGNMENT_STORAGE_KEY);
    return stored === "center" || stored === "right" ? stored : "left";
  });
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>(() => {
    if (typeof window === "undefined") {
      return "created";
    }

    const stored = window.localStorage.getItem(PROJECT_SORT_STORAGE_KEY);
    return stored === "alphabetical" ? "alphabetical" : "created";
  });
  const [scrollbarMode, setScrollbarMode] = useState<ScrollbarMode>(() => {
    if (typeof window === "undefined") {
      return "minimal";
    }

    const stored = window.localStorage.getItem(SCROLLBAR_MODE_STORAGE_KEY);
    return stored === "aggressive" ? "aggressive" : "minimal";
  });
  const [projectHotkeyModifier, setProjectHotkeyModifier] = useState<HotkeyModifier>(() =>
    getStoredHotkeyModifier(
      PROJECT_HOTKEY_MODIFIER_STORAGE_KEY,
      supportedHotkeyModifiers,
      getDefaultProjectHotkeyModifier(isMacPlatform),
    ),
  );
  const [tabHotkeyModifier, setTabHotkeyModifier] = useState<HotkeyModifier>(() =>
    getStoredHotkeyModifier(
      TAB_HOTKEY_MODIFIER_STORAGE_KEY,
      supportedHotkeyModifiers,
      findFallbackHotkeyModifier(
        supportedHotkeyModifiers,
        getDefaultProjectHotkeyModifier(isMacPlatform),
        getDefaultTabHotkeyModifier(isMacPlatform),
      ),
    ),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    if (hasPreloadApi) {
      void window.termbag.setWindowTheme(themeMode);
    }
  }, [hasPreloadApi, themeMode]);

  useEffect(() => {
    window.localStorage.setItem(TAB_ALIGNMENT_STORAGE_KEY, tabAlignment);
  }, [tabAlignment]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_SORT_STORAGE_KEY, projectSortMode);
  }, [projectSortMode]);

  useEffect(() => {
    document.documentElement.dataset.scrollbars = scrollbarMode;
    window.localStorage.setItem(SCROLLBAR_MODE_STORAGE_KEY, scrollbarMode);
  }, [scrollbarMode]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_HOTKEY_MODIFIER_STORAGE_KEY, projectHotkeyModifier);
  }, [projectHotkeyModifier]);

  useEffect(() => {
    window.localStorage.setItem(TAB_HOTKEY_MODIFIER_STORAGE_KEY, tabHotkeyModifier);
  }, [tabHotkeyModifier]);

  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      sidebarCollapsed ? "true" : "false",
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!hasPreloadApi) {
      return;
    }
    void bootstrap();
  }, [bootstrap, hasPreloadApi]);

  useEffect(() => {
    if (!hasPreloadApi) {
      return;
    }

    return window.termbag.onTerminalEvent((event) => {
      applyTerminalEvent(event);
    });
  }, [applyTerminalEvent, hasPreloadApi]);

  useEffect(() => {
    if (selectedProjectId && !workspaces[selectedProjectId]) {
      void loadProjectWorkspace(selectedProjectId);
    }
  }, [loadProjectWorkspace, selectedProjectId, workspaces]);

  useEffect(() => {
    if (!error) {
      return;
    }

    const timer = window.setTimeout(() => {
      clearError();
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [clearError, error]);

  const selectedWorkspace = selectedProjectId ? workspaces[selectedProjectId] : undefined;
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? selectedWorkspace?.project;

  const sortedProjects = useMemo(() => {
    const nextProjects = [...projects];
    if (projectSortMode === "alphabetical") {
      nextProjects.sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
          left.createdAt.localeCompare(right.createdAt),
      );
      return nextProjects;
    }

    nextProjects.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
    return nextProjects;
  }, [projectSortMode, projects]);

  const activeTab = useMemo<WorkspaceTab | null>(() => {
    if (!selectedWorkspace) {
      return null;
    }

    return (
      selectedWorkspace.tabs.find((tab) => tab.id === selectedWorkspace.selectedTabId) ??
      selectedWorkspace.tabs[0] ??
      null
    );
  }, [selectedWorkspace]);

  const activeSession = useMemo<WorkspaceSession | null>(() => {
    if (!activeTab) {
      return null;
    }

    return (
      activeTab.sessions.find((session) => session.id === activeTab.focusedSessionId) ??
      activeTab.sessions[0] ??
      null
    );
  }, [activeTab]);

  const activeSessionsById = useMemo(() => {
    if (!activeTab) {
      return new Map<string, WorkspaceSession>();
    }

    return new Map(activeTab.sessions.map((session) => [session.id, session]));
  }, [activeTab]);

  const activeLayoutPresetId = useMemo(() => {
    if (!activeTab) {
      return null;
    }

    return detectLayoutPresetId(activeTab.layout);
  }, [activeTab]);

  useEffect(() => {
    if (
      selectedWorkspace &&
      !activeTab &&
      selectedWorkspace.tabs.length > 0
    ) {
      setSelectedTab(selectedWorkspace.project.id, selectedWorkspace.tabs[0]!.id);
    }
  }, [activeTab, selectedWorkspace, setSelectedTab]);

  const updateProjectHotkeyModifier = (modifier: HotkeyModifier) => {
    if (!supportedHotkeyModifiers.includes(modifier)) {
      return;
    }

    setProjectHotkeyModifier(modifier);
    if (modifier === tabHotkeyModifier) {
      setTabHotkeyModifier(
        findFallbackHotkeyModifier(supportedHotkeyModifiers, modifier, projectHotkeyModifier),
      );
    }
  };

  const updateTabHotkeyModifier = (modifier: HotkeyModifier) => {
    if (!supportedHotkeyModifiers.includes(modifier)) {
      return;
    }

    setTabHotkeyModifier(modifier);
    if (modifier === projectHotkeyModifier) {
      setProjectHotkeyModifier(
        findFallbackHotkeyModifier(supportedHotkeyModifiers, modifier, tabHotkeyModifier),
      );
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTabContextMenu(null);
      }

      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      if (
        modalState ||
        historyOpen ||
        settingsOpen ||
        layoutsOpen ||
        shellPickerOpen ||
        renameTabState
      ) {
        return;
      }

      const slot = getHotkeySlot(event);
      if (slot !== null) {
        if (matchesHotkeyModifier(event, projectHotkeyModifier)) {
          const targetProject = sortedProjects[slot - 1];
          if (!targetProject) {
            return;
          }

          consumeShortcutEvent(event);
          setTabContextMenu(null);
          if (targetProject.id === selectedProjectId) {
            return;
          }
          selectProject(targetProject.id);
          return;
        }

        if (matchesHotkeyModifier(event, tabHotkeyModifier) && selectedWorkspace) {
          const targetTab = selectedWorkspace.tabs[slot - 1];
          if (!targetTab) {
            return;
          }

          consumeShortcutEvent(event);
          setTabContextMenu(null);
          if (targetTab.id === selectedWorkspace.selectedTabId) {
            return;
          }
          setSelectedTab(selectedWorkspace.project.id, targetTab.id);
          return;
        }
      }

      if (
        !event.ctrlKey ||
        !event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.key.toLowerCase() !== "r"
      ) {
        return;
      }

      if (!selectedProjectId || !activeTab || !activeSession) {
        return;
      }

      event.preventDefault();
      setHistoryOpen(true);
      setRecallNotice(null);
      void loadHistory(selectedProjectId);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeSession,
    activeTab,
    historyOpen,
    loadHistory,
    modalState,
    projectHotkeyModifier,
    renameTabState,
    selectedProjectId,
    selectProject,
    selectedWorkspace,
    setSelectedTab,
    setFocusedSession,
    settingsOpen,
    layoutsOpen,
    shellPickerOpen,
    sortedProjects,
    tabHotkeyModifier,
  ]);

  const handleProjectSubmit = async (
    input: CreateProjectInput | UpdateProjectInput,
  ): Promise<void> => {
    if ("id" in input) {
      await updateProject(input);
    } else {
      await createProject(input);
    }
    setModalState(null);
  };

  if (!hasPreloadApi) {
    return (
      <div className="fatal-screen">
        <div className="fatal-screen__panel">
          <h1>Preload bridge unavailable</h1>
          <p>
            The renderer could not find <code>window.termbag</code>, so Electron did
            not expose the preload API correctly.
          </p>
          <p>
            Rebuild the Electron outputs and restart the app. If this keeps happening,
            the preload script is not loading.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="app-frame">
        <div className="window-titlebar">
          <div className="window-titlebar__project" title={selectedProject?.name ?? ""}>
            {selectedProject?.name ?? ""}
          </div>
          <div className={`tab-strip tab-strip--titlebar tab-strip--${tabAlignment}`}>
            {selectedWorkspace?.tabs.map((tab, tabIndex) => {
              const hotkeyHint =
                tabIndex < 10
                  ? getIndexedShortcutLabel(tabHotkeyModifier, tabIndex + 1, isMacPlatform)
                  : null;

              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`tab-chip ${activeTab?.id === tab.id ? "tab-chip--active" : ""}`}
                  onClick={() => setSelectedTab(selectedWorkspace.project.id, tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedTab(selectedWorkspace.project.id, tab.id);
                    setTabContextMenu({
                      tabId: tab.id,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  title={hotkeyHint ? `${tab.title} (${hotkeyHint})` : tab.title}
                >
                  <span>{tab.title}</span>
                  <span
                    className="tab-chip__close"
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(tab.id);
                    }}
                  >
                    x
                  </span>
                </button>
              );
            }) ?? null}
            {selectedProject ? (
              <>
                <button
                  type="button"
                  className="tab-chip tab-chip--action"
                  onClick={() => void createTab({ projectId: selectedProject.id })}
                  title="New tab with default shell"
                >
                  +
                </button>
                <button
                  type="button"
                  className="tab-chip tab-chip--action"
                  onClick={() => setShellPickerOpen(true)}
                  title="New tab with selected shell"
                >
                  *
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className={`app-shell ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}>
        <aside className={`sidebar ${sidebarCollapsed ? "sidebar--collapsed" : ""}`}>
          <div className="sidebar__top">
            <button
              type="button"
              className="icon-button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? ">" : "<"}
            </button>
            {!sidebarCollapsed ? (
              <div className="sidebar__controls">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setModalState({ mode: "create" })}
                >
                  New project
                </button>
              </div>
            ) : null}
          </div>

          <div className="project-list">
            {projects.length === 0 ? (
              <div className="sidebar-empty-card">
                {!sidebarCollapsed ? (
                  <>
                    <strong>No projects saved</strong>
                    <p>Create your first project to start opening tabs.</p>
                  </>
                ) : (
                  <strong>0</strong>
                )}
              </div>
            ) : null}

            {sortedProjects.map((project, projectIndex) => {
              const isActive = project.id === selectedProjectId;
              const hotkeyHint =
                projectIndex < 10
                  ? getIndexedShortcutLabel(
                      projectHotkeyModifier,
                      projectIndex + 1,
                      isMacPlatform,
                    )
                  : null;
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`project-card ${isActive ? "project-card--active" : ""} ${sidebarCollapsed ? "project-card--collapsed" : ""}`}
                  onClick={() => selectProject(project.id)}
                  title={hotkeyHint ? `${project.name} (${hotkeyHint})` : project.name}
                >
                  {sidebarCollapsed ? (
                    <span className="project-card__mono">
                      {project.name.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                  ) : (
                    <>
                      <span className="project-card__top">
                        <span className="project-card__name" title={project.name}>
                          {project.name}
                        </span>
                      </span>
                      <span className="project-card__actions">
                        <button
                          type="button"
                          className="icon-button project-card__action-button"
                          title="Edit project"
                          aria-label="Edit project"
                          onClick={(event) => {
                            event.stopPropagation();
                            setModalState({ mode: "edit", project });
                          }}
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-button project-card__action-button danger"
                          title="Delete project"
                          aria-label="Delete project"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (window.confirm(`Delete project "${project.name}"?`)) {
                              void deleteProject(project.id);
                            }
                          }}
                        >
                          <DeleteIcon />
                        </button>
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>

          <div className="sidebar__bottom">
            <button
              type="button"
              className="ghost-button sidebar__bottom-button sidebar__layouts-button"
              onClick={() => setLayoutsOpen(true)}
              title={activeTab ? "Layouts" : "Select a tab to change layouts"}
              aria-label="Layouts"
              disabled={!activeTab}
            >
              <LayoutsIcon />
              {!sidebarCollapsed ? <span>Layouts</span> : null}
            </button>
            <button
              type="button"
              className="ghost-button sidebar__bottom-button sidebar__settings-button"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon />
              {!sidebarCollapsed ? <span>Settings</span> : null}
            </button>
          </div>
        </aside>

        <main className="workspace">
          {!bootstrapped && loading ? (
            <div className="empty-state">
              <h2>Loading workspace</h2>
            </div>
          ) : null}

          {bootstrapped && projects.length === 0 ? (
            <div className="empty-state">
              <h2>No projects yet</h2>
              <p>Create a project to start restoring and grouping terminal tabs.</p>
              <ProjectBootstrapPanel
                shellProfiles={shellProfiles}
                onSubmit={async (input) => {
                  await createProject(input);
                }}
              />
              <button
                type="button"
                className="ghost-button"
                onClick={() => setModalState({ mode: "create" })}
              >
                Open full project form
              </button>
            </div>
          ) : null}

          {selectedProject && selectedWorkspace ? (
            <div className="workspace-session">
              {activeTab ? (
                <TabLayoutView
                  project={selectedProject}
                  tab={activeTab}
                  node={activeTab.layout.root}
                  sessionsById={activeSessionsById}
                  focusedSessionId={activeTab.focusedSessionId}
                  themeMode={themeMode}
                  onFocusSession={(sessionId) => {
                    if (activeTab.focusedSessionId === sessionId) {
                      return;
                    }

                    void setFocusedSession({
                      tabId: activeTab.id,
                      sessionId,
                    });
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </main>
      </div>
      </div>

      {error ? <FloatingError message={error} /> : null}

      {modalState ? (
        <ProjectModal
          shellProfiles={shellProfiles}
          initialProject={modalState.mode === "edit" ? modalState.project : null}
          onClose={() => setModalState(null)}
          onSubmit={handleProjectSubmit}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          isMacPlatform={isMacPlatform}
          themeMode={themeMode}
          tabAlignment={tabAlignment}
          projectSortMode={projectSortMode}
          scrollbarMode={scrollbarMode}
          projectHotkeyModifier={projectHotkeyModifier}
          tabHotkeyModifier={tabHotkeyModifier}
          supportedHotkeyModifiers={supportedHotkeyModifiers}
          onClose={() => setSettingsOpen(false)}
          onThemeChange={setThemeMode}
          onTabAlignmentChange={setTabAlignment}
          onProjectSortModeChange={setProjectSortMode}
          onScrollbarModeChange={setScrollbarMode}
          onProjectHotkeyModifierChange={updateProjectHotkeyModifier}
          onTabHotkeyModifierChange={updateTabHotkeyModifier}
        />
      ) : null}

      {layoutsOpen && activeTab ? (
        <LayoutsModal
          activePresetId={activeLayoutPresetId}
          onClose={() => setLayoutsOpen(false)}
          onSelect={async (presetId) => {
            await applyLayoutPreset({
              tabId: activeTab.id,
              presetId,
            });
            setLayoutsOpen(false);
          }}
        />
      ) : null}

      {shellPickerOpen && selectedProject ? (
        <ShellPickerModal
          shellProfiles={shellProfiles}
          defaultShellProfileId={selectedProject.defaultShellProfileId}
          onClose={() => setShellPickerOpen(false)}
          onSelect={async (shellProfileId) => {
            await createTab({
              projectId: selectedProject.id,
              shellProfileId,
            });
            setShellPickerOpen(false);
          }}
        />
      ) : null}

      {tabContextMenu ? (
        <>
          <div
            className="tab-context-menu-backdrop"
            onClick={() => setTabContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setTabContextMenu(null);
            }}
          />
          <TabContextMenu
            x={tabContextMenu.x}
            y={tabContextMenu.y}
            onRename={() => {
              const tab = selectedWorkspace?.tabs.find(
                (entry) => entry.id === tabContextMenu.tabId,
              );
              if (!tab) {
                setTabContextMenu(null);
                return;
              }
              setRenameTabState({
                tabId: tab.id,
                title: tab.customTitle ?? tab.title,
              });
              setTabContextMenu(null);
            }}
            onClose={() => setTabContextMenu(null)}
          />
        </>
      ) : null}

      {renameTabState ? (
        <RenameTabModal
          initialTitle={renameTabState.title}
          onClose={() => setRenameTabState(null)}
          onSubmit={async (title) => {
            await renameTab({
              tabId: renameTabState.tabId,
              title,
            });
            setRenameTabState(null);
          }}
        />
      ) : null}

      {historyOpen && selectedProject && activeTab && activeSession ? (
        <HistoryOverlay
          activeTabId={activeTab.id}
          entries={historyEntries}
          isLoading={historyLoading}
          error={historyError}
          notice={recallNotice}
          onClose={() => setHistoryOpen(false)}
          onSelect={async (commandText) => {
            const result = await window.termbag.recallHistory({
              sessionId: activeSession.id,
              commandText,
            });
            if (result.applied) {
              setRecallNotice("Command inserted into the tracked prompt buffer.");
              setHistoryOpen(false);
            } else {
              setRecallNotice(result.reason ?? "History insertion was not applied.");
            }
          }}
        />
      ) : null}
    </>
  );
}

interface TabLayoutViewProps {
  project: Project;
  tab: WorkspaceTab;
  node: TabLayoutNode;
  sessionsById: Map<string, WorkspaceSession>;
  focusedSessionId: string;
  themeMode: ThemeMode;
  onFocusSession(sessionId: string): void;
}

function TabLayoutView({
  project,
  tab,
  node,
  sessionsById,
  focusedSessionId,
  themeMode,
  onFocusSession,
}: TabLayoutViewProps) {
  if (node.kind === "leaf") {
    const session = sessionsById.get(node.sessionId);

    if (!session) {
      return (
        <div className="workspace-layout__leaf workspace-layout__leaf--missing">
          <div className="terminal-state terminal-state--error">
            <strong>Pane unavailable</strong>
            <p>The saved layout references a session that is no longer present.</p>
          </div>
        </div>
      );
    }

    return (
      <div
        className={`workspace-layout__leaf ${session.id === focusedSessionId ? "workspace-layout__leaf--focused" : ""}`}
      >
        <TerminalPane
          project={project}
          tab={tab}
          session={session}
          themeMode={themeMode}
          isFocused={session.id === focusedSessionId}
          onFocusSession={() => onFocusSession(session.id)}
        />
      </div>
    );
  }

  return (
    <div className={`workspace-layout workspace-layout--split workspace-layout--${node.direction}`}>
      {node.children.map((child, index) => (
        <div
          key={child.id}
          className="workspace-layout__segment"
          style={{
            flexGrow: node.sizes[index] ?? 1,
            flexBasis: 0,
          }}
        >
          <TabLayoutView
            project={project}
            tab={tab}
            node={child}
            sessionsById={sessionsById}
            focusedSessionId={focusedSessionId}
            themeMode={themeMode}
            onFocusSession={onFocusSession}
          />
        </div>
      ))}
    </div>
  );
}

function ShellIcon({ shellProfileId }: { shellProfileId: string }) {
  const title = getShellLabel(shellProfileId);

  if (shellProfileId === "cmd") {
    return (
      <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
        <title>{title}</title>
        <path d="M2 3h12v10H2z" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M4 6l2 2-2 2M7.5 10H11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="square"
        />
      </svg>
    );
  }

  if (shellProfileId === "powershell") {
    return (
      <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
        <title>{title}</title>
        <path d="M3.5 4.5l5 3.5-5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8.5 11h4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }

  if (shellProfileId === "pwsh") {
    return (
      <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
        <title>{title}</title>
        <path d="M3.5 4.5l4 2.8-4 2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 5l-1 3h2l-1 3 3-4H9.2L10 5z" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
      <title>{title}</title>
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
      <path
        d="M3 11.8L3.4 9l5.9-5.9 2.6 2.6L6 11.6 3 11.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M8.8 3.6l2.6 2.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
      <path
        d="M4 5h8M6 5V3.8h4V5M5 5l.5 7h5L11 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M7 6.8v4M9 6.8v4" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
      <path
        d="M8 2.3l1 .3.4 1.3 1.3.5 1.1-.7.8.8-.7 1.1.5 1.3 1.3.4.3 1-.3 1-1.3.4-.5 1.3.7 1.1-.8.8-1.1-.7-1.3.5-.4 1.3-1 .3-1-.3-.4-1.3-1.3-.5-1.1.7-.8-.8.7-1.1-.5-1.3-1.3-.4-.3-1 .3-1 1.3-.4.5-1.3-.7-1.1.8-.8 1.1.7 1.3-.5.4-1.3 1-.3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function LayoutsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="ui-icon" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="9" y="2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2" y="9" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="9" y="9" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function LayoutPreviewIcon({ presetId }: { presetId: LayoutPresetId }) {
  const baseProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 4,
  } as const;

  switch (presetId) {
    case "single":
      return (
        <svg viewBox="0 0 100 72" className="layout-preview__icon" aria-hidden="true">
          <rect x="6" y="6" width="88" height="60" {...baseProps} />
        </svg>
      );
    case "split_horizontal":
      return (
        <svg viewBox="0 0 100 72" className="layout-preview__icon" aria-hidden="true">
          <rect x="6" y="6" width="88" height="28" {...baseProps} />
          <rect x="6" y="38" width="88" height="28" {...baseProps} />
        </svg>
      );
    case "split_vertical":
      return (
        <svg viewBox="0 0 100 72" className="layout-preview__icon" aria-hidden="true">
          <rect x="6" y="6" width="42" height="60" {...baseProps} />
          <rect x="52" y="6" width="42" height="60" {...baseProps} />
        </svg>
      );
    case "grid_2x2":
      return (
        <svg viewBox="0 0 100 72" className="layout-preview__icon" aria-hidden="true">
          <rect x="6" y="6" width="42" height="28" {...baseProps} />
          <rect x="52" y="6" width="42" height="28" {...baseProps} />
          <rect x="6" y="38" width="42" height="28" {...baseProps} />
          <rect x="52" y="38" width="42" height="28" {...baseProps} />
        </svg>
      );
    case "main_left_stack_right":
      return (
        <svg viewBox="0 0 100 72" className="layout-preview__icon" aria-hidden="true">
          <rect x="6" y="6" width="42" height="60" {...baseProps} />
          <rect x="52" y="6" width="42" height="28" {...baseProps} />
          <rect x="52" y="38" width="42" height="28" {...baseProps} />
        </svg>
      );
    case "stack_left_main_right":
      return (
        <svg viewBox="0 0 100 72" className="layout-preview__icon" aria-hidden="true">
          <rect x="6" y="6" width="42" height="28" {...baseProps} />
          <rect x="6" y="38" width="42" height="28" {...baseProps} />
          <rect x="52" y="6" width="42" height="60" {...baseProps} />
        </svg>
      );
  }
}

interface FloatingErrorProps {
  message: string;
}

function FloatingError({ message }: FloatingErrorProps) {
  return <div className="floating-error">{message}</div>;
}

interface SettingsModalProps {
  isMacPlatform: boolean;
  themeMode: ThemeMode;
  tabAlignment: TabAlignment;
  projectSortMode: ProjectSortMode;
  scrollbarMode: ScrollbarMode;
  projectHotkeyModifier: HotkeyModifier;
  tabHotkeyModifier: HotkeyModifier;
  supportedHotkeyModifiers: HotkeyModifier[];
  onClose(): void;
  onThemeChange(theme: ThemeMode): void;
  onTabAlignmentChange(alignment: TabAlignment): void;
  onProjectSortModeChange(mode: ProjectSortMode): void;
  onScrollbarModeChange(mode: ScrollbarMode): void;
  onProjectHotkeyModifierChange(modifier: HotkeyModifier): void;
  onTabHotkeyModifierChange(modifier: HotkeyModifier): void;
}

interface ShellPickerModalProps {
  shellProfiles: ShellProfileAvailability[];
  defaultShellProfileId: string;
  onClose(): void;
  onSelect(shellProfileId: string): Promise<void>;
}

function ShellPickerModal({
  shellProfiles,
  defaultShellProfileId,
  onClose,
  onSelect,
}: ShellPickerModalProps) {
  const availableProfiles = shellProfiles.filter((profile) => profile.available);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shell-picker-modal" onClick={(event) => event.stopPropagation()}>
        <div className="history-header">
          <div>
            <h3>Choose shell</h3>
            <p>Select a shell for the new tab. The project default is marked.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="shell-picker-list">
          {availableProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={`shell-picker-item ${profile.id === defaultShellProfileId ? "shell-picker-item--default" : ""}`}
              onClick={() => void onSelect(profile.id)}
            >
              <span className="shell-picker-item__icon">
                <ShellIcon shellProfileId={profile.id} />
              </span>
              <span className="shell-picker-item__content">
                <strong>{profile.label}</strong>
                <span>
                  {profile.id === defaultShellProfileId ? "Project default shell" : profile.executable}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface LayoutsModalProps {
  activePresetId: LayoutPresetId | null;
  onClose(): void;
  onSelect(presetId: LayoutPresetId): Promise<void>;
}

function LayoutsModal({ activePresetId, onClose, onSelect }: LayoutsModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal layouts-modal" onClick={(event) => event.stopPropagation()}>
        <div className="history-header">
          <div>
            <h3>Layouts</h3>
            <p>Apply a fixed pane arrangement to the current tab. Hidden sessions stay cached.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="layout-picker-list">
          {LAYOUT_PRESETS.map((preset) => {
            const isActive = activePresetId === preset.id;

            return (
              <button
                key={preset.id}
                type="button"
                className={`layout-picker-item ${isActive ? "layout-picker-item--active" : ""}`}
                onClick={() => void onSelect(preset.id)}
              >
                <span className="layout-preview">
                  <LayoutPreviewIcon presetId={preset.id} />
                </span>
                <span className="layout-picker-item__content">
                  <strong>{preset.label}</strong>
                  <span>{preset.description}</span>
                  {isActive ? (
                    <span className="layout-picker-item__badge">Current layout</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  isMacPlatform,
  themeMode,
  tabAlignment,
  projectSortMode,
  scrollbarMode,
  projectHotkeyModifier,
  tabHotkeyModifier,
  supportedHotkeyModifiers,
  onClose,
  onThemeChange,
  onTabAlignmentChange,
  onProjectSortModeChange,
  onScrollbarModeChange,
  onProjectHotkeyModifierChange,
  onTabHotkeyModifierChange,
}: SettingsModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>Settings</h3>
        <div className="theme-toggle">
          <button
            type="button"
            className={`ghost-button ${themeMode === "dark" ? "theme-toggle__active" : ""}`}
            onClick={() => onThemeChange("dark")}
          >
            Dark
          </button>
          <button
            type="button"
            className={`ghost-button ${themeMode === "light" ? "theme-toggle__active" : ""}`}
            onClick={() => onThemeChange("light")}
          >
            Light
          </button>
        </div>
        <div className="settings-group">
          <span className="settings-group__label">Tab alignment</span>
          <div className="theme-toggle">
            <button
              type="button"
              className={`ghost-button ${tabAlignment === "left" ? "theme-toggle__active" : ""}`}
              onClick={() => onTabAlignmentChange("left")}
            >
              Left
            </button>
            <button
              type="button"
              className={`ghost-button ${tabAlignment === "center" ? "theme-toggle__active" : ""}`}
              onClick={() => onTabAlignmentChange("center")}
            >
              Center
            </button>
            <button
              type="button"
              className={`ghost-button ${tabAlignment === "right" ? "theme-toggle__active" : ""}`}
              onClick={() => onTabAlignmentChange("right")}
            >
              Right
            </button>
          </div>
        </div>
        <div className="settings-group">
          <span className="settings-group__label">Project order</span>
          <div className="theme-toggle">
            <button
              type="button"
              className={`ghost-button ${projectSortMode === "created" ? "theme-toggle__active" : ""}`}
              onClick={() => onProjectSortModeChange("created")}
            >
              Created
            </button>
            <button
              type="button"
              className={`ghost-button ${projectSortMode === "alphabetical" ? "theme-toggle__active" : ""}`}
              onClick={() => onProjectSortModeChange("alphabetical")}
            >
              A-Z
            </button>
          </div>
        </div>
        <div className="settings-group">
          <span className="settings-group__label">Scrollbars</span>
          <div className="theme-toggle">
            <button
              type="button"
              className={`ghost-button ${scrollbarMode === "minimal" ? "theme-toggle__active" : ""}`}
              onClick={() => onScrollbarModeChange("minimal")}
            >
              Minimal
            </button>
            <button
              type="button"
              className={`ghost-button ${scrollbarMode === "aggressive" ? "theme-toggle__active" : ""}`}
              onClick={() => onScrollbarModeChange("aggressive")}
            >
              Auto-hide
            </button>
          </div>
        </div>
        <div className="settings-group settings-group--hotkeys">
          <span className="settings-group__label">Hotkeys</span>
          <p className="settings-note">
            Use 1-9 for the first nine projects or tabs. Use 0 for item 10. Shortcuts
            stay distinct so project and tab selection never collide. Hold Shift to
            pass a matching shortcut through to the active shell instead.
          </p>
        </div>
        <div className="settings-group">
          <span className="settings-group__label">Project switch modifier</span>
          <div className="theme-toggle">
            {supportedHotkeyModifiers.map((modifier) => (
              <button
                key={`project-${modifier}`}
                type="button"
                className={`ghost-button ${projectHotkeyModifier === modifier ? "theme-toggle__active" : ""}`}
                onClick={() => onProjectHotkeyModifierChange(modifier)}
              >
                {getModifierLabel(modifier, isMacPlatform)}
              </button>
            ))}
          </div>
          <p className="settings-note">
            {getIndexedShortcutLabel(projectHotkeyModifier, 1, isMacPlatform)} through{" "}
            {getIndexedShortcutLabel(projectHotkeyModifier, 10, isMacPlatform)} select
            projects in sidebar order.
          </p>
        </div>
        <div className="settings-group">
          <span className="settings-group__label">Tab switch modifier</span>
          <div className="theme-toggle">
            {supportedHotkeyModifiers.map((modifier) => (
              <button
                key={`tab-${modifier}`}
                type="button"
                className={`ghost-button ${tabHotkeyModifier === modifier ? "theme-toggle__active" : ""}`}
                onClick={() => onTabHotkeyModifierChange(modifier)}
              >
                {getModifierLabel(modifier, isMacPlatform)}
              </button>
            ))}
          </div>
          <p className="settings-note">
            {getIndexedShortcutLabel(tabHotkeyModifier, 1, isMacPlatform)} through{" "}
            {getIndexedShortcutLabel(tabHotkeyModifier, 10, isMacPlatform)} select tabs
            in titlebar order.
          </p>
        </div>
        <div className="modal__actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface TabContextMenuProps {
  x: number;
  y: number;
  onRename(): void;
  onClose(): void;
}

function TabContextMenu({ x, y, onRename, onClose }: TabContextMenuProps) {
  return (
    <div
      className="tab-context-menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="tab-context-menu__item"
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        Rename
      </button>
    </div>
  );
}

interface RenameTabModalProps {
  initialTitle: string;
  onClose(): void;
  onSubmit(title: string): Promise<void>;
}

function RenameTabModal({
  initialTitle,
  onClose,
  onSubmit,
}: RenameTabModalProps) {
  const [title, setTitle] = useState(initialTitle);

  return (
    <div className="modal-backdrop">
      <div className="modal modal--compact" onClick={(event) => event.stopPropagation()}>
        <h3>Rename tab</h3>
        <label>
          <span>Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Leave empty to use the automatic title"
          />
        </label>
        <div className="modal__actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onSubmit(title)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

interface ProjectBootstrapPanelProps {
  shellProfiles: ShellProfileAvailability[];
  onSubmit(input: CreateProjectInput): Promise<void>;
}

function ProjectBootstrapPanel({
  shellProfiles,
  onSubmit,
}: ProjectBootstrapPanelProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [defaultShellProfileId, setDefaultShellProfileId] = useState(
    shellProfiles.find((profile) => profile.available)?.id ?? "cmd",
  );

  return (
    <div className="bootstrap-panel">
      <label>
        <span>Project name</span>
        <input
          value={name}
          placeholder="My repo"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        <span>Default path</span>
        <DirectoryField
          value={rootPath}
          placeholder="Optional default working directory"
          onChange={setRootPath}
        />
      </label>
      <label>
        <span>Default shell</span>
        <select
          value={defaultShellProfileId}
          onChange={(event) => setDefaultShellProfileId(event.target.value)}
        >
          {shellProfiles.map((profile) => (
            <option key={profile.id} value={profile.id} disabled={!profile.available}>
              {profile.label}
              {profile.available ? "" : " (Unavailable)"}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="primary-button"
        onClick={() =>
          void onSubmit({
            name,
            rootPath,
            defaultShellProfileId,
          })
        }
      >
        Create first project
      </button>
    </div>
  );
}

interface DirectoryFieldProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}

function DirectoryField({ value, onChange, placeholder }: DirectoryFieldProps) {
  return (
    <div className="directory-field">
      <input value={value} placeholder={placeholder} readOnly />
      <button
        type="button"
        className="ghost-button"
        onClick={async () => {
          const selected = await window.termbag.pickDirectory(value);
          if (selected) {
            onChange(selected);
          }
        }}
      >
        Browse
      </button>
      {value ? (
        <button
          type="button"
          className="icon-button"
          aria-label="Clear directory"
          title="Clear directory"
          onClick={() => onChange("")}
        >
          x
        </button>
      ) : null}
    </div>
  );
}

interface ProjectModalProps {
  shellProfiles: ShellProfileAvailability[];
  initialProject: Project | null;
  onClose(): void;
  onSubmit(input: CreateProjectInput | UpdateProjectInput): Promise<void>;
}

function ProjectModal({
  shellProfiles,
  initialProject,
  onClose,
  onSubmit,
}: ProjectModalProps) {
  const [name, setName] = useState(initialProject?.name ?? "");
  const [rootPath, setRootPath] = useState(initialProject?.rootPath ?? "");
  const [defaultShellProfileId, setDefaultShellProfileId] = useState(
    initialProject?.defaultShellProfileId ??
      shellProfiles.find((profile) => profile.available)?.id ??
      "cmd",
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>{initialProject ? "Edit project" : "Create project"}</h3>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Default path</span>
          <DirectoryField value={rootPath} onChange={setRootPath} />
        </label>
        <label>
          <span>Default shell</span>
          <select
            value={defaultShellProfileId}
            onChange={(event) => setDefaultShellProfileId(event.target.value)}
          >
            {shellProfiles.map((profile) => (
              <option key={profile.id} value={profile.id} disabled={!profile.available}>
                {profile.label}
                {profile.available ? "" : " (Unavailable)"}
              </option>
            ))}
          </select>
        </label>
        <div className="modal__actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() =>
              void onSubmit(
                initialProject
                  ? {
                      id: initialProject.id,
                      name,
                      rootPath,
                      defaultShellProfileId,
                    }
                  : {
                      name,
                      rootPath,
                      defaultShellProfileId,
                    },
              )
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

interface HistoryOverlayProps {
  activeTabId: string;
  entries: Array<{
    id: string;
    tabId: string | null;
    cwd: string | null;
    commandText: string;
    createdAt: string;
  }>;
  isLoading: boolean;
  error: string | null;
  notice: string | null;
  onClose(): void;
  onSelect(commandText: string): Promise<void>;
}

function HistoryOverlay({
  activeTabId,
  entries,
  isLoading,
  error,
  notice,
  onClose,
  onSelect,
}: HistoryOverlayProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--history" onClick={(event) => event.stopPropagation()}>
        <div className="history-header">
          <div>
            <h3>Project history</h3>
            <p>Newest first. Native shell Up/Down history remains unchanged.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>

        {notice ? <div className="banner">{notice}</div> : null}
        {error ? <div className="banner banner--error">{error}</div> : null}

        <div className="history-list">
          {isLoading ? <p>Loading history...</p> : null}
          {!isLoading && entries.length === 0 ? (
            <p>No commands captured for this project yet.</p>
          ) : null}
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`history-entry ${entry.tabId === activeTabId ? "history-entry--same-tab" : ""}`}
              onClick={() => void onSelect(entry.commandText)}
            >
              <code>{entry.commandText}</code>
              <span>{entry.cwd ?? "cwd unavailable"}</span>
              <span>{new Date(entry.createdAt).toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
