import { execFileSync } from "node:child_process";
import headlessPkg from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";
import { describe, expect, it } from "vitest";
import {
  applyInputToTrackingState,
  buildPowerShellBootstrapScript,
  buildTerminalTranscript,
  consumeBootstrapReplayPrefix,
  countSnapshotBytes,
  inferCmdCwdFromSubmittedCommand,
  inferCmdPromptCwdFromOutput,
  isSameTerminalSize,
  markPromptReady,
  parseIntegrationChunk,
  stripInitialTerminalNoise,
} from "./testable.js";
import {
  buildCmdBootstrapScript,
  buildPowerShellBootstrapFile,
} from "../main/services/shell-bootstrap.js";

const { Terminal: HeadlessTerminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

function writeTerminalData(
  terminal: { write(data: string, callback?: () => void): void },
  data: string,
): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

describe("snapshot metadata", () => {
  it("counts serialized state bytes as utf8", () => {
    expect(countSnapshotBytes("abc")).toBe(3);
    expect(countSnapshotBytes("\u00e4")).toBe(2);
  });

  it("extracts a transcript without viewport filler lines", async () => {
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: 3000,
      convertEol: false,
    });

    await writeTerminalData(
      terminal,
      "C:\\Users\\tobim\\Documents>dir\r\nline-1\r\nline-2\r\nC:\\Users\\tobim\\Documents>",
    );

    expect(buildTerminalTranscript(terminal.buffer.normal)).toBe(
      "C:\\Users\\tobim\\Documents>dir\r\nline-1\r\nline-2\r\nC:\\Users\\tobim\\Documents>\r\n",
    );
  });

  it("merges wrapped lines into one logical transcript line", async () => {
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols: 5,
      rows: 4,
      scrollback: 100,
      convertEol: false,
    });

    await writeTerminalData(terminal, "abcdef\r\nprompt>");

    expect(buildTerminalTranscript(terminal.buffer.normal)).toBe("abcdef\r\nprompt>\r\n");
  });
});

describe("terminal sizing", () => {
  it("detects when a resize is a no-op", () => {
    expect(isSameTerminalSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(isSameTerminalSize({ cols: 80, rows: 24 }, { cols: 120, rows: 24 })).toBe(
      false,
    );
  });

  it("keeps serialized output stable across no-op resize decisions", async () => {
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: 3000,
      convertEol: false,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);

    await writeTerminalData(
      terminal,
      "C:\\Users\\tobim\\Documents>dir\r\nline-1\r\nline-2\r\nC:\\Users\\tobim\\Documents>",
    );

    const before = serializer.serialize({
      excludeAltBuffer: true,
      scrollback: 3000,
    });

    if (
      !isSameTerminalSize(
        { cols: terminal.cols, rows: terminal.rows },
        { cols: 80, rows: 24 },
      )
    ) {
      terminal.resize(80, 24);
    }

    const after = serializer.serialize({
      excludeAltBuffer: true,
      scrollback: 3000,
    });

    expect(after).toBe(before);
  });
});

describe("PowerShell integration parsing", () => {
  it("strips OSC markers and extracts cwd/prompt signals", () => {
    const parsed = parseIntegrationChunk(
      "\u001b]633;TermBagCwd=C%3A%5CWork%5CRepo\u0007\u001b]633;TermBagPrompt=ready\u0007PS C:\\Work\\Repo> ",
    );

    expect(parsed.cwdSignals).toEqual(["C:\\Work\\Repo"]);
    expect(parsed.promptSignals).toEqual(["ready"]);
    expect(parsed.commandSignals).toEqual([]);
    expect(parsed.sanitized).toBe("PS C:\\Work\\Repo> ");
  });

  it("extracts submitted command markers", () => {
    const parsed = parseIntegrationChunk("\u001b]633;TermBagCommand=git%20status\u0007");

    expect(parsed.commandSignals).toEqual(["git status"]);
    expect(parsed.sanitized).toBe("");
  });

  it("preserves generic ANSI sequences for terminal replay", () => {
    const parsed = parseIntegrationChunk("\u001b[31mred\u001b[0m");

    expect(parsed.sanitized).toBe("\u001b[31mred\u001b[0m");
  });

  it("preserves alternate-screen sequences while still tracking TUI state", () => {
    const entered = parseIntegrationChunk("\u001b[?1047h\u001b[?25l");
    const exited = parseIntegrationChunk("\u001b[?47l");

    expect(entered.enteredAlternateScreen).toBe(true);
    expect(exited.exitedAlternateScreen).toBe(true);
    expect(entered.sanitized).toBe("\u001b[?1047h\u001b[?25l");
    expect(exited.sanitized).toBe("\u001b[?47l");
  });

  it("strips cmd startup noise that would wipe hydrated replay output", () => {
    expect(
      stripInitialTerminalNoise(
        "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HC:\\Users\\tobim\\Documents>",
      ),
    ).toBe("C:\\Users\\tobim\\Documents>");
  });

  it("preserves standalone cursor visibility controls outside startup cleanup", () => {
    expect(stripInitialTerminalNoise("\u001b[?25lready")).toBe("\u001b[?25lready");
    expect(stripInitialTerminalNoise("\u001b[?25hready")).toBe("\u001b[?25hready");
  });

  it("suppresses bootstrap transcript output that already exists in restored state", () => {
    expect(
      consumeBootstrapReplayPrefix("line-1\r\nline-2\r\n", "line-1\r\nline-2\r\nprompt>"),
    ).toEqual({
      remainingReplay: "",
      visibleChunk: "prompt>",
    });
  });

  it("stops suppressing bootstrap replay once the output no longer matches", () => {
    expect(
      consumeBootstrapReplayPrefix("line-1\r\nline-2\r\n", "line-1\r\noops"),
    ).toEqual({
      remainingReplay: "",
      visibleChunk: "oops",
    });
  });
});

