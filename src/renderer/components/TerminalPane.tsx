import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { Project, WorkspaceSession, WorkspaceTab } from "../../shared/types";
import { getTerminalTheme } from "../../shared/terminal-config";
import { isSameTerminalSize, type TerminalSize } from "../../shared/terminal-size";
import { createTerminalPerformanceMeter } from "../../shared/terminal-performance";
import { useAppStore } from "../store/app-store";

interface TerminalPaneProps {
  project: Project;
  tab: WorkspaceTab;
  session: WorkspaceSession;
  themeMode: "dark" | "light";
  isFocused: boolean;
  onFocusSession(): void;
}

type PendingOutput = {
  data: string;
  sequence: number;
};

function isRendererTerminalPerfEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem("termbag-debug-perf") === "1";
}

const terminalPerfEnabled = isRendererTerminalPerfEnabled();
const terminalPaneRenderPerformance = createTerminalPerformanceMeter(
  "renderer:terminal-pane:render",
  terminalPerfEnabled,
);
const terminalOutputFlushPerformance = createTerminalPerformanceMeter(
  "renderer:output-queue-flush",
  terminalPerfEnabled,
);
const terminalWriteCompletionPerformance = createTerminalPerformanceMeter(
  "renderer:xterm-write-complete",
  terminalPerfEnabled,
);

