const MAX_SNAPSHOT_LINES = 3000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const ENCODER = new TextEncoder();

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
