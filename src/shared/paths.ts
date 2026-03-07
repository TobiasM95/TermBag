import path from "node:path";

export function deriveTabTitle(lastKnownCwd: string | null, shellLabel: string): string {
  if (!lastKnownCwd) {
    return shellLabel;
  }

  const base = path.basename(lastKnownCwd);
  return base || lastKnownCwd || shellLabel;
}

export function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, "\\").trim();
}
