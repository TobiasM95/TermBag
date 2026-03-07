export interface StartupFailure {
  title: string;
  message: string;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n\n${error.stack ?? ""}`.trim();
  }

  return String(error);
}

export function describeStartupFailure(error: unknown): StartupFailure {
  const raw = toMessage(error);

  if (
    raw.includes("compiled against a different Node.js version") ||
    raw.includes("NODE_MODULE_VERSION")
  ) {
    return {
      title: "TermBag failed to start",
      message: [
        "A native dependency was built for a different runtime ABI than Electron.",
        "",
        "Recovery:",
        "1. Run `pnpm run rebuild:native` in the project root.",
        "2. If that rebuild fails, install the required Visual Studio C++ components.",
        "",
        "This usually affects `better-sqlite3` or `node-pty`.",
        "",
        `Original error:\n${raw}`,
      ].join("\n"),
    };
  }

  if (raw.includes("MSB8040") || raw.toLowerCase().includes("spectre")) {
    return {
      title: "TermBag native toolchain is incomplete",
      message: [
        "The local Visual Studio C++ toolchain is missing the Spectre-mitigated libraries required to build `node-pty` for Electron.",
        "",
        "Install this Visual Studio component:",
        "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)",
        "",
        "Then run:",
        "`pnpm run rebuild:native`",
        "",
        `Original error:\n${raw}`,
      ].join("\n"),
    };
  }

  if (
    raw.includes("Cannot find module") &&
    (raw.includes("better_sqlite3.node") || raw.includes("node-pty"))
  ) {
    return {
      title: "TermBag native dependency is missing",
      message: [
        "A required native dependency could not be loaded.",
        "",
        "Recovery:",
        "1. Run `pnpm install --force`.",
        "2. Run `pnpm run rebuild:native`.",
        "",
        `Original error:\n${raw}`,
      ].join("\n"),
    };
  }

  return {
    title: "TermBag failed to start",
    message: raw,
  };
}
