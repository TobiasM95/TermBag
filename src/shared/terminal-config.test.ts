import { describe, expect, it } from "vitest";
import { buildTerminalEnvironment, getTerminalTheme } from "./terminal-config.js";

describe("terminal theme", () => {
  it("keeps distinct ANSI colors in dark mode", () => {
    const theme = getTerminalTheme("dark");

    expect(theme.background).toBe("#000000");
    expect(theme.foreground).toBe("#e08421");
    expect(theme.green).toBe("#13a10e");
    expect(theme.blue).toBe("#0037da");
    expect(theme.magenta).toBe("#881798");
    expect(theme.cyan).toBe("#3a96dd");
  });

  it("keeps a readable colored palette in light mode", () => {
    const theme = getTerminalTheme("light");

    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#1f1f1f");
    expect(theme.red).toBe("#a31515");
    expect(theme.blue).toBe("#0037da");
    expect(theme.cyan).toBe("#005a9e");
  });
});

describe("terminal environment", () => {
  it("adds color capability hints when they are missing", () => {
    expect(
      buildTerminalEnvironment({
        PATH: "C:\\Windows\\System32",
      }),
    ).toMatchObject({
      PATH: "C:\\Windows\\System32",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "TermBag",
    });
  });

  it("preserves explicit terminal capability variables from the parent environment", () => {
    expect(
      buildTerminalEnvironment({
        TERM: "screen-256color",
        COLORTERM: "24bit",
        TERM_PROGRAM: "Windows_Terminal",
      }),
    ).toMatchObject({
      TERM: "screen-256color",
      COLORTERM: "24bit",
      TERM_PROGRAM: "Windows_Terminal",
    });
  });
});
