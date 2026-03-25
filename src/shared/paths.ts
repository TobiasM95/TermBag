import path from "node:path";

export type PathModule = typeof path.win32;

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_REGEX = /^\\\\/;

export function isWindowsPath(value: string): boolean {
  const trimmed = value.trim();
  return WINDOWS_DRIVE_PATH_REGEX.test(trimmed) || WINDOWS_UNC_PATH_REGEX.test(trimmed);
}

export function getPathModuleForPath(value: string): PathModule {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

export function normalizeFilePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return isWindowsPath(trimmed)
    ? trimmed.replace(/\//g, "\\")
    : trimmed.replace(/\\/g, "/");
}

export function normalizeRelativePath(value: string, separator = "/"): string {
  return value.trim().replace(/[\\/]+/g, separator);
}

export function toPathModuleSeparators(value: string, pathModule: PathModule): string {
  return pathModule === path.win32
    ? normalizeRelativePath(value, "\\")
    : normalizeRelativePath(value, "/");
}

export function deriveTabTitle(lastKnownCwd: string | null, shellLabel: string): string {
  if (!lastKnownCwd) {
    return shellLabel;
  }

  const normalizedPath = normalizeFilePath(lastKnownCwd);
  const base = getPathModuleForPath(normalizedPath).basename(normalizedPath);
  return base || lastKnownCwd || shellLabel;
}

export function normalizeWindowsPath(value: string): string {
  return normalizeFilePath(value);
}
