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
import { createTerminalPerformanceMeter } from "../../shared/terminal-performance.js";
import { isSameTerminalSize } from "../../shared/terminal-size.js";
import {
  applyInputToTrackingState,
  consumeBootstrapReplayPrefix,
  inferCmdCwdFromSubmittedCommand,
  inferCmdPromptCwdFromOutput,
  INITIAL_INPUT_TRACKING_STATE,
  markPromptReady,
  parseIntegrationChunk,
  stripInitialTerminalNoise,
} from "../../shared/testable.js";
import { buildTerminalEnvironment } from "../../shared/terminal-config.js";
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
  inputCursorIndex: number;
  pendingIntegrationHistoryCapture: boolean;
  lastRenderedPromptPrefix: string | null;
  pendingBootstrapReplayText: string;
  suppressBootstrapOutputUntilPrompt: boolean;
  alternateScreenActive: boolean;
  suppressInitialRenderNoise: boolean;
  currentCwd: string | null;
  flushTimer: NodeJS.Timeout | null;
  outputFlushTimer: NodeJS.Timeout | null;
  supportsIntegration: boolean;
  operationQueue: Promise<void>;
  outputSequence: number;
  lastCommittedSequence: number;
  pendingOutputData: string;
  pendingOutputSequence: number;
  snapshotDirty: boolean;
  lastSerializedByteCount: number;
  lastEmittedStatusDigest: string | null;
  bootstrapCleanupPaths: string[];
  disposed: boolean;
}

type TerminalWriter = {
  write(data: string, callback?: () => void): void;
};

const OUTPUT_BATCH_INTERVAL_MS = 12;
const OUTPUT_BATCH_MAX_BYTES = 16 * 1024;
const SNAPSHOT_DEBOUNCE_MS = 4000;
const terminalPerfEnabled =
  process.env.NODE_ENV !== "production" && process.env.TERMBAG_DEBUG_PERF === "1";
