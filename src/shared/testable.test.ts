import { describe, expect, it } from "vitest";
import {
  appendSnapshotChunk,
  EMPTY_SNAPSHOT,
  inferCmdCwdFromSubmittedCommand,
  inferCmdPromptCwdFromOutput,
  markPromptReady,
  parseIntegrationChunk,
  sanitizeSnapshotForDisplay,
} from "./testable.js";

describe("snapshot retention", () => {
  it("keeps only the newest 3000 lines", () => {
    let state = EMPTY_SNAPSHOT;
    const input = Array.from({ length: 3205 }, (_, index) => `line-${index}`).join("\n");
    state = appendSnapshotChunk(state, input);

    expect(state.lineCount).toBe(3000);
    expect(state.serializedBuffer.startsWith("line-205")).toBe(true);
    expect(state.serializedBuffer.endsWith("line-3204")).toBe(true);
  });

  it("sanitizes ANSI-rich terminal output for restored preview rendering", () => {
    const text = sanitizeSnapshotForDisplay(
      "\u001b[?9001h\u001b[?1004h\u001b[2J\u001b[m\u001b[HC:\\Users\\tobim\\Documents>\rC:\\Users\\tobim\\Documents>\u001b[K",
    );

    expect(text).toBe("C:\\Users\\tobim\\Documents>");
  });
});

describe("PowerShell integration parsing", () => {
  it("strips OSC markers and extracts cwd/prompt signals", () => {
    const parsed = parseIntegrationChunk(
      "\u001b]633;TermBagCwd=C%3A%5CWork%5CRepo\u0007\u001b]633;TermBagPrompt=ready\u0007PS C:\\Work\\Repo> ",
    );

    expect(parsed.cwdSignals).toEqual(["C:\\Work\\Repo"]);
    expect(parsed.promptSignals).toEqual(["ready"]);
    expect(parsed.sanitized).toBe("PS C:\\Work\\Repo> ");
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
    });
  });
});
