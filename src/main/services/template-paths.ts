import path from "node:path";
import {
  getPathModuleForPath,
  normalizeFilePath,
  normalizeRelativePath,
  toPathModuleSeparators,
} from "../../shared/paths.js";
import type { TemplatePathReference } from "../../shared/types.js";

function normalizeRoot(projectRoot: string): string {
  return normalizeFilePath(projectRoot.trim());
}

function normalizeCwd(cwd: string): string {
  return normalizeFilePath(cwd.trim());
}

function getPathModule(projectRoot: string, cwd?: string): typeof path.win32 {
  return getPathModuleForPath(cwd && cwd.trim() ? cwd : projectRoot);
}

function isRelativeToRoot(projectRoot: string, cwd: string): boolean {
  const pathModule = getPathModule(projectRoot, cwd);
  const relative = normalizeRelativePath(pathModule.relative(projectRoot, cwd));
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

export function encodeTemplatePathReference(
  projectRoot: string,
  cwd: string | null,
): TemplatePathReference | null {
  if (!cwd || !cwd.trim()) {
    return null;
  }

  const normalizedCwd = normalizeCwd(cwd);
  const normalizedRoot = normalizeRoot(projectRoot);
  if (normalizedRoot && isRelativeToRoot(normalizedRoot, normalizedCwd)) {
    const relative =
      normalizeRelativePath(getPathModule(normalizedRoot, normalizedCwd).relative(normalizedRoot, normalizedCwd)) ||
      ".";
    return {
      kind: "relative",
      value: relative,
    };
  }

  return {
    kind: "absolute",
    value: normalizedCwd,
  };
}

export function resolveTemplatePathReference(
  projectRoot: string,
  reference: TemplatePathReference | null,
): string | null {
  if (!reference) {
    return null;
  }

  if (reference.kind === "absolute") {
    return normalizeFilePath(reference.value);
  }

  const normalizedRoot = normalizeRoot(projectRoot);
  if (!normalizedRoot) {
    return null;
  }

  const pathModule = getPathModule(normalizedRoot);
  const relativeValue = toPathModuleSeparators(reference.value, pathModule);
  return normalizeFilePath(pathModule.resolve(normalizedRoot, relativeValue));
}
