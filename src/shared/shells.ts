import type { ShellPlatform, ShellProfile } from "./types.js";

const WINDOWS_SHELLS: ShellProfile[] = [
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

const MACOS_SHELLS: ShellProfile[] = [
  {
    id: "zsh",
    label: "Zsh",
    executable: "/bin/zsh",
    argsJson: "[]",
    platform: "darwin",
    supportsIntegration: true,
    sortOrder: 1,
  },
  {
    id: "bash",
    label: "Bash",
    executable: "/bin/bash",
    argsJson: "[]",
    platform: "darwin",
    supportsIntegration: true,
    sortOrder: 2,
  },
  {
    id: "pwsh",
    label: "PowerShell 7",
    executable: "pwsh",
    argsJson: "[]",
    platform: "darwin",
    supportsIntegration: true,
    sortOrder: 3,
  },
];

const LINUX_SHELLS: ShellProfile[] = [
  {
    id: "bash",
    label: "Bash",
    executable: "/bin/bash",
    argsJson: "[]",
    platform: "linux",
    supportsIntegration: true,
    sortOrder: 1,
  },
  {
    id: "pwsh",
    label: "PowerShell 7",
    executable: "pwsh",
    argsJson: "[]",
    platform: "linux",
    supportsIntegration: true,
    sortOrder: 2,
  },
];

const SHELLS_BY_PLATFORM: Record<ShellPlatform, ShellProfile[]> = {
  win32: WINDOWS_SHELLS,
  darwin: MACOS_SHELLS,
  linux: LINUX_SHELLS,
};

const DEFAULT_PROFILE_ORDER_BY_PLATFORM: Record<ShellPlatform, readonly string[]> = {
  win32: ["pwsh", "powershell", "cmd"],
  darwin: ["zsh", "bash", "pwsh"],
  linux: ["bash", "pwsh"],
};

export function resolveShellPlatform(platform: string): ShellPlatform {
  switch (platform) {
    case "win32":
    case "darwin":
    case "linux":
      return platform;
    default:
      return "linux";
  }
}

export function getBuiltInShells(
  platform: ShellPlatform = resolveShellPlatform(process.platform),
): ShellProfile[] {
  return SHELLS_BY_PLATFORM[platform].map((profile) => ({ ...profile }));
}

export function getDefaultProfileOrder(
  platform: ShellPlatform = resolveShellPlatform(process.platform),
): string[] {
  return [...DEFAULT_PROFILE_ORDER_BY_PLATFORM[platform]];
}

export const BUILT_IN_SHELLS = getBuiltInShells();
export const DEFAULT_PROFILE_ORDER = getDefaultProfileOrder();
