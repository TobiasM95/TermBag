import { useEffect, useMemo, useState } from "react";
import { TerminalPane } from "./components/TerminalPane";
import { useAppStore } from "./store/app-store";
import type {
  CreateProjectInput,
  Project,
  ShellProfileAvailability,
  UpdateProjectInput,
  WorkspaceTab,
} from "../shared/types";

type ModalState =
  | { mode: "create" }
  | { mode: "edit"; project: Project }
  | null;

export function App() {
  const hasPreloadApi =
    typeof window !== "undefined" && typeof window.termbag !== "undefined";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    closeTab,
    loadHistory,
    applyTerminalEvent,
  } = useAppStore();

  const [modalState, setModalState] = useState<ModalState>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recallNotice, setRecallNotice] = useState<string | null>(null);

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

  const selectedWorkspace = selectedProjectId ? workspaces[selectedProjectId] : undefined;
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? selectedWorkspace?.project;

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

  useEffect(() => {
    if (
      selectedWorkspace &&
      !selectedWorkspace.selectedTabId &&
      selectedWorkspace.tabs.length > 0
    ) {
      setSelectedTab(selectedWorkspace.project.id, selectedWorkspace.tabs[0]!.id);
    }
  }, [selectedWorkspace, setSelectedTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "r") {
        return;
      }

      if (!selectedProjectId || !activeTab) {
        return;
      }

      event.preventDefault();
      setHistoryOpen(true);
      setRecallNotice(null);
      void loadHistory(selectedProjectId);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, loadHistory, selectedProjectId]);

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

          {projects.map((project) => {
            const isActive = project.id === selectedProjectId;
            return (
              <button
                key={project.id}
                type="button"
                className={`project-card ${isActive ? "project-card--active" : ""} ${sidebarCollapsed ? "project-card--collapsed" : ""}`}
                onClick={() => selectProject(project.id)}
                title={sidebarCollapsed ? project.name : undefined}
              >
                {sidebarCollapsed ? (
                  <span className="project-card__mono">
                    {project.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                ) : (
                  <>
                    <span className="project-card__name">{project.name}</span>
                    <span className="project-card__path">
                      {project.rootPath ? `Default path: ${project.rootPath}` : "No default path"}
                    </span>
                    <span className="project-card__meta">
                      {shellProfiles.find((profile) => profile.id === project.shellProfileId)?.label ??
                        project.shellProfileId}
                    </span>
                    <span className="project-card__actions">
                      <span
                        className="link-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setModalState({ mode: "edit", project });
                        }}
                      >
                        Edit
                      </span>
                      <span
                        className="link-button danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(`Delete project "${project.name}"?`)) {
                            void deleteProject(project.id);
                          }
                        }}
                      >
                        Delete
                      </span>
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="workspace">
        {error ? <div className="banner banner--error">{error}</div> : null}

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
          <>
            <header className="workspace__header">
              <div>
                <h2>{selectedProject.name}</h2>
                <p className="workspace__subtext">
                  {selectedProject.rootPath
                    ? `Default path for new tabs: ${selectedProject.rootPath}`
                    : "No default path configured for new tabs"}
                </p>
              </div>
              <div className="workspace__header-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setModalState({ mode: "edit", project: selectedProject })}
                >
                  Edit project
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void createTab({ projectId: selectedProject.id })}
                >
                  New tab
                </button>
              </div>
            </header>

            <div className="tab-strip">
              {selectedWorkspace.tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`tab-chip ${activeTab?.id === tab.id ? "tab-chip--active" : ""}`}
                  onClick={() => setSelectedTab(selectedWorkspace.project.id, tab.id)}
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
              ))}
            </div>

            {activeTab ? <TerminalPane project={selectedProject} tab={activeTab} /> : null}
          </>
        ) : null}
      </main>

      {modalState ? (
        <ProjectModal
          shellProfiles={shellProfiles}
          initialProject={modalState.mode === "edit" ? modalState.project : null}
          onClose={() => setModalState(null)}
          onSubmit={handleProjectSubmit}
        />
      ) : null}

      {historyOpen && selectedProject && activeTab ? (
        <HistoryOverlay
          activeTabId={activeTab.id}
          entries={historyEntries}
          isLoading={historyLoading}
          error={historyError}
          notice={recallNotice}
          onClose={() => setHistoryOpen(false)}
          onSelect={async (commandText) => {
            const result = await window.termbag.recallHistory({
              tabId: activeTab.id,
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
  const [shellProfileId, setShellProfileId] = useState(
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
        <span>Shell profile</span>
        <select
          value={shellProfileId}
          onChange={(event) => setShellProfileId(event.target.value)}
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
            shellProfileId,
          })
        }
      >
        Create first project
      </button>
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
  const [shellProfileId, setShellProfileId] = useState(
    initialProject?.shellProfileId ??
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
          <span>Shell profile</span>
          <select
            value={shellProfileId}
            onChange={(event) => setShellProfileId(event.target.value)}
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
                      shellProfileId,
                    }
                  : {
                      name,
                      rootPath,
                      shellProfileId,
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
