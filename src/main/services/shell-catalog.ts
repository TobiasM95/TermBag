import { execFileSync } from "node:child_process";
import { BUILT_IN_SHELLS, DEFAULT_PROFILE_ORDER } from "../../shared/shells.js";
import { buildPowerShellBootstrapScript } from "../../shared/integration.js";
import type { ShellProfile, ShellProfileAvailability } from "../../shared/types.js";

export interface ResolvedShellLaunch {
  executable: string;
  args: string[];
  supportsIntegration: boolean;
}

export class ShellCatalog {
  private availability = new Map<string, boolean>();

  refreshAvailability(): ShellProfileAvailability[] {
    const profiles = BUILT_IN_SHELLS.map((profile) => ({
      ...profile,
      available: this.detectExecutable(profile.executable),
    }));

    this.availability = new Map(profiles.map((profile) => [profile.id, profile.available]));
    return profiles;
  }

  resolveDefaultProfileId(): string {
    for (const profileId of DEFAULT_PROFILE_ORDER) {
      if (this.availability.get(profileId)) {
        return profileId;
      }
    }

    return "cmd";
  }

  resolveLaunch(profile: ShellProfile, bootstrapScriptPath?: string): ResolvedShellLaunch {
    if (profile.id === "cmd") {
      return {
        executable: profile.executable,
        args: bootstrapScriptPath
          ? ["/Q", "/K", bootstrapScriptPath]
          : ["/Q", "/K", "chcp 65001 >nul"],
        supportsIntegration: false,
      };
    }

    return {
      executable: profile.executable,
      args: bootstrapScriptPath
        ? ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", bootstrapScriptPath]
        : ["-NoExit", "-Command", buildPowerShellBootstrapScript()],
      supportsIntegration: true,
    };
  }

  isAvailable(profileId: string): boolean {
    return this.availability.get(profileId) ?? false;
  }

  private detectExecutable(executable: string): boolean {
    try {
      execFileSync("where.exe", [executable], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}
