import path from "node:path";
import { normalizeWindowsPath } from "../../shared/paths.js";
import type { TemplatePathReference } from "../../shared/types.js";

function normalizeRoot(projectRoot: string): string {
  return normalizeWindowsPath(projectRoot.trim());
}

function normalizeCwd(cwd: string): string {
  return normalizeWindowsPath(cwd.trim());
}

function isRelativeToRoot(projectRoot: string, cwd: string): boolean {
  const relative = path.win32.relative(projectRoot, cwd);
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
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
    const relative = path.win32.relative(normalizedRoot, normalizedCwd) || ".";
    return {
      kind: "relative",
      value: normalizeWindowsPath(relative),
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
    return normalizeWindowsPath(reference.value);
  }

  const normalizedRoot = normalizeRoot(projectRoot);
  if (!normalizedRoot) {
    return null;
  }

  return normalizeWindowsPath(path.win32.resolve(normalizedRoot, reference.value));
}