describe("shell bootstrap scripts", () => {
  it("builds a cmd bootstrap script that types the transcript file", () => {
    expect(buildCmdBootstrapScript("C:\\Temp\\history.txt")).toContain(
      'type "C:\\Temp\\history.txt"',
    );
  });

  it("builds a PowerShell bootstrap file that prints transcript text and installs prompt integration", () => {
    const script = buildPowerShellBootstrapFile("C:\\Temp\\bob's-history.txt");

    expect(script).toContain("$TranscriptPath = 'C:\\Temp\\bob''s-history.txt'");
    expect(script).toContain("[Console]::Write($text)");
    expect(script).toContain("function global:prompt {");
    expect(script).toContain("Set-PSReadLineOption -AddToHistoryHandler");
    expect(script).toContain("]633;TermBagCommand=");
  });

  it("builds an inline PowerShell bootstrap script that parses when passed to -Command", () => {
    const script = buildPowerShellBootstrapScript();

    expect(script).toContain("\r\n");
    expect(script).toContain("$script:__TermBagEmitAcceptedCommand = {\r\n");

    if (process.platform !== "win32") {
      return;
    }

    const output = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-Command", `${script}\r\nWrite-Output 'parse-ok'`],
      { encoding: "utf8" },
    );

    expect(output).toContain("parse-ok");
  });
});

describe("cmd cwd heuristics", () => {
  it("updates cwd from submitted cd commands", () => {
    expect(
      inferCmdCwdFromSubmittedCommand("C:\\Work\\Repo", "cd src"),
    ).toBe("C:\\Work\\Repo\\src");
    expect(
      inferCmdCwdFromSubmittedCommand("C:\\Work\\Repo", 'cd /d "D:\\Scratch"'),
    ).toBe("D:\\Scratch");
  });

  it("recognizes default cmd prompts in output", () => {
    expect(inferCmdPromptCwdFromOutput(null, "C:\\Work\\Repo>")).toBe("C:\\Work\\Repo");
  });
});

describe("prompt readiness", () => {
  it("resets tracked input buffer", () => {
    expect(markPromptReady()).toEqual({
      promptTrackingValid: true,
      currentInputBuffer: "",
      inputCursorIndex: 0,
    });
  });

  it("tracks cursor-aware prompt edits", () => {
    let state = markPromptReady();
    state = applyInputToTrackingState(state, "abc");
    state = applyInputToTrackingState(state, "\u001b[D");
    state = applyInputToTrackingState(state, "\u001b[D");
    state = applyInputToTrackingState(state, "Z");
    state = applyInputToTrackingState(state, "\u001b[3~");

    expect(state).toEqual({
      promptTrackingValid: true,
      currentInputBuffer: "aZc",
      inputCursorIndex: 2,
    });
  });

  it("tracks pasted text at the current cursor position", () => {
    let state = markPromptReady();
    state = applyInputToTrackingState(state, "abc");
    state = applyInputToTrackingState(state, "\u001b[D");
    state = applyInputToTrackingState(state, "XYZ");

    expect(state).toEqual({
      promptTrackingValid: true,
      currentInputBuffer: "abXYZc",
      inputCursorIndex: 5,
    });
  });

  it("invalidates tracking for unsupported history-navigation escape sequences", () => {
    const state = applyInputToTrackingState(markPromptReady(), "\u001b[A");

    expect(state.promptTrackingValid).toBe(false);
    expect(state.currentInputBuffer).toBe("");
    expect(state.inputCursorIndex).toBe(0);
  });
});
