import { describe, expect, it } from "vitest";
import { markPromptReady } from "../../shared/testable.js";
import type {
  HistoryEntry,
  Project,
  SavedTerminalSession,
  SavedWorkspaceTab,
  ShellProfile,
  TerminalSnapshot,
  TerminalEvent,
} from "../../shared/types.js";
import { PtyManager } from "./pty-manager.js";

class FakeDatabaseService {
  readonly historyEntries: HistoryEntry[] = [];
  snapshot: TerminalSnapshot | null = null;

  addHistoryEntry(params: Omit<HistoryEntry, "createdAt">): HistoryEntry {
    const entry: HistoryEntry = {
      ...params,
      createdAt: new Date().toISOString(),
    };
    this.historyEntries.push(entry);
    return entry;
  }

  updateSession(session: SavedTerminalSession): SavedTerminalSession {
    return session;
  }

  getSession(_sessionId: string): SavedTerminalSession | null {
    return null;
  }

  updateTab(tab: SavedWorkspaceTab): SavedWorkspaceTab {
    return tab;
  }

  getTab(_tabId: string): SavedWorkspaceTab | null {
    return null;
  }

  getSnapshot(_sessionId: string): TerminalSnapshot | null {
    return this.snapshot;
  }

  upsertSnapshot(params: {
    sessionId: string;
    snapshotFormat: string;
    transcriptText: string;
    serializedState: string;
    viewportOffsetFromBottom: number;
    byteCount: number;
  }): TerminalSnapshot {
    this.snapshot = {
      sessionId: params.sessionId,
      snapshotFormat: params.snapshotFormat as TerminalSnapshot["snapshotFormat"],
      transcriptText: params.transcriptText,
      serializedState: params.serializedState,
      viewportOffsetFromBottom: params.viewportOffsetFromBottom,
      byteCount: params.byteCount,
      updatedAt: new Date().toISOString(),
    };
    return this.snapshot;
  }
}

