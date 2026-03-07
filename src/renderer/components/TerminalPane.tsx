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
    if (!hostRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#010101",
        foreground: "#ff9a1f",
        cursor: "#ffbf73",
        black: "#050505",
        red: "#ff5a36",
        green: "#ff9a1f",
        yellow: "#ffbf73",
        blue: "#ff9a1f",
        magenta: "#ff9a1f",
        cyan: "#ff9a1f",
        white: "#ffbf73",
        brightBlack: "#5b3410",
        brightRed: "#ff845d",
        brightGreen: "#ffbf73",
        brightYellow: "#ffd7a1",
        brightBlue: "#ffbf73",
        brightMagenta: "#ffbf73",
        brightCyan: "#ffbf73",
        brightWhite: "#fff0dc",
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
  }, [project.id, sessionRevision, setTabRuntime, tab.id]);

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
