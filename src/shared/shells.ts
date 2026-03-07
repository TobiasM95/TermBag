import type { ShellProfile } from "./types.js";

export const BUILT_IN_SHELLS: ShellProfile[] = [
  {
    id: "pwsh",
    label: "PowerShell 7",
    executable: "pwsh.exe",
    argsJson: "[]",
    platform: "win32",
    supportsIntegration: true,
    sortOrder: 1,
  },
  {
    id: "powershell",
    label: "Windows PowerShell",
    executable: "powershell.exe",
    argsJson: "[]",
    platform: "win32",
    supportsIntegration: true,
    sortOrder: 2,
  },
  {
    id: "cmd",
    label: "Command Prompt",
    executable: "cmd.exe",
    argsJson: "[]",
    platform: "win32",
    supportsIntegration: false,
    sortOrder: 3,
  },
];

export const DEFAULT_PROFILE_ORDER = ["pwsh", "powershell", "cmd"] as const;
