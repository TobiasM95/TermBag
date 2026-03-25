import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShellProfile } from "../../shared/types.js";
import {
  getPowerShellEncodingBootstrapLines,
  getPowerShellPromptBootstrapLines,
} from "../../shared/integration.js";

const BOOTSTRAP_DIR = path.join(os.tmpdir(), "termbag-bootstrap");
const STALE_BOOTSTRAP_AGE_MS = 1000 * 60 * 60 * 24;

export interface ShellBootstrapAssets {
  transcriptPath: string;
  scriptPath: string;
  cleanupPaths: string[];
}

export function cleanupStaleBootstrapFiles(): void {
  fs.mkdirSync(BOOTSTRAP_DIR, { recursive: true });

  const cutoff = Date.now() - STALE_BOOTSTRAP_AGE_MS;
  for (const entry of fs.readdirSync(BOOTSTRAP_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("termbag-")) {
      continue;
    }

    const fullPath = path.join(BOOTSTRAP_DIR, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.mtimeMs < cutoff) {
        fs.rmSync(fullPath, { force: true });
      }
    } catch {
      // Best effort only.
    }
  }
}

export function createShellBootstrapAssets(
  profile: ShellProfile,
  transcriptText: string,
): ShellBootstrapAssets | null {
  const bootstrapTranscriptText = getBootstrapTranscriptText(profile, transcriptText);
  if (!bootstrapTranscriptText) {
    return null;
  }

  fs.mkdirSync(BOOTSTRAP_DIR, { recursive: true });

  const baseName = `termbag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const transcriptPath = path.join(BOOTSTRAP_DIR, `${baseName}.txt`);
  const scriptPath = path.join(
    BOOTSTRAP_DIR,
    `${baseName}${profile.id === "cmd" ? ".bat" : ".ps1"}`,
  );

  fs.writeFileSync(transcriptPath, bootstrapTranscriptText, "utf8");
  fs.writeFileSync(
    scriptPath,
    profile.id === "cmd"
      ? buildCmdBootstrapScript(transcriptPath)
      : buildPowerShellBootstrapFile(transcriptPath),
    "utf8",
  );

  return {
    transcriptPath,
    scriptPath,
    cleanupPaths: [transcriptPath, scriptPath],
  };
}

export function getBootstrapTranscriptText(
  profile: Pick<ShellProfile, "id">,
  transcriptText: string,
): string {
  if (!transcriptText) {
    return "";
  }

  if (profile.id !== "cmd") {
    return transcriptText;
  }

  return transcriptText.replace(/(?:\r\n|\n)$/, "");
}

export function cleanupBootstrapAssets(paths: string[]): void {
  for (const filePath of paths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

export function buildCmdBootstrapScript(transcriptPath: string): string {
  return [
    "@echo off",
    "@chcp 65001 >nul",
    `if exist "${transcriptPath}" type "${transcriptPath}"`,
  ].join("\r\n");
}

export function buildPowerShellBootstrapFile(transcriptPath: string): string {
  const quotedPath = quotePowerShellLiteral(transcriptPath);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    ...getPowerShellEncodingBootstrapLines(),
    `$TranscriptPath = ${quotedPath}`,
    "if (Test-Path -LiteralPath $TranscriptPath) {",
    "  $text = [System.IO.File]::ReadAllText($TranscriptPath, [System.Text.Encoding]::UTF8)",
    "  if ($text.Length -gt 0) {",
    "    [Console]::Write($text)",
    "  }",
    "}",
    ...getPowerShellPromptBootstrapLines(),
    "",
  ].join("\r\n");
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