const ptyReceivePerformance = createTerminalPerformanceMeter(
  "main:pty-receive",
  terminalPerfEnabled,
);
const outputFlushPerformance = createTerminalPerformanceMeter(
  "main:output-flush",
  terminalPerfEnabled,
);
const snapshotFlushPerformance = createTerminalPerformanceMeter(
  "main:snapshot-flush",
  terminalPerfEnabled,
);

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
    viewportOffsetFromBottom: number;
    replayRevision: number;
  }> {
    const existing = this.runtimes.get(session.id);
    if (existing) {
      this.resizeRuntime(existing, input.cols, input.rows);
      const replay = await this.captureReplayState(existing);
      return {
        runtime: this.toRuntimeSummary(existing),
        serializedState: replay.serializedState,
        viewportOffsetFromBottom: replay.viewportOffsetFromBottom,
        replayRevision: replay.replayRevision,
      };
    }

    const desiredCwd = this.resolveSpawnCwd(project, session);
    const persistedSnapshot = this.database.getSnapshot(session.id);
    const shouldBootstrapTranscript =
      persistedSnapshot?.snapshotFormat === SNAPSHOT_FORMAT &&
      Boolean(persistedSnapshot.transcriptText);
    const bootstrapAssets =
      shouldBootstrapTranscript
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
        suppressInitialRenderNoise: Boolean(
          persistedSnapshot?.transcriptText || persistedSnapshot?.serializedState,
        ),
        suppressBootstrapOutputUntilPrompt: Boolean(
          persistedSnapshot?.serializedState && shouldBootstrapTranscript,
        ),
        bootstrapCleanupPaths: bootstrapAssets?.cleanupPaths ?? [],
      },
    );
    await this.restoreRuntimeSnapshot(runtime, persistedSnapshot);
    this.runtimes.set(session.id, runtime);

    try {
      const launch = this.shellCatalog.resolveLaunch(shellProfile, bootstrapAssets?.scriptPath);
      const pty = spawn(launch.executable, launch.args, {
        cols: input.cols,
        rows: input.rows,
        cwd: desiredCwd,
        name: "xterm-color",
        useConpty: true,
        env: buildTerminalEnvironment(process.env),
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
        runtime.inputCursorIndex = promptReady.inputCursorIndex;
      }

      pty.onData((chunk) => {
        ptyReceivePerformance.record({ bytes: countSnapshotBytes(chunk) });
        void this.handleData(tab, session, shellProfile, runtime, chunk);
      });
      pty.onExit(({ exitCode }) => {
        if (!this.runtimes.has(runtime.sessionId)) {
          return;
        }

        void this.handleProcessExit(runtime, exitCode);
      });

      this.emitStatusIfChanged(runtime);
    } catch (error) {
      cleanupBootstrapAssets(runtime.bootstrapCleanupPaths);
      runtime.bootstrapCleanupPaths = [];
      runtime.status = "error";
      runtime.errorMessage =
        error instanceof Error ? error.message : "Unknown PTY spawn error";
      this.emitStatusIfChanged(runtime);
    }

    const replay = await this.captureReplayState(runtime);
    return {
      runtime: this.toRuntimeSummary(runtime),
      serializedState: replay.serializedState,
      viewportOffsetFromBottom: replay.viewportOffsetFromBottom,
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
        inputCursorIndex: runtime.inputCursorIndex,
      },
      data,
    );
    runtime.promptTrackingValid = nextState.promptTrackingValid;
    runtime.currentInputBuffer = nextState.currentInputBuffer;
    runtime.inputCursorIndex = nextState.inputCursorIndex;

    if (
      data === "\r" &&
      !runtime.alternateScreenActive
    ) {
      runtime.pendingIntegrationHistoryCapture = false;

      const submittedCommand =
        priorValidity ? priorBuffer : this.inferSubmittedCommandFromTerminal(runtime);
      if (submittedCommand?.trim()) {
        this.recordHistoryEntry(runtime, submittedCommand, "input_capture");

        if (runtime.shellProfileId === "cmd") {
          runtime.currentCwd = inferCmdCwdFromSubmittedCommand(
            runtime.currentCwd,
            submittedCommand,
          );
        }
      } else if (runtime.supportsIntegration) {
        runtime.pendingIntegrationHistoryCapture = true;
      }
    }

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

    runtime.pty.write(commandText);
    if (runtime.promptTrackingValid) {
      const nextState = applyInputToTrackingState(
        {
          promptTrackingValid: runtime.promptTrackingValid,
          currentInputBuffer: runtime.currentInputBuffer,
          inputCursorIndex: runtime.inputCursorIndex,
        },
        commandText,
      );
      runtime.promptTrackingValid = nextState.promptTrackingValid;
      runtime.currentInputBuffer = nextState.currentInputBuffer;
      runtime.inputCursorIndex = nextState.inputCursorIndex;
    }
    this.emitStatusIfChanged(runtime);

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
    viewportOffsetFromBottom: number;
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
        if (runtime.outputFlushTimer) {
          clearTimeout(runtime.outputFlushTimer);
          runtime.outputFlushTimer = null;
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
      inputCursorIndex: INITIAL_INPUT_TRACKING_STATE.inputCursorIndex,
      pendingIntegrationHistoryCapture: false,
      lastRenderedPromptPrefix: null,
      pendingBootstrapReplayText: "",
      suppressBootstrapOutputUntilPrompt: false,
      alternateScreenActive: false,
      suppressInitialRenderNoise: true,
      currentCwd: session.lastKnownCwd,
      flushTimer: null,
      outputFlushTimer: null,
      supportsIntegration: shellProfile.supportsIntegration,
      operationQueue: Promise.resolve(),
      outputSequence: 0,
      lastCommittedSequence: 0,
      pendingOutputData: "",
      pendingOutputSequence: 0,
      snapshotDirty: false,
      lastSerializedByteCount: 0,
      lastEmittedStatusDigest: null,
      bootstrapCleanupPaths: [],
      disposed: false,
      ...overrides,
    };
  }

  private scheduleOutputFlush(runtime: RuntimeSession): void {
    if (runtime.outputFlushTimer) {
      return;
    }

    runtime.outputFlushTimer = setTimeout(() => {
      runtime.outputFlushTimer = null;
      void this.flushPendingOutput(runtime);
    }, OUTPUT_BATCH_INTERVAL_MS);
  }

  private queueOutputData(
    runtime: RuntimeSession,
    data: string,
    sequence: number,
  ): void {
    runtime.pendingOutputData += data;
    runtime.pendingOutputSequence = sequence;

    if (countSnapshotBytes(runtime.pendingOutputData) >= OUTPUT_BATCH_MAX_BYTES) {
      void this.flushPendingOutput(runtime);
      return;
    }

    this.scheduleOutputFlush(runtime);
  }

  private async flushPendingOutput(
    runtime: RuntimeSession,
    waitForCommit = false,
  ): Promise<void> {
    if (runtime.outputFlushTimer) {
      clearTimeout(runtime.outputFlushTimer);
      runtime.outputFlushTimer = null;
    }

    const data = runtime.pendingOutputData;
    const sequence = runtime.pendingOutputSequence;
    if (!data) {
      if (waitForCommit) {
        await runtime.operationQueue;
      }
      return;
    }

    runtime.pendingOutputData = "";
    outputFlushPerformance.record({
      bytes: countSnapshotBytes(data),
    });
    this.onTerminalEvent({
      type: "output",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      data,
      sequence,
    });

    const commitPromise = this.enqueueRuntimeTask(runtime, async () => {
      if (runtime.disposed) {
        return;
      }

      await writeTerminalData(runtime.headless, data);
      runtime.lastCommittedSequence = sequence;
      runtime.snapshotDirty = true;
      this.scheduleSnapshotFlush(runtime);
    });

    if (waitForCommit) {
      await commitPromise;
    }
  }

  private async handleProcessExit(
    runtime: RuntimeSession,
    exitCode: number,
  ): Promise<void> {
    await this.flushPendingOutput(runtime, true);
    if (!this.runtimes.has(runtime.sessionId)) {
      return;
    }

    runtime.status = "exited";
    runtime.exitCode = exitCode;
    runtime.pid = null;
    runtime.pty = null;
    runtime.promptTrackingValid = false;
    runtime.currentInputBuffer = "";
    runtime.inputCursorIndex = 0;
    runtime.pendingIntegrationHistoryCapture = false;
    runtime.lastRenderedPromptPrefix = null;
    runtime.snapshotDirty = true;
    await this.flushSnapshot(runtime);
    this.emitStatusIfChanged(runtime);
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
    const initialDisplayData = runtime.suppressInitialRenderNoise
      ? stripInitialTerminalNoise(parsed.sanitized)
      : parsed.sanitized;
    const bootstrapReplay = consumeBootstrapReplayPrefix(
      runtime.pendingBootstrapReplayText,
      initialDisplayData,
    );
    runtime.pendingBootstrapReplayText = bootstrapReplay.remainingReplay;
    const trackingData = bootstrapReplay.visibleChunk;
    let displayData = trackingData;
    const cmdPromptVisible =
      shellProfile.id === "cmd" && /[A-Za-z]:\\.*>\s*$/.test(trackingData.trimEnd());
    if (runtime.suppressBootstrapOutputUntilPrompt) {
      displayData = "";
      if (parsed.promptSignals.length > 0 || cmdPromptVisible) {
        runtime.suppressBootstrapOutputUntilPrompt = false;
        runtime.pendingBootstrapReplayText = "";
      }
    }

    if (parsed.enteredAlternateScreen) {
      runtime.alternateScreenActive = true;
      runtime.promptTrackingValid = false;
      runtime.currentInputBuffer = "";
      runtime.inputCursorIndex = 0;
      runtime.pendingIntegrationHistoryCapture = false;
      runtime.lastRenderedPromptPrefix = null;
      runtime.suppressBootstrapOutputUntilPrompt = false;
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

    for (const commandText of parsed.commandSignals) {
      if (!runtime.pendingIntegrationHistoryCapture) {
        continue;
      }

      this.recordHistoryEntry(runtime, commandText, "integration");
      runtime.pendingIntegrationHistoryCapture = false;
    }

    if (shellProfile.id === "cmd") {
      const inferred = inferCmdPromptCwdFromOutput(runtime.currentCwd, trackingData);
      if (inferred && inferred !== runtime.currentCwd) {
        runtime.currentCwd = inferred;
        this.persistCwdAndTitle(tab, session, shellProfile, inferred);
      }
    }

    if (parsed.promptSignals.length > 0) {
      runtime.pendingIntegrationHistoryCapture = false;
      runtime.lastRenderedPromptPrefix = this.extractLastRenderedLine(trackingData);
      const promptReady = markPromptReady();
      runtime.promptTrackingValid = promptReady.promptTrackingValid;
      runtime.currentInputBuffer = promptReady.currentInputBuffer;
      runtime.inputCursorIndex = promptReady.inputCursorIndex;
    } else if (cmdPromptVisible) {
      runtime.pendingIntegrationHistoryCapture = false;
      runtime.lastRenderedPromptPrefix =
        this.extractLastRenderedLine(trackingData) ?? runtime.lastRenderedPromptPrefix;
      const promptReady = markPromptReady();
      runtime.promptTrackingValid = promptReady.promptTrackingValid;
      runtime.currentInputBuffer = promptReady.currentInputBuffer;
      runtime.inputCursorIndex = promptReady.inputCursorIndex;
    }

    if (
      runtime.suppressInitialRenderNoise &&
      (
        parsed.promptSignals.length > 0 ||
        cmdPromptVisible ||
        parsed.cwdSignals.length > 0 ||
        /\S/.test(displayData)
      )
    ) {
      runtime.suppressInitialRenderNoise = false;
    }

    if (displayData) {
      const sequence = runtime.outputSequence + 1;
      runtime.outputSequence = sequence;
      this.queueOutputData(runtime, displayData, sequence);
    }

    this.emitStatusIfChanged(runtime);
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

  private inferSubmittedCommandFromTerminal(runtime: RuntimeSession): string | null {
    const activeBuffer = (runtime.headless.buffer as {
      active?: typeof runtime.headless.buffer.normal & {
        baseY: number;
        cursorY: number;
      };
    }).active;
    if (!activeBuffer || activeBuffer.length === 0) {
      return null;
    }

    const promptLineSegments: string[] = [];
    for (
      let lineIndex = Math.min(activeBuffer.baseY + activeBuffer.cursorY, activeBuffer.length - 1);
      lineIndex >= 0;
      lineIndex -= 1
    ) {
      const line = activeBuffer.getLine(lineIndex);
      if (!line) {
        break;
      }

      promptLineSegments.unshift(line.translateToString(true));
      if (!line.isWrapped) {
        break;
      }
    }

    const promptLine = promptLineSegments.join("");
    if (!promptLine) {
      return null;
    }

    if (
      runtime.lastRenderedPromptPrefix &&
      promptLine.startsWith(runtime.lastRenderedPromptPrefix)
    ) {
      return promptLine.slice(runtime.lastRenderedPromptPrefix.length);
    }

    const cwdPrefix = runtime.currentCwd ? `${runtime.currentCwd}>` : null;
    if (cwdPrefix && promptLine.startsWith(cwdPrefix)) {
      return promptLine.slice(cwdPrefix.length);
    }

    const genericPromptMatch = /^[A-Za-z]:\\.*>(.*)$/.exec(promptLine);
    return genericPromptMatch?.[1] ?? null;
  }

  private extractLastRenderedLine(data: string): string | null {
    if (!data) {
      return null;
    }

    const normalized = data.replace(/\r/g, "");
    const lines = normalized.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line && line.length > 0) {
        return line;
      }
    }

    return null;
  }

  private async restoreRuntimeSnapshot(
    runtime: RuntimeSession,
    snapshot: {
      transcriptText: string;
      serializedState: string;
      viewportOffsetFromBottom: number;
    } | null,
  ): Promise<void> {
    if (!snapshot?.serializedState) {
      runtime.pendingBootstrapReplayText = "";
      return;
    }

    await writeTerminalData(runtime.headless, snapshot.serializedState);
    if (snapshot.transcriptText && runtime.headless.buffer.active.cursorX !== 0) {
      await writeTerminalData(runtime.headless, "\r\n");
    }
    runtime.lastSerializedByteCount = countSnapshotBytes(snapshot.serializedState);
    runtime.pendingBootstrapReplayText = snapshot.transcriptText;
  }

  private recordHistoryEntry(
    runtime: RuntimeSession,
    commandText: string,
    source: "integration" | "input_capture",
  ): void {
    if (!commandText.trim()) {
      return;
    }

    this.database.addHistoryEntry({
      id: crypto.randomUUID(),
      projectId: runtime.projectId,
      tabId: runtime.tabId,
      sessionId: runtime.sessionId,
      shellProfileId: runtime.shellProfileId,
      cwd: runtime.currentCwd,
      commandText,
      source,
    });
  }

  private async flushSnapshot(runtime: RuntimeSession): Promise<void> {
    await this.flushPendingOutput(runtime, true);

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

    const startedAt = performance.now();
    const transcriptText = buildTerminalTranscript(runtime.headless.buffer.normal);
    const serializedState = serializeTerminal(runtime);
    const viewportOffsetFromBottom = this.getViewportOffsetFromBottom(runtime);
    runtime.snapshotDirty = false;
    this.database.upsertSnapshot({
      sessionId: runtime.sessionId,
      snapshotFormat: SNAPSHOT_FORMAT,
      transcriptText,
      serializedState,
      viewportOffsetFromBottom,
      byteCount: runtime.lastSerializedByteCount,
    });
    snapshotFlushPerformance.record({
      bytes: runtime.lastSerializedByteCount,
      durationMs: performance.now() - startedAt,
    });
  }

  private async captureReplayState(runtime: RuntimeSession): Promise<{
    serializedState: string;
    viewportOffsetFromBottom: number;
    replayRevision: number;
  }> {
    await this.flushPendingOutput(runtime, true);
    return this.enqueueRuntimeTask(runtime, () => ({
      serializedState: serializeTerminal(runtime),
      viewportOffsetFromBottom: this.getViewportOffsetFromBottom(runtime),
      replayRevision: runtime.lastCommittedSequence,
    }));
  }

  private getViewportOffsetFromBottom(runtime: RuntimeSession): number {
    const activeBuffer = runtime.headless.buffer.active;
    return Math.max(activeBuffer.baseY - activeBuffer.viewportY, 0);
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
    if (runtime.outputFlushTimer) {
      clearTimeout(runtime.outputFlushTimer);
      runtime.outputFlushTimer = null;
    }

    await this.flushPendingOutput(runtime, true);

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

  private emitStatusIfChanged(runtime: RuntimeSession): void {
    const summary = this.toRuntimeSummary(runtime);
    const digest = JSON.stringify(summary);
    if (digest === runtime.lastEmittedStatusDigest) {
      return;
    }

    runtime.lastEmittedStatusDigest = digest;
    this.onTerminalEvent({
      type: "status",
      sessionId: runtime.sessionId,
      tabId: runtime.tabId,
      runtime: summary,
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
