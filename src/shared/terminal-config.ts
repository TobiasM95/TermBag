import type { ITheme } from "@xterm/xterm";

const DARK_TERMINAL_THEME: ITheme = {
  background: "#000000",
  foreground: "#e08421",
  cursor: "#f3f3f3",
  cursorAccent: "#0c0c0c",
  selectionBackground: "rgba(255, 255, 255, 0.24)",
  selectionInactiveBackground: "rgba(255, 255, 255, 0.16)",
  selectionForeground: "#f3f3f3",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1f1f1f",
  cursor: "#1f1f1f",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0, 95, 184, 0.24)",
  selectionInactiveBackground: "rgba(0, 95, 184, 0.14)",
  selectionForeground: "#1f1f1f",
  black: "#000000",
  red: "#a31515",
  green: "#0b7a0b",
  yellow: "#795e26",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#005a9e",
  white: "#6e6e6e",
  brightBlack: "#808080",
  brightRed: "#d13438",
  brightGreen: "#107c10",
  brightYellow: "#986f0b",
  brightBlue: "#0f6cbd",
  brightMagenta: "#a347ba",
  brightCyan: "#038387",
  brightWhite: "#1f1f1f",
};

export function getTerminalTheme(themeMode: "dark" | "light"): ITheme {
  return themeMode === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

export function buildTerminalEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    TERM: baseEnv.TERM || "xterm-256color",
    COLORTERM: baseEnv.COLORTERM || "truecolor",
    TERM_PROGRAM: baseEnv.TERM_PROGRAM || "TermBag",
    ...overrides,
  };
}
