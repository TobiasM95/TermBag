import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import type { Project, WorkspaceTab } from "../../shared/types";
import { useAppStore } from "../store/app-store";

interface TerminalPaneProps {
  project: Project;
  tab: WorkspaceTab;
}

export function TerminalPane({ project, tab }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const restartRequestedRef = useRef(false);
  const setTabRuntime = useAppStore((state) => state.setTabRuntime);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (tab.rootPathMissing || !hostRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0b1014",
        foreground: "#d7e0e8",
        cursor: "#f6f7f9",
        black: "#1f2a35",
        red: "#ee6d6d",
        green: "#87d38b",
        yellow: "#f4cf6b",
        blue: "#7ac1ff",
        magenta: "#d9a7ff",
        cyan: "#63d6d2",
        white: "#d7e0e8",
        brightBlack: "#4a5a69",
        brightRed: "#ff8d8d",
        brightGreen: "#a9f3ad",
        brightYellow: "#ffe08a",
        brightBlue: "#9bd7ff",
        brightMagenta: "#e6c0ff",
        brightCyan: "#7ceae6",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    fitAddon.fit();

    const resize = () => {
      fitAddon.fit();
      void window.termbag.resizeTab({
        tabId: tab.id,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(hostRef.current);

    const disposeOutput = window.termbag.onTerminalEvent((event) => {
      if (event.type === "output" && event.tabId === tab.id) {
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
            cols: terminal.cols,
            rows: terminal.rows,
          })
        : await window.termbag.activateTab({
            tabId: tab.id,
            cols: terminal.cols,
            rows: terminal.rows,
          });

      terminal.reset();
      if (response.liveOutput) {
        terminal.write(response.liveOutput);
      }
      setTabRuntime(project.id, response.runtime);
      resize();
    };

    void hydrate().catch((error: unknown) => {
      setLocalError(error instanceof Error ? error.message : "Failed to start the shell.");
    });

    return () => {
      resizeObserver.disconnect();
      disposeOutput();
      disposeInput.dispose();
      terminal.dispose();
    };
  }, [project.id, sessionRevision, setTabRuntime, tab.id, tab.rootPathMissing]);

  const runtime = tab.runtime;
  const showSnapshot = Boolean(tab.snapshot?.serializedBuffer);
  const showRestart = runtime?.status === "exited" || runtime?.status === "error";

  return (
    <section className="terminal-pane">
      <header className="terminal-status-bar">
        <div>
          <strong>{tab.title}</strong>
          <span>{runtime?.currentCwd ?? tab.lastKnownCwd ?? project.rootPath}</span>
        </div>
        <div className="terminal-flags">
          <span>{runtime?.status ?? "not_started"}</span>
          <span>{runtime?.promptTrackingValid ? "prompt tracked" : "prompt untrusted"}</span>
        </div>
      </header>

      {showSnapshot ? (
        <>
          <div className="restored-pane">
            <div className="restored-pane__label">Restored snapshot</div>
            <pre>{tab.snapshot?.serializedBuffer}</pre>
          </div>
          <div className="restored-divider">
            <span>Fresh shell output below</span>
          </div>
        </>
      ) : null}

      {tab.rootPathMissing ? (
        <div className="terminal-state terminal-state--error">
          <strong>Project path unavailable</strong>
          <p>
            The project root <code>{project.rootPath}</code> does not exist. Update the
            project path before starting a shell.
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

      <div className={`terminal-live ${tab.rootPathMissing ? "terminal-live--disabled" : ""}`}>
        {!tab.rootPathMissing ? <div ref={hostRef} className="terminal-host" /> : null}
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
