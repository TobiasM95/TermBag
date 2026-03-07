# TermBag

TermBag is a Windows-first Electron desktop app for organizing terminal tabs by project without turning the terminal into a full IDE.

Phase 1 focuses on:

- project-based terminal workspaces
- built-in Windows shell profiles
- local persistence for projects, tabs, cwd, history, and terminal snapshots
- lazy restore of saved tabs
- project-scoped command recall with `Ctrl+Shift+R`

## Phase 1 Features

- Create, edit, and delete projects
- Left sidebar with project list
- Multiple terminal tabs per project
- Built-in shell profile selection:
  - `pwsh`
  - `powershell.exe`
  - `cmd.exe`
- SQLite-backed local persistence
- Restored snapshots shown immediately when reopening a project
- Lazy shell respawn:
  - selected restored tab starts immediately
  - other restored tabs stay dormant until selected
- Clear divider between restored snapshot content and fresh live output
- Project-scoped command history overlay on `Ctrl+Shift+R`
- PowerShell session-local prompt and cwd tracking
- `cmd.exe` fallback input and cwd heuristics
- Explicit UI states for:
  - missing project paths
  - shell startup failures
  - shell exit states

## What Phase 1 Does Not Do

- Split panes
- Tasks
- Favorites
- Global history browser
- Search panel
- Remote sessions
- Sync or collaboration
- Custom shell definitions
- True process resurrection
- Alternate-screen snapshot restore

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
  main/        Electron main process, IPC, PTY lifecycle, persistence services
  preload/     Typed preload bridge
  renderer/    React UI, Zustand store, xterm integration
  shared/      Shared types and pure logic
  types/       Local type declarations
```

Important files:

- [package.json](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/package.json)
- [src/main/index.ts](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/src/main/index.ts)
- [src/main/services/app-service.ts](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/src/main/services/app-service.ts)
- [src/main/services/database.ts](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/src/main/services/database.ts)
- [src/main/services/pty-manager.ts](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/src/main/services/pty-manager.ts)
- [src/renderer/App.tsx](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/src/renderer/App.tsx)
- [TODO.md](C:/Users/tobim/Documents/Programming/SmallProjects/TermBag/TODO.md)

## Persistence and Privacy

Persistence is always on in Phase 1.

TermBag stores the following locally on the machine:

- projects
- saved terminal tabs
- terminal snapshots
- cwd state
- project-scoped command history

SQLite database location:

- Electron `app.getPath("userData")` directory
- database file name: `termbag.sqlite`

Snapshot retention is bounded:

- max `3,000` lines
- or `1 MiB` serialized size
- newest content is retained

## Restore Behavior

When a project is reopened:

1. Saved tabs are loaded from SQLite.
2. Saved snapshots are rendered immediately.
3. Only the selected tab respawns a live shell automatically.
4. Other tabs remain dormant snapshots until selected.
5. If a live tab was already started during the current app session, it is reused.

Phase 1 restore does not resume the original process. It restores a saved snapshot, then starts a fresh shell in the best available cwd.

## Local Development

### Requirements

- Windows
- Node.js 22+
- `pnpm` 10+
- Visual Studio 2022 Build Tools or Visual Studio 2022 with C++ build support
- Windows Spectre-mitigated C++ libraries for `node-pty`

Required Visual Studio individual component for `node-pty` on Windows:

- `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`

Without that component, Electron-native rebuilds for `node-pty` fail with `MSB8040`.

### Install dependencies

```powershell
pnpm install
```

This repo also includes a postinstall native rebuild for Electron addons.

If you need to rerun it manually:

```powershell
pnpm run rebuild:native
```

### Run the app locally

```powershell
pnpm dev
```

This starts:

- TypeScript watch for Electron main
- TypeScript watch for preload
- Vite dev server for the renderer
- Electron pointed at the local Vite server

### Build for a local production-style test

```powershell
pnpm build
```

This outputs:

- renderer bundle in `dist/`
- Electron main/preload output in `dist-electron/`

### Launch the built app

```powershell
pnpm preview
```

## Native Module Notes

This app uses native modules:

- `better-sqlite3`
- `node-pty`

They must be built against Electron's ABI, not just your system Node.js ABI.

This repository includes:

- `@electron/rebuild`
- `pnpm run rebuild:native`
- a `postinstall` hook that runs the Electron rebuild automatically

If you see an error like:

- `was compiled against a different Node.js version`

run:

```powershell
pnpm run rebuild:native
```

If the rebuild fails with `MSB8040`, install the Visual Studio Spectre-mitigated library component listed above and rerun:

```powershell
pnpm run rebuild:native
```

## Testing

Run the automated test suite:

```powershell
pnpm test
```

Current tests cover pure logic around:

- snapshot retention
- PowerShell integration marker parsing
- `cmd.exe` cwd heuristics
- prompt tracking state

## Manual Smoke Test Checklist

Use this after `pnpm dev` or `pnpm preview`.

1. Create a project with a valid local folder path.
2. Confirm an initial tab is created automatically.
3. Run a few commands and confirm output appears normally.
4. Open a second tab and confirm both tabs remain available.
5. Press `Ctrl+Shift+R` and confirm project history opens.
6. Select a history entry when the shell is at a normal prompt and confirm it is inserted.
7. Close and reopen the app.
8. Confirm the project list and saved tabs return.
9. Confirm prior snapshot content appears immediately.
10. Confirm only the selected restored tab starts live immediately.
11. Change a project path to a missing folder and confirm the UI blocks shell startup with an explicit error state.
12. Exit a shell and confirm the tab remains visible with a reopen action.

## Shell Notes

Shell profile defaults:

- prefer `pwsh`
- otherwise `powershell.exe`
- otherwise `cmd.exe`

Tracking quality:

- `pwsh` and `powershell.exe` use session-local prompt and cwd integration
- `cmd.exe` falls back to input capture and simple cwd heuristics

TermBag does not modify user dotfiles, PowerShell profiles, or global shell configuration.

## Known Constraints

- Phase 1 is Windows-only.
- Alternate-screen content is not restored.
- Multiline shell editing is not modeled reliably.
- History insertion only happens when prompt tracking is considered safe.
- Native shell `Up` and `Down` behavior is intentionally left untouched.

## Scripts

```json
{
  "dev": "Start renderer, Electron main/preload watchers, and the Electron app",
  "build": "Build Electron main/preload and renderer for production",
  "preview": "Launch the built Electron app",
  "test": "Run Vitest"
}
```

## Status

Phase 1 implementation is present in this repository and currently builds and tests successfully with `pnpm`.
