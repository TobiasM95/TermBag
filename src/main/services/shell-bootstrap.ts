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
  entryPath: string;
  cleanupPaths: string[];
  launchEnv?: NodeJS.ProcessEnv;
}

function isCmdProfile(profile: Pick<ShellProfile, "id">): boolean {
  return profile.id === "cmd";
}

function isPowerShellProfile(profile: Pick<ShellProfile, "id">): boolean {
  return profile.id === "pwsh" || profile.id === "powershell";
}

function isBashProfile(profile: Pick<ShellProfile, "id">): boolean {
  return profile.id === "bash";
}

function isZshProfile(profile: Pick<ShellProfile, "id">): boolean {
  return profile.id === "zsh";
}

function shouldCreateBootstrapAssets(
  profile: Pick<ShellProfile, "id">,
  transcriptText: string,
): boolean {
  if (isBashProfile(profile) || isZshProfile(profile)) {
    return true;
  }

  return transcriptText.length > 0;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosixShellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function createBootstrapWorkspace(baseName: string): {
  bootstrapPath: string;
  transcriptPath: string;
} {
  const bootstrapPath = path.join(BOOTSTRAP_DIR, baseName);
  fs.mkdirSync(bootstrapPath, { recursive: true });

  return {
    bootstrapPath,
    transcriptPath: path.join(bootstrapPath, "transcript.txt"),
  };
}

function buildBashBootstrapRcFile(transcriptPath: string): string {
  const quotedTranscriptPath = quotePosixShellLiteral(transcriptPath);

  return [
    `TERMBAG_TRANSCRIPT_PATH=${quotedTranscriptPath}`,
    "if [ -f /etc/profile ]; then . /etc/profile; fi",
    'if [ -f "$HOME/.bash_profile" ]; then',
    '  . "$HOME/.bash_profile"',
    'elif [ -f "$HOME/.bash_login" ]; then',
    '  . "$HOME/.bash_login"',
    'elif [ -f "$HOME/.profile" ]; then',
    '  . "$HOME/.profile"',
    "fi",
    'if [ -f "$HOME/.bashrc" ]; then',
    '  . "$HOME/.bashrc"',
    "fi",
    "termbag_emit_osc() {",
    "  printf '\\033]633;%s=%s\\a' \"$1\" \"$2\"",
    "}",
    "__termbag_hooks_ready=0",
    "__termbag_in_prompt=0",
    "__termbag_last_command=''",
    "__termbag_preexec() {",
    '  if [ "$__termbag_hooks_ready" -ne 1 ] || [ "$__termbag_in_prompt" -eq 1 ]; then',
    "    return",
    "  fi",
    '  local command_text="${BASH_COMMAND-}"',
    '  case "$command_text" in',
    "    ''|__termbag_prompt_command|__termbag_preexec)",
    "      return",
    "      ;;",
    "  esac",
    '  if [ "$command_text" = "$__termbag_last_command" ]; then',
    "    return",
    "  fi",
    '  __termbag_last_command="$command_text"',
    '  if [ -n "${command_text//[[:space:]]/}" ]; then',
    '    termbag_emit_osc TermBagCommand "$command_text"',
    "  fi",
    "}",
    "__termbag_prompt_command() {",
    "  __termbag_in_prompt=1",
    '  termbag_emit_osc TermBagCwd "$PWD"',
    "  termbag_emit_osc TermBagPrompt ready",
    "  __termbag_last_command=''",
    "  __termbag_in_prompt=0",
    "}",
    "trap '__termbag_preexec' DEBUG",
    'if [ -n "${PROMPT_COMMAND-}" ]; then',
    '  PROMPT_COMMAND="__termbag_prompt_command;${PROMPT_COMMAND}"',
    "else",
    '  PROMPT_COMMAND="__termbag_prompt_command"',
    "fi",
    'if [ -f "$TERMBAG_TRANSCRIPT_PATH" ]; then',
    '  cat -- "$TERMBAG_TRANSCRIPT_PATH"',
    "fi",
    "__termbag_hooks_ready=1",
    "",
  ].join("\n");
}

function buildZshBootstrapRcFile(transcriptPath: string): string {
  const quotedTranscriptPath = quotePosixShellLiteral(transcriptPath);

  return [
    `TERMBAG_TRANSCRIPT_PATH=${quotedTranscriptPath}`,
    'if [ -f "$HOME/.zshrc" ]; then',
    '  . "$HOME/.zshrc"',
    "fi",
    "autoload -Uz add-zsh-hook",
    "termbag_emit_osc() {",
    "  printf '\\033]633;%s=%s\\a' \"$1\" \"$2\"",
    "}",
    "termbag_precmd() {",
    '  termbag_emit_osc TermBagCwd "$PWD"',
    "  termbag_emit_osc TermBagPrompt ready",
    "}",
    "termbag_preexec() {",
    '  local command_text="$1"',
    '  if [[ -n "${command_text//[[:space:]]/}" ]]; then',
    '    termbag_emit_osc TermBagCommand "$command_text"',
    "  fi",
    "}",
    "add-zsh-hook precmd termbag_precmd",
    "add-zsh-hook preexec termbag_preexec",
    'if [ -f "$TERMBAG_TRANSCRIPT_PATH" ]; then',
    '  cat -- "$TERMBAG_TRANSCRIPT_PATH"',
    "fi",
    "",
  ].join("\n");
}

function buildZshBootstrapDotfile(originalFileName: string): string {
  return [
    `if [ -f "$HOME/${originalFileName}" ]; then`,
    `  . "$HOME/${originalFileName}"`,
    "fi",
    "",
  ].join("\n");
}

export function cleanupStaleBootstrapFiles(): void {
  fs.mkdirSync(BOOTSTRAP_DIR, { recursive: true });

  const cutoff = Date.now() - STALE_BOOTSTRAP_AGE_MS;
  for (const entry of fs.readdirSync(BOOTSTRAP_DIR, { withFileTypes: true })) {
    if (!entry.name.startsWith("termbag-")) {
      continue;
    }

    const fullPath = path.join(BOOTSTRAP_DIR, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.mtimeMs < cutoff) {
        fs.rmSync(fullPath, { recursive: true, force: true });
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
  if (!shouldCreateBootstrapAssets(profile, bootstrapTranscriptText)) {
    return null;
  }

  fs.mkdirSync(BOOTSTRAP_DIR, { recursive: true });

  const baseName = `termbag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { bootstrapPath, transcriptPath } = createBootstrapWorkspace(baseName);
  fs.writeFileSync(transcriptPath, bootstrapTranscriptText, "utf8");

  if (isCmdProfile(profile)) {
    const scriptPath = path.join(bootstrapPath, "bootstrap.bat");
    fs.writeFileSync(scriptPath, buildCmdBootstrapScript(transcriptPath), "utf8");
    return {
      transcriptPath,
      entryPath: scriptPath,
      cleanupPaths: [bootstrapPath],
    };
  }

  if (isPowerShellProfile(profile)) {
    const scriptPath = path.join(bootstrapPath, "bootstrap.ps1");
    fs.writeFileSync(scriptPath, buildPowerShellBootstrapFile(transcriptPath), "utf8");
    return {
      transcriptPath,
      entryPath: scriptPath,
      cleanupPaths: [bootstrapPath],
    };
  }

  if (isBashProfile(profile)) {
    const rcPath = path.join(bootstrapPath, ".bashrc");
    fs.writeFileSync(rcPath, buildBashBootstrapRcFile(transcriptPath), "utf8");
    return {
      transcriptPath,
      entryPath: rcPath,
      cleanupPaths: [bootstrapPath],
    };
  }

  if (isZshProfile(profile)) {
    fs.writeFileSync(path.join(bootstrapPath, ".zshenv"), buildZshBootstrapDotfile(".zshenv"), "utf8");
    fs.writeFileSync(
      path.join(bootstrapPath, ".zprofile"),
      buildZshBootstrapDotfile(".zprofile"),
      "utf8",
    );
    fs.writeFileSync(path.join(bootstrapPath, ".zshrc"), buildZshBootstrapRcFile(transcriptPath), "utf8");
    fs.writeFileSync(path.join(bootstrapPath, ".zlogin"), buildZshBootstrapDotfile(".zlogin"), "utf8");
    return {
      transcriptPath,
      entryPath: bootstrapPath,
      cleanupPaths: [bootstrapPath],
      launchEnv: {
        ZDOTDIR: bootstrapPath,
      },
    };
  }

  return null;
}

export function getBootstrapTranscriptText(
  profile: Pick<ShellProfile, "id">,
  transcriptText: string,
): string {
  if (!transcriptText) {
    return "";
  }

  if (!isCmdProfile(profile)) {
    return transcriptText;
  }

  return transcriptText.replace(/(?:\r\n|\n)$/, "");
}

export function cleanupBootstrapAssets(paths: string[]): void {
  for (const filePath of paths) {
    try {
      fs.rmSync(filePath, { recursive: true, force: true });
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

export { buildBashBootstrapRcFile, buildZshBootstrapRcFile };
