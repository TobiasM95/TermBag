import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { spawn, type IPty } from "node-pty";
import {
  appendSnapshotChunk,
  applyInputToTrackingState,
  EMPTY_SNAPSHOT,
  inferCmdCwdFromSubmittedCommand,
  inferCmdPromptCwdFromOutput,
  INITIAL_INPUT_TRACKING_STATE,
  markPromptReady,
  parseIntegrationChunk,
  type SnapshotAccumulatorState,
} from "../../shared/testable.js";
import { deriveTabTitle } from "../../shared/paths.js";
import type {
  ActivateTabInput,
  Project,
  RecallHistoryResult,
  SavedTerminalTab,
  ShellProfile,
  TabRuntimeSummary,
  TerminalEvent,
} from "../../shared/types.js";
import { DatabaseService } from "./database.js";
import { ShellCatalog } from "./shell-catalog.js";

interface RuntimeTab {
  tabId: string;
  projectId: string;
  shellProfileId: string;
  pty: IPty | null;
  status: TabRuntimeSummary["status"];
  pid: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  promptTrackingValid: boolean;
  currentInputBuffer: string;
  alternateScreenActive: boolean;
  currentCwd: string | null;
  snapshotState: SnapshotAccumulatorState;
  flushTimer: NodeJS.Timeout | null;
  supportsIntegration: boolean;
}

const SNAPSHOT_DEBOUNCE_MS = 500;

export class PtyManager {
  private readonly runtimes = new Map<string, RuntimeTab>();

  constructor(
    private readonly database: DatabaseService,
    private readonly shellCatalog: ShellCatalog,
    private readonly onTerminalEvent: (event: TerminalEvent) => void,
  ) {}

  getRuntimeSummary(tabId: string): TabRuntimeSummary | null {
    const runtime = this.runtimes.get(tabId);
    return runtime ? this.toRuntimeSummary(runtime) : null;
  }

  async activateTab(
    input: ActivateTabInput,
    project: Project,
    tab: SavedTerminalTab,
    shellProfile: ShellProfile,
  ): Promise<{ runtime: TabRuntimeSummary; liveOutput: string }> {
    const existing = this.runtimes.get(tab.id);
    if (existing) {
      if (existing.pty && existing.status === "running") {
        existing.pty.resize(input.cols, input.rows);
      }
      return {
        runtime: this.toRuntimeSummary(existing),
        liveOutput: existing.snapshotState.serializedBuffer,
      };
    }

    const desiredCwd = this.resolveSpawnCwd(project, tab);

    const runtime = this.createRuntime(tab, shellProfile, {
      currentCwd: desiredCwd,
      supportsIntegration: shellProfile.supportsIntegration,
    });
    this.runtimes.set(tab.id, runtime);

    try {
      const launch = this.shellCatalog.resolveLaunch(shellProfile);
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

      pty.onData((chunk) => this.handleData(tab, shellProfile, runtime, chunk));
      pty.onExit(({ exitCode }) => {
        runtime.status = "exited";
        runtime.exitCode = exitCode;
        runtime.pid = null;
        runtime.pty = null;
        runtime.promptTrackingValid = false;
        runtime.currentInputBuffer = "";
        this.flushSnapshot(runtime);
        this.emitStatus(runtime);
      });

      this.emitStatus(runtime);
      return {
        runtime: this.toRuntimeSummary(runtime),
        liveOutput: runtime.snapshotState.serializedBuffer,
      };
    } catch (error) {
      runtime.status = "error";
      runtime.errorMessage =
        error instanceof Error ? error.message : "Unknown PTY spawn error";
      this.emitStatus(runtime);
      return {
        runtime: this.toRuntimeSummary(runtime),
        liveOutput: "",
      };
    }
  }

  resizeTab(tabId: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(tabId);
    if (runtime?.pty && runtime.status === "running") {
      runtime.pty.resize(cols, rows);
    }
  }

