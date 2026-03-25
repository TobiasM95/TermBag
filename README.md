# TermBag

TermBag is a desktop app for keeping terminal work organized by project without turning the terminal into a full IDE.

It groups tabs under projects, remembers what you were working on, restores visible history on restart, and keeps the actual shell experience front and center.

## Screenshots

### Dark Theme

![TermBag dark theme](build/main-view-dark.png)

### Light Theme

![TermBag light theme](build/main-view-light.png)

## Current Status

This repository currently contains the **Phase 1** implementation.

Phase 1 is focused on:

- project-based terminal workspaces
- multiple shell tabs per project
- local persistence
- lazy restore
- project-scoped command recall
- a usable desktop UI for daily local terminal work

Phase 1 is already implemented and currently builds and tests successfully.

## What TermBag Does

- Create, edit, and delete projects
- Open multiple tabs per project
- Choose a default shell per project
- Open new tabs with either the project default shell or a different shell
- Persist projects, tabs, terminal history snapshots, cwd state, and command history locally
- Restore saved terminal history directly into fresh shell sessions on app restart
- Reopen the last selected project and the last active tab per project
- Keep terminal focus on app start and on project switch
- Provide project-scoped command recall with `Ctrl+Shift+R`
- Support a custom title bar with the current project name and tab strip
- Persist UI state such as sidebar collapse, theme, tab alignment, project ordering, and window size/maximized state

## Phase 1 Shell Support

Built-in shell profiles depend on the platform:

- Windows: `pwsh`, `powershell.exe`, `cmd.exe`
- macOS: `zsh`, `bash`, `pwsh` if it is installed

Behavior today:

- PowerShell, Zsh, and Bash use session-local prompt and cwd integration
- `cmd.exe` uses fallback heuristics for cwd and prompt tracking
- history restore works by printing persisted transcript history into the real fresh shell on startup

That last point matters: Phase 1 does **not** resurrect the original shell process. It restores prior visible history and then starts a fresh live shell underneath it.

## What Phase 1 Does Not Include

- split panes
- tasks
- remote sessions
- sync
- collaboration
- user-defined custom shell profiles
- true process resurrection
- alternate-screen/TUI restoration

## Tech Stack

- Electron
- React
- TypeScript
- Zustand
- xterm.js
- node-pty
- SQLite via `better-sqlite3`
- Vite
- Vitest

## Project Structure

```text
src/
  main/        Electron main process, PTY lifecycle, persistence, shell startup
  preload/     Typed preload bridge
  renderer/    React UI, Zustand store, xterm integration
  shared/      Shared types and pure logic
  types/       Local type declarations
build/         App icon assets
```

Key files:

- `src/main/index.ts`
- `src/main/services/app-service.ts`
- `src/main/services/database.ts`
- `src/main/services/pty-manager.ts`
- `src/main/services/shell-bootstrap.ts`
- `src/renderer/App.tsx`
- `src/renderer/components/TerminalPane.tsx`
- `src/renderer/store/app-store.ts`

## Local Persistence

TermBag is local-first in Phase 1.

It stores the following on the local machine:

- projects
- saved tabs
- tab metadata
- project command history
- terminal transcript snapshots
- remembered UI state
- remembered window state

SQLite database location:

- Electron `app.getPath("userData")`
- file name: `termbag.sqlite`

## Restore Model

When you reopen the app:

1. TermBag restores projects and tabs from SQLite.
2. It restores the previously selected project.
3. It restores the last active tab for each project.
4. A saved transcript is printed into a fresh shell session on startup.
5. The restored tab becomes a normal live shell again.

When a tab is already alive during the current app session, TermBag reuses the live PTY/runtime rather than treating it as a cold restore.

## Development Requirements

Recommended environment:

- Windows or macOS
- Node.js 22+
- `pnpm`
- Visual Studio 2022 Build Tools or Visual Studio 2022 with C++ support on Windows
- Xcode Command Line Tools on macOS

Native modules in this repo:

- `better-sqlite3`
- `node-pty`

Those must be rebuilt against Electron's ABI.

Platform-specific notes:

- Windows: install `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)` if `node-pty` rebuilds fail with `MSB8040`
- macOS: install the Xcode Command Line Tools before rebuilding native modules

## Running Locally

Install dependencies:

```powershell
pnpm install
```

If needed, rerun the native Electron rebuild manually:

```powershell
pnpm run rebuild:native
```

Start the app in development mode:

```powershell
pnpm dev
```

