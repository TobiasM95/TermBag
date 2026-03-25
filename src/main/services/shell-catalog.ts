import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getBuiltInShells,
  getDefaultProfileOrder,
  resolveShellPlatform,
} from "../../shared/shells.js";
import { buildPowerShellBootstrapScript } from "../../shared/integration.js";
import type { ShellProfile, ShellProfileAvailability } from "../../shared/types.js";
import type { ShellBootstrapAssets } from "./shell-bootstrap.js";

export interface ResolvedShellLaunch {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  supportsIntegration: boolean;
}

export class ShellCatalog {
  private availability = new Map<string, boolean>();

  refreshAvailability(): ShellProfileAvailability[] {
    const profiles = getBuiltInShells(resolveShellPlatform(process.platform)).map((profile) => ({
      ...profile,
      available: this.detectExecutable(profile.executable),
    }));

    this.availability = new Map(profiles.map((profile) => [profile.id, profile.available]));
    return profiles;
  }

  resolveDefaultProfileId(): string {
    const defaultProfileOrder = getDefaultProfileOrder(resolveShellPlatform(process.platform));
    for (const profileId of defaultProfileOrder) {
      if (this.availability.get(profileId)) {
        return profileId;
      }
    }

    return defaultProfileOrder[0] ?? "bash";
  }

  resolveLaunch(profile: ShellProfile, bootstrap?: ShellBootstrapAssets | null): ResolvedShellLaunch {
    if (profile.id === "cmd") {
      return {
        executable: profile.executable,
        args: bootstrap?.entryPath
          ? ["/Q", "/K", bootstrap.entryPath]
          : ["/Q", "/K", "chcp 65001 >nul"],
        supportsIntegration: false,
      };
    }

    if (profile.id === "zsh") {
      return {
        executable: profile.executable,
        args: ["-il"],
        env: bootstrap?.launchEnv,
        supportsIntegration: true,
      };
    }

    if (profile.id === "bash") {
      return {
        executable: profile.executable,
        args: bootstrap?.entryPath ? ["--rcfile", bootstrap.entryPath, "-i"] : ["-i"],
        supportsIntegration: true,
      };
    }

    return {
      executable: profile.executable,
      args: bootstrap?.entryPath
        ? ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", bootstrap.entryPath]
        : ["-NoExit", "-Command", buildPowerShellBootstrapScript()],
      supportsIntegration: true,
    };
  }

  isAvailable(profileId: string): boolean {
    return this.availability.get(profileId) ?? false;
  }

  private detectExecutable(executable: string): boolean {
    if (path.isAbsolute(executable)) {
      return fs.existsSync(executable);
    }

    try {
      execFileSync(
        process.platform === "win32" ? "where.exe" : "which",
        [executable],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  }
}
