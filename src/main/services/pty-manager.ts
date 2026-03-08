import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import xtermHeadlessPackage from "@xterm/headless";
import xtermSerializePackage from "@xterm/addon-serialize";
import { spawn, type IPty } from "node-pty";
import {
  buildTerminalTranscript,
  countSnapshotBytes,
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCROLLBACK,
} from "../../shared/snapshot.js";
import { isSameTerminalSize } from "../../shared/terminal-size.js";
import {
  applyInputToTrackingState,
  inferCmdCwdFromSubmittedCommand,
  inferCmdPromptCwdFromOutput,
  INITIAL_INPUT_TRACKING_STATE,
  markPromptReady,
  parseIntegrationChunk,
  stripInitialTerminalNoise,
} from "../../shared/testable.js";
import { deriveTabTitle } from "../../shared/paths.js";
import type {
  ActivateSessionInput,
  Project,
  RecallHistoryResult,
  SavedTerminalSession,
  SavedWorkspaceTab,
  SessionRuntimeSummary,
  ShellProfile,
  TerminalEvent,
} from "../../shared/types.js";
import { DatabaseService } from "./database.js";
import { ShellCatalog } from "./shell-catalog.js";
import {
  cleanupBootstrapAssets,
  cleanupStaleBootstrapFiles,
  createShellBootstrapAssets,
} from "./shell-bootstrap.js";

const { Terminal: HeadlessTerminal } = xtermHeadlessPackage;
const { SerializeAddon } = xtermSerializePackage;

interface RuntimeSession {
  sessionId: string;
  tabId: string;
  projectId: string;
  shellProfileId: string;
  pty: IPty | null;
  headless: InstanceType<typeof HeadlessTerminal>;
  serializer: InstanceType<typeof SerializeAddon>;
  status: SessionRuntimeSummary["status"];
  pid: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  promptTrackingValid: boolean;
  currentInputBuffer: string;
  alternateScreenActive: boolean;
  suppressInitialRenderNoise: boolean;
  currentCwd: string | null;
  flushTimer: NodeJS.Timeout | null;
  supportsIntegration: boolean;
  operationQueue: Promise<void>;
  outputSequence: number;
  lastCommittedSequence: number;
  snapshotDirty: boolean;
  lastSerializedByteCount: number;
  bootstrapCleanupPaths: string[];
  disposed: boolean;
}

type TerminalWriter = {
  write(data: string, callback?: () => void): void;
};

const SNAPSHOT_DEBOUNCE_MS = 500;

