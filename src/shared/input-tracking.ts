import path from "node:path";

export interface InputTrackingState {
  promptTrackingValid: boolean;
  currentInputBuffer: string;
  inputCursorIndex: number;
}

export const INITIAL_INPUT_TRACKING_STATE: InputTrackingState = {
  promptTrackingValid: false,
  currentInputBuffer: "",
  inputCursorIndex: 0,
};

function isPrintableInput(data: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(data);
}

const INPUT_SEQUENCES = new Map<string, "left" | "right" | "home" | "end" | "delete">([
  ["\u001b[D", "left"],
  ["\u001b[C", "right"],
  ["\u001b[H", "home"],
  ["\u001b[F", "end"],
  ["\u001bOH", "home"],
  ["\u001bOF", "end"],
  ["\u001b[1~", "home"],
  ["\u001b[4~", "end"],
  ["\u001b[3~", "delete"],
]);

function insertAtCursor(current: InputTrackingState, text: string): InputTrackingState {
  const nextBuffer =
    current.currentInputBuffer.slice(0, current.inputCursorIndex) +
    text +
    current.currentInputBuffer.slice(current.inputCursorIndex);
  return {
    ...current,
    currentInputBuffer: nextBuffer,
    inputCursorIndex: current.inputCursorIndex + text.length,
  };
}

function consumeTrackedSequence(
  current: InputTrackingState,
  sequence: string,
): InputTrackingState {
  const action = INPUT_SEQUENCES.get(sequence);
  if (!action) {
    return {
      ...current,
      promptTrackingValid: false,
    };
  }

  if (action === "left") {
    return {
      ...current,
      inputCursorIndex: Math.max(0, current.inputCursorIndex - 1),
    };
  }

  if (action === "right") {
    return {
      ...current,
      inputCursorIndex: Math.min(
        current.currentInputBuffer.length,
        current.inputCursorIndex + 1,
      ),
    };
  }

  if (action === "home") {
    return {
      ...current,
      inputCursorIndex: 0,
    };
  }

  if (action === "end") {
    return {
      ...current,
      inputCursorIndex: current.currentInputBuffer.length,
    };
  }

  return {
    ...current,
    currentInputBuffer:
      current.currentInputBuffer.slice(0, current.inputCursorIndex) +
      current.currentInputBuffer.slice(current.inputCursorIndex + 1),
  };
}

export function applyInputToTrackingState(
  current: InputTrackingState,
  data: string,
): InputTrackingState {
  if (!current.promptTrackingValid) {
    return current;
  }

  if (data === "\r") {
    return {
      promptTrackingValid: false,
      currentInputBuffer: "",
      inputCursorIndex: 0,
    };
  }

  if (isPrintableInput(data)) {
    return insertAtCursor(current, data);
  }

  if (data === "\u007f" || data === "\b") {
    if (current.inputCursorIndex === 0) {
      return current;
    }

    return {
      ...current,
      currentInputBuffer:
        current.currentInputBuffer.slice(0, current.inputCursorIndex - 1) +
        current.currentInputBuffer.slice(current.inputCursorIndex),
      inputCursorIndex: current.inputCursorIndex - 1,
    };
  }

  if (data === "\u0001") {
    return {
      ...current,
      inputCursorIndex: 0,
    };
  }

  if (data === "\u0005") {
    return {
      ...current,
      inputCursorIndex: current.currentInputBuffer.length,
    };
  }

  if (data.startsWith("\u001b")) {
    return consumeTrackedSequence(current, data);
  }

  return {
    ...current,
    promptTrackingValid: false,
  };
}

export function markPromptReady(): InputTrackingState {
  return {
    promptTrackingValid: true,
    currentInputBuffer: "",
    inputCursorIndex: 0,
  };
}

export function inferCmdCwdFromSubmittedCommand(
  currentCwd: string | null,
  commandText: string,
): string | null {
  const trimmed = commandText.trim();
  if (!trimmed) {
    return currentCwd;
  }

  const driveAware = /^cd\s+\/d\s+(.+)$/i.exec(trimmed);
  const simple = /^cd\s+(.+)$/i.exec(trimmed);
  const target = driveAware?.[1] ?? simple?.[1];

  if (!target) {
    return currentCwd;
  }

  const normalizedTarget = target.trim().replace(/^"(.*)"$/, "$1");
  if (/^[A-Za-z]:\\/.test(normalizedTarget)) {
    return path.win32.normalize(normalizedTarget);
  }

  if (!currentCwd) {
    return currentCwd;
  }

  return path.win32.normalize(path.win32.resolve(currentCwd, normalizedTarget));
}
