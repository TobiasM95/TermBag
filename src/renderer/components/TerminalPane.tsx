import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { Project, WorkspaceTab } from "../../shared/types";
import { isSameTerminalSize, type TerminalSize } from "../../shared/terminal-size";
import { useAppStore } from "../store/app-store";

interface TerminalPaneProps {
  project: Project;
  tab: WorkspaceTab;
  themeMode: "dark" | "light";
}

type PendingOutput = {
  data: string;
  sequence: number;
};

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

export function TerminalPane({ project, tab, themeMode }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const restartRequestedRef = useRef(false);
  const hydrationCompleteRef = useRef(false);
  const pendingOutputRef = useRef<PendingOutput[]>([]);
  const latestAppliedSequenceRef = useRef(0);
  const lastSentSizeRef = useRef<TerminalSize | null>(null);
  const setTabRuntime = useAppStore((state) => state.setTabRuntime);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const terminalTheme =
      themeMode === "dark"
        ? {
            background: "#010101",
            foreground: "#E08421",
            cursor: "#f0b66f",
            black: "#050505",
            red: "#ff5a36",
            green: "#E08421",
            yellow: "#f0b66f",
            blue: "#E08421",
            magenta: "#E08421",
            cyan: "#E08421",
            white: "#f3c58f",
            brightBlack: "#6b4a20",
            brightRed: "#ff845d",
            brightGreen: "#f0b66f",
            brightYellow: "#f8d5ac",
            brightBlue: "#f0b66f",
            brightMagenta: "#f0b66f",
            brightCyan: "#f0b66f",
            brightWhite: "#fff4e8",
          }
        : {
            background: "#ffffff",
            foreground: "#111111",
            cursor: "#111111",
            black: "#111111",
            red: "#aa2d00",
            green: "#333333",
            yellow: "#555555",
            blue: "#111111",
            magenta: "#222222",
            cyan: "#333333",
            white: "#666666",
            brightBlack: "#444444",
            brightRed: "#c24400",
            brightGreen: "#555555",
            brightYellow: "#777777",
            brightBlue: "#222222",
            brightMagenta: "#333333",
            brightCyan: "#444444",
            brightWhite: "#000000",
          };

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      scrollback: 3000,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminal.focus();

    const fitTerminal = (): TerminalSize => {
      fitAddon.fit();
      return {
        cols: terminal.cols,
        rows: terminal.rows,
      };
    };

    const sendResizeIfNeeded = (size: TerminalSize) => {
      if (lastSentSizeRef.current && isSameTerminalSize(lastSentSizeRef.current, size)) {
        return;
      }

      lastSentSizeRef.current = size;
      void window.termbag.resizeTab({
        tabId: tab.id,
        cols: size.cols,
        rows: size.rows,
      });
    };

    const initialSize = fitTerminal();

    hydrationCompleteRef.current = false;
    pendingOutputRef.current = [];
    latestAppliedSequenceRef.current = 0;
    lastSentSizeRef.current = null;

    const disposeOutput = window.termbag.onTerminalEvent((event) => {
      if (event.type === "output" && event.tabId === tab.id) {
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
        terminal.write(event.data);
      }
    });

    const disposeInput = terminal.onData((data) => {
      void window.termbag.writeToTab(tab.id, data).catch((error: unknown) => {
        setLocalError(error instanceof Error ? error.message : "Failed to send input.");
      });
    });

    const shouldRestart = restartRequestedRef.current;
    restartRequestedRef.current = false;

    const hydrate = async () => {
      setLocalError(null);
      const response = shouldRestart
        ? await window.termbag.restartTab({
            tabId: tab.id,
            cols: initialSize.cols,
            rows: initialSize.rows,
          })
        : await window.termbag.activateTab({
            tabId: tab.id,
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
      setTabRuntime(project.id, response.runtime);
      const resizeObserver = new ResizeObserver(() => {
        if (!hydrationCompleteRef.current) {
          return;
        }

        const fittedSize = fitTerminal();
        sendResizeIfNeeded(fittedSize);
      });
      resizeObserver.observe(hostRef.current);
      await nextFrame();
      const settledSize = fitTerminal();
      sendResizeIfNeeded(settledSize);
      terminal.scrollToBottom();
      terminal.focus();

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
      terminal.dispose();
    };
  }, [project.id, sessionRevision, setTabRuntime, tab.id, themeMode]);

  const runtime = tab.runtime;
  const showRestart = runtime?.status === "exited" || runtime?.status === "error";

  return (
    <section className="terminal-pane">
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
