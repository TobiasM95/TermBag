import path from "node:path";

export interface InputTrackingState {
  promptTrackingValid: boolean;
  currentInputBuffer: string;
}

export const INITIAL_INPUT_TRACKING_STATE: InputTrackingState = {
  promptTrackingValid: false,
  currentInputBuffer: "",
};

function isPrintableInput(data: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(data);
}

export function applyInputToTrackingState(
  current: InputTrackingState,
  data: string,
): InputTrackingState {
  if (data === "\r") {
    return {
      promptTrackingValid: false,
      currentInputBuffer: "",
    };
  }

  if (!current.promptTrackingValid) {
    return current;
  }

  if (data === "\u007f") {
    return {
      ...current,
      currentInputBuffer: current.currentInputBuffer.slice(0, -1),
    };
  }

  if (isPrintableInput(data)) {
    return {
      ...current,
      currentInputBuffer: `${current.currentInputBuffer}${data}`,
    };
  }

  return {
    promptTrackingValid: false,
    currentInputBuffer: current.currentInputBuffer,
  };
}

export function markPromptReady(): InputTrackingState {
  return {
    promptTrackingValid: true,
    currentInputBuffer: "",
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
    return path.normalize(normalizedTarget);
  }

  if (!currentCwd) {
    return currentCwd;
  }

  return path.normalize(path.resolve(currentCwd, normalizedTarget));
}