  writeToTab(tabId: string, data: string): void {
    const runtime = this.runtimes.get(tabId);
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
          tabId,
          shellProfileId: runtime.shellProfileId,
          cwd: runtime.currentCwd,
          commandText: priorBuffer,
          source: runtime.supportsIntegration ? "integration" : "input_capture",
        });
      }

      if (runtime.shellProfileId === "cmd") {
        runtime.currentCwd = inferCmdCwdFromSubmittedCommand(
          runtime.currentCwd,
          priorBuffer,
        );
      }
    }

    this.emitStatus(runtime);
  }

  recallHistory(tabId: string, commandText: string): RecallHistoryResult {
    const runtime = this.runtimes.get(tabId);
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

  async restartTab(
    input: ActivateTabInput,
    project: Project,
    tab: SavedTerminalTab,
    shellProfile: ShellProfile,
  ): Promise<{ runtime: TabRuntimeSummary; liveOutput: string }> {
    this.disposeRuntime(tab.id, false);
    return this.activateTab(input, project, tab, shellProfile);
  }

  closeTab(tabId: string): void {
    this.disposeRuntime(tabId, true);
  }

  shutdown(): void {
    for (const tabId of this.runtimes.keys()) {
      this.disposeRuntime(tabId, true);
    }
  }

  private createRuntime(
    tab: SavedTerminalTab,
    shellProfile: ShellProfile,
    overrides?: Partial<RuntimeTab>,
  ): RuntimeTab {
    return {
      tabId: tab.id,
      projectId: tab.projectId,
      shellProfileId: tab.shellProfileId,
      pty: null,
      status: "not_started",
      pid: null,
      exitCode: null,
      errorMessage: null,
      promptTrackingValid: INITIAL_INPUT_TRACKING_STATE.promptTrackingValid,
      currentInputBuffer: INITIAL_INPUT_TRACKING_STATE.currentInputBuffer,
      alternateScreenActive: false,
      currentCwd: tab.lastKnownCwd,
      snapshotState: EMPTY_SNAPSHOT,
      flushTimer: null,
      supportsIntegration: shellProfile.supportsIntegration,
      ...overrides,
    };
  }

  private handleData(
    tab: SavedTerminalTab,
    shellProfile: ShellProfile,
    runtime: RuntimeTab,
    chunk: string,
  ): void {
    const parsed = parseIntegrationChunk(chunk);
    if (parsed.enteredAlternateScreen) {
      runtime.alternateScreenActive = true;
      runtime.promptTrackingValid = false;
      runtime.currentInputBuffer = "";
    }
    if (parsed.exitedAlternateScreen) {
      runtime.alternateScreenActive = false;
    }

    for (const cwd of parsed.cwdSignals) {
      runtime.currentCwd = cwd;
      this.persistCwdAndTitle(tab, shellProfile, cwd);
    }

    if (shellProfile.id === "cmd") {
      const inferred = inferCmdPromptCwdFromOutput(runtime.currentCwd, parsed.sanitized);
      if (inferred && inferred !== runtime.currentCwd) {
        runtime.currentCwd = inferred;
        this.persistCwdAndTitle(tab, shellProfile, inferred);
      }
    }

    if (parsed.promptSignals.length > 0) {
      const promptReady = markPromptReady();
      runtime.promptTrackingValid = promptReady.promptTrackingValid;
      runtime.currentInputBuffer = promptReady.currentInputBuffer;
    } else if (
      shellProfile.id === "cmd" &&
      /[A-Za-z]:\\.*>\s*$/.test(parsed.sanitized.trimEnd())
    ) {
      const promptReady = markPromptReady();
      runtime.promptTrackingValid = promptReady.promptTrackingValid;
      runtime.currentInputBuffer = promptReady.currentInputBuffer;
    }

    if (!runtime.alternateScreenActive && parsed.sanitized) {
      runtime.snapshotState = appendSnapshotChunk(runtime.snapshotState, parsed.sanitized);
      this.scheduleSnapshotFlush(runtime);
    }

    if (parsed.sanitized) {
      this.onTerminalEvent({
        type: "output",
        tabId: runtime.tabId,
        data: parsed.sanitized,
      });
    }

    this.emitStatus(runtime);
  }

  private persistCwdAndTitle(
    tab: SavedTerminalTab,
    shellProfile: ShellProfile,
    cwd: string,
  ): void {
    const latest = this.database.getTab(tab.id);
    if (!latest) {
      return;
    }

    const updated = this.database.updateTab({
      ...latest,
      lastKnownCwd: cwd,
      title: latest.customTitle ?? deriveTabTitle(cwd, shellProfile.label),
    });
    tab.lastKnownCwd = updated.lastKnownCwd;
    tab.title = updated.title;
    tab.customTitle = updated.customTitle;
  }

  private scheduleSnapshotFlush(runtime: RuntimeTab): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
    }

    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      this.flushSnapshot(runtime);
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private flushSnapshot(runtime: RuntimeTab): void {
    this.database.upsertSnapshot({
      tabId: runtime.tabId,
      serializedBuffer: runtime.snapshotState.serializedBuffer,
      lineCount: runtime.snapshotState.lineCount,
      byteCount: runtime.snapshotState.byteCount,
    });
  }

  private disposeRuntime(tabId: string, persistSnapshot: boolean): void {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) {
      return;
    }

    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }

    if (persistSnapshot) {
      this.flushSnapshot(runtime);
    }

    if (runtime.pty) {
      try {
        runtime.pty.kill();
      } catch {
        // Best effort only.
      }
    }

    this.runtimes.delete(tabId);
  }

  private emitStatus(runtime: RuntimeTab): void {
    this.onTerminalEvent({
      type: "status",
      tabId: runtime.tabId,
      runtime: this.toRuntimeSummary(runtime),
    });
  }

  private toRuntimeSummary(runtime: RuntimeTab): TabRuntimeSummary {
    return {
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
      sessionOutputByteCount: runtime.snapshotState.byteCount,
      currentCwd: runtime.currentCwd,
      shellProfileId: runtime.shellProfileId,
    };
  }

  private resolveSpawnCwd(project: Project, tab: SavedTerminalTab): string {
    if (tab.lastKnownCwd && fs.existsSync(tab.lastKnownCwd)) {
      return tab.lastKnownCwd;
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
