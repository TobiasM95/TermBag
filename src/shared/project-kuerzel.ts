export const PROJECT_KUERZEL_MAX_LENGTH = 3;

const PROJECT_KUERZEL_ERROR = "Kürzel must be 1 to 3 letters.";

type ProjectKuerzelLike = {
  name: string;
  kuerzel?: string | null;
};

export function sanitizeProjectKuerzelInput(value: string): string {
  const normalized = value.normalize("NFC");
  const letters = Array.from(normalized.matchAll(/\p{L}/gu), (match) => match[0]);
  return letters.slice(0, PROJECT_KUERZEL_MAX_LENGTH).join("");
}

export function normalizeProjectKuerzel(value: string | null | undefined): string | null {
  const trimmed = value?.trim().normalize("NFC") ?? "";
  if (!trimmed) {
    return null;
  }

  const codePoints = Array.from(trimmed);
  if (
    codePoints.length > PROJECT_KUERZEL_MAX_LENGTH ||
    !/^\p{L}+$/u.test(trimmed)
  ) {
    throw new Error(PROJECT_KUERZEL_ERROR);
  }

  return trimmed;
}

export function getProjectCollapsedKuerzel(project: ProjectKuerzelLike): string {
  try {
    const normalized = normalizeProjectKuerzel(project.kuerzel);
    if (normalized) {
      return normalized.toLocaleUpperCase();
    }
  } catch {
    // Fall back to the project name if stored data is invalid.
  }

  const trimmedName = project.name.trim().normalize("NFC");
  if (!trimmedName) {
    return "?";
  }

  const letters = Array.from(trimmedName.matchAll(/\p{L}/gu), (match) => match[0]);
  const fallbackSource = letters.length > 0 ? letters : Array.from(trimmedName);
  return fallbackSource
    .slice(0, PROJECT_KUERZEL_MAX_LENGTH)
    .join("")
    .toLocaleUpperCase();
}
