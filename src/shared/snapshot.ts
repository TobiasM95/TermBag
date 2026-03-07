const MAX_SNAPSHOT_LINES = 3000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const ENCODER = new TextEncoder();
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE_SEQUENCE = /\u001b[@-Z\\-_]/g;
const OTHER_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export interface SnapshotAccumulatorState {
  serializedBuffer: string;
  lineCount: number;
  byteCount: number;
}

export const EMPTY_SNAPSHOT: SnapshotAccumulatorState = {
  serializedBuffer: "",
  lineCount: 0,
  byteCount: 0,
};

function trimToCaps(text: string): SnapshotAccumulatorState {
  let lines = text.split(/\r?\n/);
  if (lines.length > MAX_SNAPSHOT_LINES) {
    lines = lines.slice(lines.length - MAX_SNAPSHOT_LINES);
  }

  let joined = lines.join("\n");
  let byteCount = ENCODER.encode(joined).length;

  while (byteCount > MAX_SNAPSHOT_BYTES && lines.length > 0) {
    lines = lines.slice(1);
    joined = lines.join("\n");
    byteCount = ENCODER.encode(joined).length;
  }

  return {
    serializedBuffer: joined,
    lineCount: joined === "" ? 0 : lines.length,
    byteCount,
  };
}

export function appendSnapshotChunk(
  current: SnapshotAccumulatorState,
  chunk: string,
): SnapshotAccumulatorState {
  if (!chunk) {
    return current;
  }

  const text = current.serializedBuffer
    ? `${current.serializedBuffer}${chunk}`
    : chunk;

  return trimToCaps(text);
}

export function snapshotCaps() {
  return {
    maxLines: MAX_SNAPSHOT_LINES,
    maxBytes: MAX_SNAPSHOT_BYTES,
  };
}

export function sanitizeSnapshotForDisplay(serializedBuffer: string): string {
  if (!serializedBuffer) {
    return "";
  }

  const withoutAnsi = serializedBuffer
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESCAPE_SEQUENCE, "")
    .replace(OTHER_CONTROL_CHARS, "");

  const normalizedLines: string[] = [];
  let currentLine = "";

  for (const char of withoutAnsi) {
    if (char === "\r") {
      currentLine = "";
      continue;
    }

    if (char === "\n") {
      normalizedLines.push(currentLine);
      currentLine = "";
      continue;
    }

    currentLine += char;
  }

  normalizedLines.push(currentLine);

  while (normalizedLines.length > 0 && normalizedLines[0]?.trim() === "") {
    normalizedLines.shift();
  }

  while (
    normalizedLines.length > 0 &&
    normalizedLines[normalizedLines.length - 1]?.trim() === ""
  ) {
    normalizedLines.pop();
  }

  return normalizedLines.join("\n");
}