Build the app:

```powershell
pnpm build
```

Run the built app locally:

```powershell
pnpm preview
```

Run tests:

```powershell
pnpm test
```

Build Windows packages:

```powershell
pnpm package:win
```

Create an unpacked Windows build for quick validation:

```powershell
pnpm package:win:dir
```

Build macOS packages on a Mac:

```bash
pnpm package:mac
```

Create an unpacked macOS app directory for quick validation:

```bash
pnpm package:mac:dir
```

## Native Module Notes

If you see an error like:

- `was compiled against a different Node.js version`

run:

```powershell
pnpm run rebuild:native
```

If rebuild fails with `MSB8040`, install the Spectre-mitigated library component mentioned above and run the rebuild again.

## App Icon Assets

Current icon assets live in `build/`:

- `build/logo-tight.png` for the runtime/source icon
- `build/icon.ico` for Windows packaging

macOS packaging currently reuses `build/logo-tight.png`.

The Electron window currently uses the PNG icon at runtime.

## Windows Packaging

Windows packaging is configured with `electron-builder`.

Current outputs go to `release/` and include:

- NSIS installer
- portable Windows build
- unpacked app directory via `pnpm package:win:dir`

Current Windows packaging settings:

- product name: `TermBag`
- x64 targets
- Windows icon: `build/icon.ico`

## macOS Packaging

macOS packaging is also configured with `electron-builder`.

Current outputs go to `release/` and include:

- `.dmg`
- `.zip`
- unpacked app directory via `pnpm package:mac:dir`

Current macOS packaging settings:

- product name: `TermBag`
- current-architecture builds on the Mac that runs the packaging command
- packaging is unsigned by default; signing and notarization still need Apple credentials and a follow-up release setup

## Automated GitHub Release

`.github/workflows/windows-release.yml` now creates the GitHub release and uploads both Windows and macOS artifacts automatically when:

- you push the `release` branch
- you run the workflow manually from the Actions tab on the `release` branch

Before triggering it:

- bump `package.json` to a new version; the workflow publishes `v<version>` and fails if that tag already exists for a different commit
- keep the workflow file on the default branch too if you want the manual `workflow_dispatch` button to appear in GitHub's UI
- make sure GitHub Actions is allowed to write releases for the repository

The workflow builds and uploads the root `release/` artifacts, including:

- the portable `TermBag.exe`
- the NSIS installer
- generated `.blockmap` files and `latest.yml`
- the macOS `.dmg`
- the macOS `.zip`
- `latest-mac.yml` when generated by `electron-builder`

`.github/workflows/macos-validate.yml` still provides a separate unpacked macOS validation build for pull requests and manual runs.

## Manual Smoke Test

Useful quick checks after `pnpm dev` or `pnpm preview`:

1. Create a project.
2. Open multiple tabs with different shells.
3. Run a few commands.
4. Restart the app.
5. Confirm the project, tab selection, and terminal history restore correctly.
6. Press `Ctrl+Shift+R` and confirm command recall works.
7. Switch theme, collapse the sidebar, resize/maximize the window, restart, and confirm UI state persists.

## Terminal Perf Checks

For dev-only terminal perf counters:

```powershell
$env:TERMBAG_DEBUG_PERF = "1"
pnpm dev
```

Then, in the renderer devtools console, enable renderer-side counters once:

```js
localStorage.setItem("termbag-debug-perf", "1");
location.reload();
```

Useful repeatable terminal checks:

```powershell
1..5000 | ForEach-Object { "spam $_" }
```

```cmd
for /L %i in (1,1,5000) do @echo spam %i
```

For TUI validation, use a real alternate-screen app such as `vim`, `less README.md`, or `fzf` if it is installed locally.

## Known Constraints

- Alternate-screen applications are intentionally excluded from persisted terminal snapshots.
- Multiline shell editing is not fully modeled.
- `cmd.exe` tracking is heuristic-based and less precise than PowerShell, Zsh, or Bash integration.
- macOS packaging is currently unsigned and not notarized.
- There is no true shell process resurrection yet; restart restore is transcript-based.

## Roadmap Context

This repo is intentionally at the “solid terminal workspace foundation” stage.

Phase 1 is about making these parts trustworthy first:

- persistence
- restore behavior
- shell lifecycle management
- local command recall
- desktop UI ergonomics

Future phases can build on that with more advanced terminal/workspace features once this base remains stable.

## License

This project is licensed under the MIT License. See [LICENSE](/C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/LICENSE).
