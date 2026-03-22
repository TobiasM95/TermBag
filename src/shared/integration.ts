import path from "node:path";

export interface ParsedIntegrationChunk {
  sanitized: string;
  cwdSignals: string[];
  promptSignals: string[];
  commandSignals: string[];
  enteredAlternateScreen: boolean;
  exitedAlternateScreen: boolean;
}

const OSC_CWD_REGEX = /\u001b]633;TermBagCwd=([^\u0007]*)\u0007/g;
const OSC_PROMPT_REGEX = /\u001b]633;TermBagPrompt=([^\u0007]*)\u0007/g;
const OSC_COMMAND_REGEX = /\u001b]633;TermBagCommand=([^\u0007]*)\u0007/g;
const ALT_SCREEN_ENTER = /\u001b\[\?(?:1049|1047|47)h/g;
const ALT_SCREEN_EXIT = /\u001b\[\?(?:1049|1047|47)l/g;
const INITIAL_TERMINAL_MARKERS = /\u001b\[\?9001h|\u001b\[\?1004h/g;
const INITIAL_TERMINAL_CLEAR =
  /\u001b\[\?25[hl](?=\u001b\[2J)|\u001b\[2J(?:\u001b\[(?:0|)m)?(?:\u001b\[H)?/g;

export function getPowerShellEncodingBootstrapLines(): string[] {
  return [
    "$script:__TermBagUtf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $script:__TermBagUtf8",
    "[Console]::OutputEncoding = $script:__TermBagUtf8",
    "$OutputEncoding = $script:__TermBagUtf8",
    "chcp.com 65001 > $null",
  ];
}

export function getPowerShellPromptBootstrapLines(): string[] {
  return [
    "$script:__TermBagOriginalPrompt = (Get-Command prompt).ScriptBlock",
    "$script:__TermBagEmitAcceptedCommand = {",
    "  param([string]$line)",
    "  if (-not [string]::IsNullOrWhiteSpace($line)) {",
    "    $encoded = [Uri]::EscapeDataString($line)",
    "    $esc = [char]27",
    "    $bel = [char]7",
    "    Write-Host ($esc + ']633;TermBagCommand=' + $encoded + $bel) -NoNewline",
    "  }",
    "  return $true",
    "}",
    "if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {",
    "  try {",
    "    Set-PSReadLineOption -AddToHistoryHandler $script:__TermBagEmitAcceptedCommand",
    "  } catch {",
    "    # Best effort only.",
    "  }",
    "}",
    "function global:prompt {",
    "  $cwd = [Uri]::EscapeDataString((Get-Location).Path)",
    "  $esc = [char]27",
    "  $bel = [char]7",
    "  Write-Host ($esc + ']633;TermBagCwd=' + $cwd + $bel) -NoNewline",
    "  Write-Host ($esc + ']633;TermBagPrompt=ready' + $bel) -NoNewline",
    "  & $script:__TermBagOriginalPrompt",
    "}",
  ];
}

export function getPowerShellBootstrapLines(): string[] {
  return [
    ...getPowerShellEncodingBootstrapLines(),
    ...getPowerShellPromptBootstrapLines(),
  ];
}

export function buildPowerShellBootstrapScript(): string {
  return getPowerShellBootstrapLines().join("\r\n");
}

export function parseIntegrationChunk(chunk: string): ParsedIntegrationChunk {
  const cwdSignals: string[] = [];
  const promptSignals: string[] = [];
  const commandSignals: string[] = [];
  let sanitized = chunk.replace(OSC_CWD_REGEX, (_match, cwd) => {
    cwdSignals.push(decodeURIComponent(cwd));
    return "";
  });
  sanitized = sanitized.replace(OSC_PROMPT_REGEX, (_match, prompt) => {
    promptSignals.push(prompt);
    return "";
  });
  sanitized = sanitized.replace(OSC_COMMAND_REGEX, (_match, command) => {
    commandSignals.push(decodeURIComponent(command));
    return "";
  });

  const enteredAlternateScreen = ALT_SCREEN_ENTER.test(chunk);
  const exitedAlternateScreen = ALT_SCREEN_EXIT.test(chunk);

  return {
    sanitized,
    cwdSignals,
    promptSignals,
    commandSignals,
    enteredAlternateScreen,
    exitedAlternateScreen,
  };
}

export function stripInitialTerminalNoise(chunk: string): string {
  return chunk
    .replace(INITIAL_TERMINAL_MARKERS, "")
    .replace(INITIAL_TERMINAL_CLEAR, "");
}

export function inferCmdPromptCwdFromOutput(
  previousCwd: string | null,
  output: string,
): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return previousCwd;
  }

  const match = /^([A-Za-z]:\\.*)>$/.exec(lastLine);
  if (!match) {
    return previousCwd;
  }

  const promptCwd = match[1];
  if (!promptCwd) {
    return previousCwd;
  }

  return path.normalize(promptCwd);
}
