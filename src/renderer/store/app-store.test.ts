import { afterEach, describe, expect, it } from "vitest";
import { createSingleLeafLayout } from "../../shared/layout.js";
import { useAppStore } from "./app-store";

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState({
    ...initialState,
    bootstrapped: false,
    loading: false,
    error: null,
    projects: [],
    shellProfiles: [],
    templates: [],
    selectedProjectId: null,
    workspaces: {},
    sessionRuntimes: {},
    historyEntries: [],
    historyLoading: false,
    historyError: null,
  });
});

describe("useAppStore", () => {
  it("stores runtime events separately from the workspace tree", () => {
    useAppStore.setState({
      bootstrapped: true,
      loading: false,
      error: null,
      projects: [
        {
          id: "project-1",
          name: "Repo",
          rootPath: "C:\\Work\\Repo",
          defaultShellProfileId: "pwsh",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        },
      ],
      shellProfiles: [],
      templates: [],
      selectedProjectId: "project-1",
      workspaces: {
        "project-1": {
          project: {
            id: "project-1",
            name: "Repo",
            rootPath: "C:\\Work\\Repo",
            defaultShellProfileId: "pwsh",
            createdAt: "2026-03-01T12:00:00.000Z",
            updatedAt: "2026-03-01T12:00:00.000Z",
          },
          selectedTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              projectId: "project-1",
              title: "Repo",
              customTitle: null,
              restoreOrder: 1,
              layout: createSingleLeafLayout("session-1", "session-1:root"),
              focusedSessionId: "session-1",
              wasOpen: true,
              lastActivatedAt: "2026-03-01T12:00:00.000Z",
              createdAt: "2026-03-01T12:00:00.000Z",
              updatedAt: "2026-03-01T12:00:00.000Z",
              rootPathMissing: false,
              sessions: [
                {
                  id: "session-1",
                  tabId: "tab-1",
                  shellProfileId: "pwsh",
                  lastKnownCwd: "C:\\Work\\Repo",
                  sessionOrder: 1,
                  createdAt: "2026-03-01T12:00:00.000Z",
                  updatedAt: "2026-03-01T12:00:00.000Z",
                  runtime: null,
                },
                {
                  id: "session-2",
                  tabId: "tab-1",
                  shellProfileId: "pwsh",
                  lastKnownCwd: "C:\\Work\\Repo\\src",
                  sessionOrder: 2,
                  createdAt: "2026-03-01T12:00:00.000Z",
                  updatedAt: "2026-03-01T12:00:00.000Z",
                  runtime: null,
                },
              ],
            },
          ],
        },
      },
      historyEntries: [],
      historyLoading: false,
      historyError: null,
    });

    useAppStore.getState().applyTerminalEvent({
      type: "status",
      sessionId: "session-2",
      tabId: "tab-1",
      runtime: {
        sessionId: "session-2",
        tabId: "tab-1",
        projectId: "project-1",
        started: true,
        status: "running",
        pid: 123,
        exitCode: null,
        errorMessage: null,
        promptTrackingValid: true,
        currentInputBuffer: "",
        alternateScreenActive: false,
        sessionOutputByteCount: 512,
        currentCwd: "C:\\Work\\Repo\\src",
        shellProfileId: "pwsh",
      },
    });

    const updatedWorkspace = useAppStore.getState().workspaces["project-1"];
    const updatedRuntime = useAppStore.getState().sessionRuntimes["session-2"];
    const updatedSession = updatedWorkspace?.tabs[0]?.sessions.find(
      (session) => session.id === "session-2",
    );

    expect(updatedRuntime?.status).toBe("running");
    expect(updatedRuntime?.pid).toBe(123);
    expect(updatedWorkspace?.tabs[0]?.sessions[0]?.runtime).toBeNull();
    expect(updatedSession?.runtime).toBeNull();
  });
});
