import path from "node:path";

export interface ParsedIntegrationChunk {
  sanitized: string;
  cwdSignals: string[];
  promptSignals: string[];
  enteredAlternateScreen: boolean;
  exitedAlternateScreen: boolean;
}

const OSC_CWD_REGEX = /\u001b]633;TermBagCwd=([^\u0007]*)\u0007/g;
const OSC_PROMPT_REGEX = /\u001b]633;TermBagPrompt=([^\u0007]*)\u0007/g;
const ALT_SCREEN_ENTER = /\u001b\[\?1049h/g;
const ALT_SCREEN_EXIT = /\u001b\[\?1049l/g;

export function buildPowerShellBootstrapScript(): string {
  return [
    "$script:__TermBagOriginalPrompt = (Get-Command prompt).ScriptBlock",
    "function global:prompt {",
    "  $cwd = [Uri]::EscapeDataString((Get-Location).Path)",
    "  $esc = [char]27",
    "  $bel = [char]7",
    "  Write-Host ($esc + ']633;TermBagCwd=' + $cwd + $bel) -NoNewline",
    "  Write-Host ($esc + ']633;TermBagPrompt=ready' + $bel) -NoNewline",
    "  & $script:__TermBagOriginalPrompt",
    "}",
  ].join("; ");
}

export function parseIntegrationChunk(chunk: string): ParsedIntegrationChunk {
  const cwdSignals: string[] = [];
  const promptSignals: string[] = [];
  let sanitized = chunk.replace(OSC_CWD_REGEX, (_match, cwd) => {
    cwdSignals.push(decodeURIComponent(cwd));
    return "";
  });
  sanitized = sanitized.replace(OSC_PROMPT_REGEX, (_match, prompt) => {
    promptSignals.push(prompt);
    return "";
  });

  const enteredAlternateScreen = ALT_SCREEN_ENTER.test(chunk);
  const exitedAlternateScreen = ALT_SCREEN_EXIT.test(chunk);

  sanitized = sanitized.replace(ALT_SCREEN_ENTER, "");
  sanitized = sanitized.replace(ALT_SCREEN_EXIT, "");

  return {
    sanitized,
    cwdSignals,
    promptSignals,
    enteredAlternateScreen,
    exitedAlternateScreen,
  };
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