function writeTerminalData(terminal: TerminalWriter, data: string): Promise<void> {
  if (!data) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function serializeTerminal(runtime: RuntimeSession): string {
  const serializedState = runtime.serializer.serialize({
    excludeAltBuffer: true,
    scrollback: SNAPSHOT_SCROLLBACK,
  });
  runtime.lastSerializedByteCount = countSnapshotBytes(serializedState);
  return serializedState;
}

export class PtyManager {
  private readonly runtimes = new Map<string, RuntimeSession>();

  constructor(
    private readonly database: DatabaseService,
    private readonly shellCatalog: ShellCatalog,
    private readonly onTerminalEvent: (event: TerminalEvent) => void,
  ) {
    cleanupStaleBootstrapFiles();
  }

  getRuntimeSummary(sessionId: string): SessionRuntimeSummary | null {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? this.toRuntimeSummary(runtime) : null;
  }

  async activateSession(
    input: ActivateSessionInput,
    project: Project,
    tab: SavedWorkspaceTab,
    session: SavedTerminalSession,
    shellProfile: ShellProfile,
  ): Promise<{
    runtime: SessionRuntimeSummary;
    serializedState: string;
    replayRevision: number;
  }> {
    const existing = this.runtimes.get(session.id);
    if (existing) {
      this.resizeRuntime(existing, input.cols, input.rows);
      const replay = await this.captureReplayState(existing);
      return {
        runtime: this.toRuntimeSummary(existing),
        serializedState: replay.serializedState,
        replayRevision: replay.replayRevision,
      };
    }

    const desiredCwd = this.resolveSpawnCwd(project, session);
    const persistedSnapshot = this.database.getSnapshot(session.id);
    const bootstrapAssets =
      persistedSnapshot?.snapshotFormat === SNAPSHOT_FORMAT &&
      persistedSnapshot.transcriptText
        ? createShellBootstrapAssets(shellProfile, persistedSnapshot.transcriptText)
        : null;
    const runtime = this.createRuntime(
      project.id,
      tab,
      session,
      shellProfile,
      { cols: input.cols, rows: input.rows },
      {
        currentCwd: desiredCwd,
        supportsIntegration: shellProfile.supportsIntegration,
        suppressInitialRenderNoise: Boolean(persistedSnapshot?.transcriptText),
        bootstrapCleanupPaths: bootstrapAssets?.cleanupPaths ?? [],
      },
    );
    this.runtimes.set(session.id, runtime);

    try {
      const launch = this.shellCatalog.resolveLaunch(shellProfile, bootstrapAssets?.scriptPath);
      const pty = spawn(launch.executable, launch.args, {
        cols: input.cols,
        rows: input.rows,
        cwd: desiredCwd,
        name: "xterm-color",
        useConpty: true,
        env: process.env,
      });

      runtime.pty = pty;
      runtime.pid = pty.pid;
      runtime.status = "running";
      runtime.errorMessage = null;
      runtime.supportsIntegration = launch.supportsIntegration;

      if (!launch.supportsIntegration && shellProfile.id === "cmd") {
        const promptReady = markPromptReady();
        runtime.promptTrackingValid = promptReady.promptTrackingValid;
        runtime.currentInputBuffer = promptReady.currentInputBuffer;
      }

      pty.onData((chunk) => {
        void this.handleData(tab, session, shellProfile, runtime, chunk);
      });
      pty.onExit(({ exitCode }) => {
        if (!this.runtimes.has(runtime.sessionId)) {
          return;
        }

        runtime.status = "exited";
        runtime.exitCode = exitCode;
        runtime.pid = null;
        runtime.pty = null;
        runtime.promptTrackingValid = false;
        runtime.currentInputBuffer = "";
        runtime.snapshotDirty = true;
        void this.flushSnapshot(runtime);
        this.emitStatus(runtime);
      });

      this.emitStatus(runtime);
    } catch (error) {
      cleanupBootstrapAssets(runtime.bootstrapCleanupPaths);
      runtime.bootstrapCleanupPaths = [];
      runtime.status = "error";
      runtime.errorMessage =
        error instanceof Error ? error.message : "Unknown PTY spawn error";
      this.emitStatus(runtime);
    }

    const replay = await this.captureReplayState(runtime);
    return {
      runtime: this.toRuntimeSummary(runtime),
      serializedState: replay.serializedState,
      replayRevision: replay.replayRevision,
    };
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    this.resizeRuntime(runtime, cols, rows);
  }

  writeToSession(sessionId: string, data: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.pty || runtime.status !== "running") {
      return;
    }

    const priorBuffer = runtime.currentInputBuffer;
    const priorValidity = runtime.promptTrackingValid;
    runtime.pty.write(data);

    const nextState = applyInputToTrackingState(
      {
        promptTrackingValid: runtime.promptTrackingValid,
        currentInputBuffer: runtime.currentInputBuffer,
      },
      data,
    );
    runtime.promptTrackingValid = nextState.promptTrackingValid;
    runtime.currentInputBuffer = nextState.currentInputBuffer;

    if (data === "\r" && priorValidity && !runtime.alternateScreenActive) {
      const commandText = priorBuffer.trim();
      if (commandText) {
        this.database.addHistoryEntry({
          id: crypto.randomUUID(),
          projectId: runtime.projectId,
          tabId: runtime.tabId,
          sessionId,
          shellProfileId: runtime.shellProfileId,
          cwd: runtime.currentCwd,
          commandText: priorBuffer,
          source: runtime.supportsIntegration ? "integration" : "input_capture",
        });
      }

      if (runtime.shellProfileId === "cmd") {
        runtime.currentCwd = inferCmdCwdFromSubmittedCommand(runtime.currentCwd, priorBuffer);
      }
    }

    this.emitStatus(runtime);
  }

  recallHistory(sessionId: string, commandText: string): RecallHistoryResult {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.pty || runtime.status !== "running") {
      return {
        applied: false,
        reason: "The shell is not running.",
      };
    }

    if (runtime.alternateScreenActive) {
      return {
        applied: false,
        reason: "History insertion is disabled in alternate-screen mode.",
      };
    }

    if (!runtime.promptTrackingValid) {
      return {
        applied: false,
        reason: "Prompt tracking is not currently safe for insertion.",
      };
    }

    if (runtime.currentInputBuffer.length > 0) {
      runtime.pty.write("\u007f".repeat(runtime.currentInputBuffer.length));
    }

    runtime.pty.write(commandText);
    runtime.currentInputBuffer = commandText;
    this.emitStatus(runtime);

    return {
      applied: true,
      reason: null,
    };
  }

  async restartSession(
    input: ActivateSessionInput,
    project: Project,
    tab: SavedWorkspaceTab,
    session: SavedTerminalSession,
    shellProfile: ShellProfile,
  ): Promise<{
    runtime: SessionRuntimeSummary;
    serializedState: string;
    replayRevision: number;
  }> {
    await this.disposeRuntime(session.id, false);
    return this.activateSession(input, project, tab, session, shellProfile);
  }

  async closeTab(tabId: string): Promise<void> {
    const matchingSessionIds = [...this.runtimes.values()]
      .filter((runtime) => runtime.tabId === tabId)
      .map((runtime) => runtime.sessionId);
    await Promise.all(matchingSessionIds.map((sessionId) => this.disposeRuntime(sessionId, true)));
  }

  async shutdown(): Promise<void> {
    for (const sessionId of [...this.runtimes.keys()]) {
      await this.disposeRuntime(sessionId, true);
    }
  }

  async persistSnapshots(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        if (runtime.flushTimer) {
          clearTimeout(runtime.flushTimer);
          runtime.flushTimer = null;
        }
        await this.flushSnapshot(runtime);
      }),
    );
  }

  private createRuntime(
    projectId: string,
    tab: SavedWorkspaceTab,
    session: SavedTerminalSession,
    shellProfile: ShellProfile,
    dimensions: { cols: number; rows: number },
    overrides?: Partial<RuntimeSession>,
  ): RuntimeSession {
    const headless = new HeadlessTerminal({
      allowProposedApi: true,
      cols: dimensions.cols,
      rows: dimensions.rows,
      scrollback: SNAPSHOT_SCROLLBACK,
      convertEol: false,
    });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);

    return {
      sessionId: session.id,
      tabId: tab.id,
      projectId,
      shellProfileId: session.shellProfileId,
      pty: null,
      headless,
      serializer,
      status: "not_started",
      pid: null,
      exitCode: null,
      errorMessage: null,
      promptTrackingValid: INITIAL_INPUT_TRACKING_STATE.promptTrackingValid,
      currentInputBuffer: INITIAL_INPUT_TRACKING_STATE.currentInputBuffer,
      alternateScreenActive: false,
      suppressInitialRenderNoise: true,
      currentCwd: session.lastKnownCwd,
      flushTimer: null,
      supportsIntegration: shellProfile.supportsIntegration,
      operationQueue: Promise.resolve(),
      outputSequence: 0,
      lastCommittedSequence: 0,
      snapshotDirty: false,
      lastSerializedByteCount: 0,
      bootstrapCleanupPaths: [],
      disposed: false,
      ...overrides,
    };
  }

  private async handleData(
    tab: SavedWorkspaceTab,
    session: SavedTerminalSession,
    shellProfile: ShellProfile,
    runtime: RuntimeSession,
    chunk: string,
  ): Promise<void> {
    if (!this.runtimes.has(runtime.sessionId)) {
      return;
    }

    const parsed = parseIntegrationChunk(chunk);
    const displayData = runtime.suppressInitialRenderNoise
      ? stripInitialTerminalNoise(parsed.sanitized)
      : parsed.sanitized;

    if (parsed.enteredAlternateScreen) {
      runtime.alternateScreenActive = true;
      runtime.promptTrackingValid = false;
      runtime.currentInputBuffer = "";
    }
    if (parsed.exitedAlternateScreen) {
      runtime.alternateScreenActive = false;
      runtime.snapshotDirty = true;
      this.scheduleSnapshotFlush(runtime);
    }

    for (const cwd of parsed.cwdSignals) {
      runtime.currentCwd = cwd;
      this.persistCwdAndTitle(tab, session, shellProfile, cwd);
    }

    if (shellProfile.id === "cmd") {
      const inferred = inferCmdPromptCwdFromOutput(runtime.currentCwd, displayData);
      if (inferred && inferred !== runtime.currentCwd) {
        runtime.currentCwd = inferred;
        this.persistCwdAndTitle(tab, session, shellProfile, inferred);
      }
    }

    if (parsed.promptSignals.length > 0) {
      const promptReady = markPromptReady();
      runtime.promptTrackingValid = promptReady.promptTrackingValid;
      runtime.currentInputBuffer = promptReady.currentInputBuffer;
    } else if (shellProfile.id === "cmd" && /[A-Za-z]:\\.*>\s*$/.test(displayData.trimEnd())) {
      const promptReady = markPromptReady();
      runtime.promptTrackingValid = promptReady.promptTrackingValid;
      runtime.currentInputBuffer = promptReady.currentInputBuffer;
    }

    if (
      runtime.suppressInitialRenderNoise &&
      (parsed.promptSignals.length > 0 || parsed.cwdSignals.length > 0 || /\S/.test(displayData))
    ) {
      runtime.suppressInitialRenderNoise = false;
    }

    if (displayData) {
      const sequence = runtime.outputSequence + 1;
      runtime.outputSequence = sequence;
      void this.enqueueRuntimeTask(runtime, async () => {
        if (runtime.disposed) {
          return;
        }

        await writeTerminalData(runtime.headless, displayData);
        runtime.lastCommittedSequence = sequence;
        runtime.snapshotDirty = true;
        this.scheduleSnapshotFlush(runtime);
      });

      this.onTerminalEvent({
        type: "output",
        sessionId: runtime.sessionId,
        tabId: runtime.tabId,
        data: displayData,
        sequence,
      });
    }

    this.emitStatus(runtime);
  }

  private persistCwdAndTitle(
    tab: SavedWorkspaceTab,
    session: SavedTerminalSession,
    shellProfile: ShellProfile,
    cwd: string,
  ): void {
    const latestSession = this.database.getSession(session.id);
    if (!latestSession) {
      return;
    }

    const updatedSession = this.database.updateSession({
      ...latestSession,
      lastKnownCwd: cwd,
    });
    session.lastKnownCwd = updatedSession.lastKnownCwd;

    const latestTab = this.database.getTab(tab.id);
    if (!latestTab || latestTab.customTitle || latestTab.focusedSessionId !== session.id) {
      return;
    }

    const updatedTab = this.database.updateTab({
      ...latestTab,
      title: deriveTabTitle(cwd, shellProfile.label),
    });
    tab.title = updatedTab.title;
    tab.customTitle = updatedTab.customTitle;
    tab.focusedSessionId = updatedTab.focusedSessionId;
  }

  private scheduleSnapshotFlush(runtime: RuntimeSession): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
    }

    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      void this.flushSnapshot(runtime);
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private async flushSnapshot(runtime: RuntimeSession): Promise<void> {
    if (!runtime.snapshotDirty) {
      return;
    }

    await this.enqueueRuntimeTask(runtime, () => {
      if (!runtime.snapshotDirty || runtime.alternateScreenActive || runtime.disposed) {
        return;
      }

      this.persistSnapshotNow(runtime);
    });
  }

  private persistSnapshotNow(runtime: RuntimeSession): void {
    if (runtime.alternateScreenActive || runtime.disposed) {
      return;
    }

    const transcriptText = buildTerminalTranscript(runtime.headless.buffer.normal);
    runtime.lastSerializedByteCount = countSnapshotBytes(transcriptText);
    runtime.snapshotDirty = false;
    this.database.upsertSnapshot({
      sessionId: runtime.sessionId,
      snapshotFormat: SNAPSHOT_FORMAT,
      transcriptText,
      byteCount: runtime.lastSerializedByteCount,
    });
  }

  private async captureReplayState(runtime: RuntimeSession): Promise<{
    serializedState: string;
    replayRevision: number;
  }> {
    return this.enqueueRuntimeTask(runtime, () => ({
      serializedState: serializeTerminal(runtime),
      replayRevision: runtime.lastCommittedSequence,
    }));
  }

  private resizeRuntime(runtime: RuntimeSession, cols: number, rows: number): void {
    if (isSameTerminalSize({ cols: runtime.headless.cols, rows: runtime.headless.rows }, { cols, rows })) {
      return;
    }

    if (runtime.pty && runtime.status === "running") {
      runtime.pty.resize(cols, rows);
    }

    void this.enqueueRuntimeTask(runtime, () => {
      if (runtime.disposed) {
        return;
      }

      runtime.headless.resize(cols, rows);
      runtime.snapshotDirty = true;
      this.scheduleSnapshotFlush(runtime);
    });
  }

  private enqueueRuntimeTask<T>(runtime: RuntimeSession, task: () => Promise<T> | T): Promise<T> {
    const nextTask = runtime.operationQueue.then(
      () => (runtime.disposed ? (undefined as T) : task()),
      () => (runtime.disposed ? (undefined as T) : task()),
    );
    runtime.operationQueue = nextTask.then(
      () => undefined,
      () => undefined,
    );
    return nextTask;
  }

  private async disposeRuntime(sessionId: string, persistSnapshot: boolean): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }

    if (persistSnapshot) {
      await this.flushSnapshot(runtime);
    }

    runtime.disposed = true;
    if (runtime.pty) {
      try {
        await this.terminateRuntimePty(runtime);
      } catch {
        // Best effort only.
      }
    }

    runtime.headless.dispose();
    cleanupBootstrapAssets(runtime.bootstrapCleanupPaths);
    this.runtimes.delete(sessionId);
  }

  private async terminateRuntimePty(runtime: RuntimeSession): Promise<void> {
    const pty = runtime.pty;
    if (!pty) {
      return;
    }

    if (process.platform === "win32" && runtime.pid) {
      await this.killWindowsProcessTree(runtime.pid);
      return;
    }

    pty.kill();
  }

  private async killWindowsProcessTree(pid: number): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
        },
        () => {
          resolve();
        },
      );
    });
  }

  private emitStatus(runtime: RuntimeSession): void {
    this.onTerminalEvent({
      type: "status",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      runtime: this.toRuntimeSummary(runtime),
    });
  }

  private toRuntimeSummary(runtime: RuntimeSession): SessionRuntimeSummary {
    return {
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      projectId: runtime.projectId,
      started: runtime.status !== "not_started",
      status: runtime.status,
      pid: runtime.pid,
      exitCode: runtime.exitCode,
      errorMessage: runtime.errorMessage,
      promptTrackingValid: runtime.promptTrackingValid,
      currentInputBuffer: runtime.currentInputBuffer,
      alternateScreenActive: runtime.alternateScreenActive,
      sessionOutputByteCount: runtime.lastSerializedByteCount,
      currentCwd: runtime.currentCwd,
      shellProfileId: runtime.shellProfileId,
    };
  }

  private resolveSpawnCwd(project: Project, session: SavedTerminalSession): string {
    if (session.lastKnownCwd && fs.existsSync(session.lastKnownCwd)) {
      return session.lastKnownCwd;
    }

    const projectRoot = project.rootPath.trim();
    if (projectRoot && fs.existsSync(projectRoot)) {
      return projectRoot;
    }

    const homeDir = os.homedir();
    if (homeDir && fs.existsSync(homeDir)) {
      return homeDir;
    }

    return process.cwd();
  }
}