function createRuntimeHarness(options?: {
  shellProfileId?: string;
  supportsIntegration?: boolean;
  cwd?: string | null;
}) {
  const database = new FakeDatabaseService();
  const manager = new PtyManager(
    database as never,
    {} as never,
    (_event: TerminalEvent) => undefined,
  );
  const project: Project = {
    id: "project-1",
    name: "Repo",
    rootPath: "C:\\Work\\Repo",
    defaultShellProfileId: options?.shellProfileId ?? "pwsh",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const tab: SavedWorkspaceTab = {
    id: "tab-1",
    projectId: project.id,
    title: "Repo",
    customTitle: null,
    restoreOrder: 0,
    layout: {
      root: {
        id: "leaf-1",
        kind: "leaf",
        sessionId: "session-1",
      },
    },
    focusedSessionId: "session-1",
    wasOpen: true,
    lastActivatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const session: SavedTerminalSession = {
    id: "session-1",
    tabId: tab.id,
    shellProfileId: options?.shellProfileId ?? "pwsh",
    lastKnownCwd: options?.cwd ?? "C:\\Work\\Repo",
    borderColor: null,
    sessionOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const shellProfile: ShellProfile = {
    id: options?.shellProfileId ?? "pwsh",
    label: options?.shellProfileId ?? "pwsh",
    executable: `${options?.shellProfileId ?? "pwsh"}.exe`,
    argsJson: "[]",
    platform: "win32",
    supportsIntegration: options?.supportsIntegration ?? true,
    sortOrder: 0,
  };

  const runtime = (manager as any).createRuntime(
    project.id,
    tab,
    session,
    shellProfile,
    { cols: 80, rows: 24 },
  );
  runtime.status = "running";
  runtime.currentCwd = session.lastKnownCwd;
  runtime.pty = {
    write(_data: string): void {},
    resize(): void {},
    kill(): void {},
  };
  (manager as any).runtimes.set(session.id, runtime);

  return {
    database,
    manager,
    project,
    runtime,
    session,
    shellProfile,
    tab,
  };
}

function setPromptReady(runtime: {
  promptTrackingValid: boolean;
  currentInputBuffer: string;
  inputCursorIndex: number;
}): void {
  const promptReady = markPromptReady();
  runtime.promptTrackingValid = promptReady.promptTrackingValid;
  runtime.currentInputBuffer = promptReady.currentInputBuffer;
  runtime.inputCursorIndex = promptReady.inputCursorIndex;
}

function writeHeadless(runtime: { headless: { write(data: string, callback?: () => void): void } }, data: string) {
  return new Promise<void>((resolve) => {
    runtime.headless.write(data, resolve);
  });
}

describe("PtyManager command history capture", () => {
  it("records submitted commands immediately for integration shells without duplicating later integration signals", async () => {
    const { database, manager, runtime, session, shellProfile, tab } = createRuntimeHarness();

    setPromptReady(runtime);
    manager.writeToSession(session.id, "git status");
    manager.writeToSession(session.id, "\r");

    expect(database.historyEntries.map((entry) => entry.commandText)).toEqual(["git status"]);
    expect(database.historyEntries[0]?.source).toBe("input_capture");

    await (manager as any).handleData(
      tab,
      session,
      shellProfile,
      runtime,
      "\u001b]633;TermBagCommand=git%20status\u0007",
    );

    expect(database.historyEntries.map((entry) => entry.commandText)).toEqual(["git status"]);
  });

  it("records repeated identical submissions as separate history entries", () => {
    const { database, manager, runtime, session } = createRuntimeHarness();

    setPromptReady(runtime);
    manager.writeToSession(session.id, "npm test");
    manager.writeToSession(session.id, "\r");

    setPromptReady(runtime);
    manager.writeToSession(session.id, "npm test");
    manager.writeToSession(session.id, "\r");

    expect(database.historyEntries).toHaveLength(2);
    expect(database.historyEntries.map((entry) => entry.commandText)).toEqual([
      "npm test",
      "npm test",
    ]);
  });

  it("does not record submissions while alternate-screen mode is active", () => {
    const { database, manager, runtime, session } = createRuntimeHarness();

    setPromptReady(runtime);
    runtime.currentInputBuffer = "git status";
    runtime.inputCursorIndex = runtime.currentInputBuffer.length;
    runtime.alternateScreenActive = true;

    manager.writeToSession(session.id, "\r");

    expect(database.historyEntries).toHaveLength(0);
  });

  it("falls back to PowerShell integration when submit tracking is already unsafe", async () => {
    const { database, manager, runtime, session, shellProfile, tab } = createRuntimeHarness();

    runtime.promptTrackingValid = false;
    runtime.currentInputBuffer = "";
    runtime.inputCursorIndex = 0;

    manager.writeToSession(session.id, "\r");
    expect(database.historyEntries).toHaveLength(0);

    await (manager as any).handleData(
      tab,
      session,
      shellProfile,
      runtime,
      "\u001b]633;TermBagCommand=Get-ChildItem\u0007",
    );

    expect(database.historyEntries.map((entry) => entry.commandText)).toEqual(["Get-ChildItem"]);
    expect(database.historyEntries[0]?.source).toBe("integration");
  });

  it("captures the visible PowerShell prompt line when shell history changed the input", async () => {
    const { database, manager, runtime, session } = createRuntimeHarness({
      shellProfileId: "pwsh",
      supportsIntegration: true,
      cwd: "C:\\Work\\Repo",
    });

    runtime.promptTrackingValid = false;
    runtime.currentInputBuffer = "";
    runtime.inputCursorIndex = 0;
    runtime.lastRenderedPromptPrefix = "PS C:\\Work\\Repo> ";
    await writeHeadless(runtime, "PS C:\\Work\\Repo> Get-ChildItem");

    manager.writeToSession(session.id, "\r");

    expect(database.historyEntries.map((entry) => entry.commandText)).toEqual([
      "Get-ChildItem",
    ]);
    expect(database.historyEntries[0]?.source).toBe("input_capture");
  });

  it("captures the visible cmd prompt line when shell history changed the input", async () => {
    const { database, manager, runtime, session } = createRuntimeHarness({
      shellProfileId: "cmd",
      supportsIntegration: false,
      cwd: "C:\\Work\\Repo",
    });

    runtime.promptTrackingValid = false;
    runtime.currentInputBuffer = "";
    runtime.inputCursorIndex = 0;
    await writeHeadless(runtime, "C:\\Work\\Repo>echo from history");

    manager.writeToSession(session.id, "\r");

    expect(database.historyEntries.map((entry) => entry.commandText)).toEqual([
      "echo from history",
    ]);
    expect(runtime.currentCwd).toBe("C:\\Work\\Repo");
  });
});

describe("PtyManager snapshot restore", () => {
  it("persists serialized terminal state alongside the plain transcript", async () => {
    const { database, manager, runtime } = createRuntimeHarness();

    await writeHeadless(runtime, "\u001b[31mred\u001b[0m\r\nprompt>");

    (manager as any).persistSnapshotNow(runtime);

    expect(database.snapshot?.transcriptText).toBe("red\r\nprompt>\r\n");
    expect(database.snapshot?.serializedState).toContain("\u001b[31m");
    expect(database.snapshot?.viewportOffsetFromBottom).toBe(0);
    expect(database.snapshot?.byteCount).toBeGreaterThan(database.snapshot?.transcriptText.length ?? 0);
  });

  it("hydrates the headless terminal from persisted serialized state", async () => {
    const { manager, runtime } = createRuntimeHarness();
    const snapshot: TerminalSnapshot = {
      sessionId: runtime.sessionId,
      snapshotFormat: "plain-transcript-v1",
      transcriptText: "red\r\nprompt>\r\n",
      serializedState: "\u001b[31mred\u001b[0m\r\nprompt>",
      viewportOffsetFromBottom: 0,
      byteCount: 24,
      updatedAt: new Date().toISOString(),
    };

    await (manager as any).restoreRuntimeSnapshot(runtime, snapshot);
    const replay = await (manager as any).captureReplayState(runtime);

    expect(replay.serializedState).toContain("\u001b[31m");
    expect(replay.viewportOffsetFromBottom).toBe(0);
    expect(runtime.pendingBootstrapReplayText).toBe("");
  });
});
