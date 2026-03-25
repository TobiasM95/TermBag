export type SessionBorderPalette = {
  base: string;
  focused: string;
  unfocused: string;
};

type ThemeMode = "dark" | "light";

type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHexChannel(value: number): string {
  return clampChannel(value).toString(16).padStart(2, "0");
}

function parseHexColor(value: string): RgbColor {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (/^[\da-f]{3}$/i.test(hex)) {
    return {
      red: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      green: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      blue: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    };
  }

  if (/^[\da-f]{6}$/i.test(hex)) {
    return {
      red: Number.parseInt(hex.slice(0, 2), 16),
      green: Number.parseInt(hex.slice(2, 4), 16),
      blue: Number.parseInt(hex.slice(4, 6), 16),
    };
  }

  throw new Error("Border color must be a valid hex color.");
}

function formatHexColor(color: RgbColor): string {
  return `#${toHexChannel(color.red)}${toHexChannel(color.green)}${toHexChannel(color.blue)}`;
}

function mixHexColors(baseColor: string, mixColor: string, mixRatio: number): string {
  const base = parseHexColor(baseColor);
  const mix = parseHexColor(mixColor);
  const ratio = Math.max(0, Math.min(1, mixRatio));

  return formatHexColor({
    red: base.red + (mix.red - base.red) * ratio,
    green: base.green + (mix.green - base.green) * ratio,
    blue: base.blue + (mix.blue - base.blue) * ratio,
  });
}

export function normalizeSessionBorderColor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("Border color must be a string.");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return formatHexColor(parseHexColor(trimmed));
}

export function parseStoredSessionBorderColor(value: unknown): string | null {
  try {
    return normalizeSessionBorderColor(typeof value === "string" ? value : null);
  } catch {
    return null;
  }
}

export function createSessionBorderPalette(
  borderColor: string | null | undefined,
  themeMode: ThemeMode,
): SessionBorderPalette | null {
  const base = normalizeSessionBorderColor(borderColor);
  if (!base) {
    return null;
  }

  const focusedTarget = themeMode === "dark" ? "#ffffff" : "#000000";
  const unfocusedTarget = themeMode === "dark" ? "#000000" : "#ffffff";

  return {
    base,
    focused: mixHexColors(base, focusedTarget, 0.2),
    unfocused: mixHexColors(base, unfocusedTarget, 0.16),
  };
}