function writeTerminalData(terminal: Terminal, data: string): Promise<void> {
  if (!data) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function countTerminalBytes(data: string): number {
  return new TextEncoder().encode(data).byteLength;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c";
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v";
}

export function TerminalPane({
  project,
  tab,
  session,
  themeMode,
  isFocused,
  onFocusSession,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const restartRequestedRef = useRef(false);
  const hydrationCompleteRef = useRef(false);
  const pendingOutputRef = useRef<PendingOutput[]>([]);
  const queuedLiveOutputRef = useRef("");
  const liveFlushScheduledRef = useRef(false);
  const liveWriteInFlightRef = useRef(false);
  const latestAppliedSequenceRef = useRef(0);
  const lastSentSizeRef = useRef<TerminalSize | null>(null);
  const liveFlushFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const setSessionRuntime = useAppStore((state) => state.setSessionRuntime);
  const runtime = useAppStore((state) => state.sessionRuntimes[session.id] ?? session.runtime);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    terminalPaneRenderPerformance.record();
  });

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const terminalTheme = getTerminalTheme(themeMode);

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      customGlyphs: true,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 13,
      rescaleOverlappingGlyphs: true,
      scrollback: 3000,
      theme: terminalTheme,
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }

      if (isCopyShortcut(event)) {
        if (!terminal.hasSelection()) {
          return true;
        }

        event.preventDefault();
        void window.termbag
          .writeClipboardText(terminal.getSelection())
          .catch((error: unknown) => {
            console.error("Failed to copy terminal selection.", error);
          });
        return false;
      }

      if (isPasteShortcut(event)) {
        event.preventDefault();
        void window.termbag
          .readClipboardText()
          .then((text) => {
            if (!text) {
              return;
            }

            terminal.focus();
            terminal.paste(text);
          })
          .catch((error: unknown) => {
            console.error("Failed to paste into terminal.", error);
          });
        return false;
      }

      return true;
    });
    if (isFocused) {
      terminal.focus();
    }

    const fitTerminal = (): TerminalSize => {
      fitAddon.fit();
      return {
        cols: terminal.cols,
        rows: terminal.rows,
      };
    };

    const flushQueuedOutput = async () => {
      if (liveWriteInFlightRef.current) {
        return;
      }

      const data = queuedLiveOutputRef.current;
      if (!data) {
        return;
      }

      const queuedBytes = countTerminalBytes(data);
      queuedLiveOutputRef.current = "";
      liveWriteInFlightRef.current = true;
      terminalOutputFlushPerformance.record({
        bytes: queuedBytes,
        queueDepth: countTerminalBytes(queuedLiveOutputRef.current),
      });

      const startedAt = performance.now();
      await writeTerminalData(terminal, data);
      terminalWriteCompletionPerformance.record({
        bytes: queuedBytes,
        durationMs: performance.now() - startedAt,
        queueDepth: countTerminalBytes(queuedLiveOutputRef.current),
      });
      liveWriteInFlightRef.current = false;

      if (queuedLiveOutputRef.current) {
        scheduleOutputFlush();
      }
    };

    const scheduleOutputFlush = () => {
      if (liveFlushScheduledRef.current || !hydrationCompleteRef.current) {
        return;
      }

      liveFlushScheduledRef.current = true;
      liveFlushFrameRef.current = requestAnimationFrame(() => {
        liveFlushScheduledRef.current = false;
        liveFlushFrameRef.current = null;
        void flushQueuedOutput();
      });
    };

    const sendResizeIfNeeded = (size: TerminalSize) => {
      if (lastSentSizeRef.current && isSameTerminalSize(lastSentSizeRef.current, size)) {
        return;
      }

      lastSentSizeRef.current = size;
      window.termbag.resizeSession({
        sessionId: session.id,
        cols: size.cols,
        rows: size.rows,
      });
    };

    const scheduleResize = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (!hydrationCompleteRef.current) {
          return;
        }

        const fittedSize = fitTerminal();
        sendResizeIfNeeded(fittedSize);
      });
    };

    const initialSize = fitTerminal();

    hydrationCompleteRef.current = false;
    pendingOutputRef.current = [];
    queuedLiveOutputRef.current = "";
    liveFlushScheduledRef.current = false;
    liveWriteInFlightRef.current = false;
    latestAppliedSequenceRef.current = 0;
    lastSentSizeRef.current = null;

    const disposeOutput = window.termbag.onTerminalEvent((event) => {
      if (event.type === "output" && event.sessionId === session.id) {
        if (!hydrationCompleteRef.current) {
          pendingOutputRef.current.push({
            data: event.data,
            sequence: event.sequence,
          });
          return;
        }

        if (event.sequence <= latestAppliedSequenceRef.current) {
          return;
        }

        latestAppliedSequenceRef.current = event.sequence;
        queuedLiveOutputRef.current += event.data;
        scheduleOutputFlush();
      }
    });

    const disposeInput = terminal.onData((data) => {
      window.termbag.writeToSession(session.id, data);
    });

    const shouldRestart = restartRequestedRef.current;
    restartRequestedRef.current = false;

    const hydrate = async () => {
      setLocalError(null);
      const response = shouldRestart
        ? await window.termbag.restartSession({
            sessionId: session.id,
            cols: initialSize.cols,
            rows: initialSize.rows,
          })
        : await window.termbag.activateSession({
            sessionId: session.id,
            cols: initialSize.cols,
            rows: initialSize.rows,
          });

      terminal.reset();
      if (response.serializedState) {
        await writeTerminalData(terminal, response.serializedState);
      }

      latestAppliedSequenceRef.current = response.replayRevision;
      const bufferedOutput = pendingOutputRef.current
        .filter((entry) => entry.sequence > response.replayRevision)
        .sort((left, right) => left.sequence - right.sequence);
      pendingOutputRef.current = [];

      for (const entry of bufferedOutput) {
        if (entry.sequence <= latestAppliedSequenceRef.current) {
          continue;
        }

        await writeTerminalData(terminal, entry.data);
        latestAppliedSequenceRef.current = entry.sequence;
      }

      hydrationCompleteRef.current = true;
      lastSentSizeRef.current = initialSize;
      setSessionRuntime(response.runtime);
      const resizeObserver = new ResizeObserver(() => {
        if (!hydrationCompleteRef.current) {
          return;
        }

        scheduleResize();
      });
      resizeObserver.observe(hostRef.current!);
      await nextFrame();
      scheduleResize();
      terminal.scrollToBottom();
      if (isFocused) {
        terminal.focus();
      }

      return () => {
        resizeObserver.disconnect();
      };
    };

    let disposeResizeObserver: (() => void) | null = null;
    void hydrate()
      .then((dispose) => {
        disposeResizeObserver = dispose ?? null;
      })
      .catch((error: unknown) => {
        setLocalError(error instanceof Error ? error.message : "Failed to start the shell.");
      });

    return () => {
      disposeResizeObserver?.();
      disposeOutput();
      disposeInput.dispose();
      if (liveFlushFrameRef.current !== null) {
        cancelAnimationFrame(liveFlushFrameRef.current);
        liveFlushFrameRef.current = null;
      }
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [session.id, sessionRevision, setSessionRuntime, themeMode]);

  useEffect(() => {
    if (isFocused) {
      terminalRef.current?.focus();
    }
  }, [isFocused, session.id]);

  const showRestart = runtime?.status === "exited" || runtime?.status === "error";

  return (
    <section
      className={`terminal-pane ${isFocused ? "terminal-pane--focused" : ""}`}
      onPointerDownCapture={onFocusSession}
      onFocusCapture={onFocusSession}
    >
      {tab.rootPathMissing ? (
        <div className="terminal-state">
          <strong>Default path unavailable</strong>
          <p>
            The configured default path <code>{project.rootPath}</code> does not exist.
            The shell was started in a fallback working directory instead.
          </p>
        </div>
      ) : null}

      {localError ? (
        <div className="terminal-state terminal-state--error">
          <strong>Shell startup failed</strong>
          <p>{localError}</p>
        </div>
      ) : null}

      {runtime?.status === "error" && runtime.errorMessage ? (
        <div className="terminal-state terminal-state--error">
          <strong>Runtime error</strong>
          <p>{runtime.errorMessage}</p>
        </div>
      ) : null}

      {runtime?.status === "exited" ? (
        <div className="terminal-state">
          <strong>Shell exited</strong>
          <p>Exit code: {runtime.exitCode ?? "unknown"}</p>
        </div>
      ) : null}

      <div className="terminal-live">
        <div ref={hostRef} className="terminal-host" />
      </div>

      {showRestart ? (
        <div className="terminal-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              restartRequestedRef.current = true;
              setSessionRevision((value) => value + 1);
            }}
          >
            Reopen shell
          </button>
        </div>
      ) : null}
    </section>
  );
}
