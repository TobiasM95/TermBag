export const SNAPSHOT_FORMAT = "plain-transcript-v1" as const;
export const SNAPSHOT_SCROLLBACK = 3000;
export const SNAPSHOT_MAX_LOGICAL_LINES = 1200;
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

export type SnapshotFormat = typeof SNAPSHOT_FORMAT;

export interface TranscriptBufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TranscriptBufferLike {
  readonly length: number;
  getLine(index: number): TranscriptBufferLineLike | undefined;
}

export function countSnapshotBytes(snapshotText: string): number {
  return Buffer.byteLength(snapshotText, "utf8");
}

export function buildTerminalTranscript(
  buffer: TranscriptBufferLike,
  options?: {
    maxLogicalLines?: number;
    maxBytes?: number;
  },
): string {
  const maxLogicalLines = options?.maxLogicalLines ?? SNAPSHOT_MAX_LOGICAL_LINES;
  const maxBytes = options?.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const logicalLines: string[] = [];
  let currentLine: string | null = null;

  for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      continue;
    }

    const rendered = line.translateToString(true);
    if (line.isWrapped && currentLine !== null) {
      currentLine += rendered;
      continue;
    }

    if (currentLine !== null) {
      logicalLines.push(currentLine);
    }
    currentLine = rendered;
  }

  if (currentLine !== null) {
    logicalLines.push(currentLine);
  }

  while (logicalLines.length > 0 && logicalLines[0] === "") {
    logicalLines.shift();
  }
  while (logicalLines.length > 0 && logicalLines[logicalLines.length - 1] === "") {
    logicalLines.pop();
  }

  if (logicalLines.length === 0) {
    return "";
  }

  let boundedLines =
    logicalLines.length > maxLogicalLines
      ? logicalLines.slice(logicalLines.length - maxLogicalLines)
      : logicalLines;

  let transcript = ensureTranscriptEndsWithNewline(boundedLines.join("\r\n"));
  while (boundedLines.length > 1 && countSnapshotBytes(transcript) > maxBytes) {
    boundedLines = boundedLines.slice(1);
    transcript = ensureTranscriptEndsWithNewline(boundedLines.join("\r\n"));
  }

  if (countSnapshotBytes(transcript) <= maxBytes) {
    return transcript;
  }

  const truncatedTail = truncateUtf8FromStart(
    transcript,
    Math.max(maxBytes - countSnapshotBytes("\r\n"), 0),
  );
  return ensureTranscriptEndsWithNewline(truncatedTail.trimStart());
}

export function ensureTranscriptEndsWithNewline(transcript: string): string {
  if (!transcript) {
    return "";
  }

  return /(?:\r\n|\n)$/.test(transcript) ? transcript : `${transcript}\r\n`;
}

function truncateUtf8FromStart(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return text;
  }

  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength) {
    const currentByte = bytes[start];
    if (currentByte === undefined || (currentByte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return bytes.subarray(start).toString("utf8");
}
