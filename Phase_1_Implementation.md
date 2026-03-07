# TermBag Phase 1 Implementation Guide

This document is the canonical Phase 1 specification for TermBag.

The goal is to ship a lightweight terminal workspace around normal shells, with project organization, automatic persistence, and lazy restore, without turning v1 into a full IDE or task runner.

## Product Definition

TermBag is a Windows-first Electron desktop app that:

- groups terminal tabs by project
- launches normal shells as the execution engine
- auto-persists project and terminal state locally
- restores prior terminal snapshots and reopens fresh shells in the last known working directory
- adds app-managed command history without breaking native shell behavior

Restore in v1 means:

- show the previously saved terminal snapshot immediately
- start a fresh shell afterward
- resume in the last known cwd if it still exists

Restore in v1 does not mean:

- resuming the original process
- restoring shell variables or process state
- restoring the alternate screen state of TUIs

## Locked Product Decisions

These decisions are fixed for Phase 1 and should not be reopened during implementation unless a hard technical blocker appears.

### Platform and shell scope

- Phase 1 targets Windows only.
- The app should still be structured so shell handling and path logic can be generalized later.
- Built-in shell profiles for v1 are:
  - `pwsh`
  - `powershell.exe`
  - `cmd.exe`
- New projects default to:
  - `pwsh` if available
  - otherwise `powershell.exe`
  - otherwise `cmd.exe`
- Custom shell definitions are out of scope for v1.

### History UX

- Native `Up` and `Down` remain owned by the shell.
- App-managed history is opened through a lightweight overlay on `Ctrl+Shift+R`.
- The overlay is project-scoped, not global.
- Selecting a history entry inserts or replaces the tracked prompt buffer only when the app is confident that the current terminal state is safe to edit.
- No reverse-search panel, heavy history browser, or full history management UI in v1.

### Persistence and privacy

- Persistence is always on in v1.
- There is no private-project or private-tab mode yet.
- Commands and terminal snapshots are stored locally.
- The UI and docs must say this clearly.

### Tab lifecycle

- Opening a project restores the saved tabs visually immediately from persisted snapshots.
- Only the selected tab respawns a live shell immediately.
- Other restored tabs remain dormant snapshots until the user selects them.
- Once a tab has been started during the current app session, it stays live in the background until:
  - the user closes the tab
  - the app exits
- Switching projects does not tear down already live tabs.

## Phase 1 Scope

### Must have

- create, edit, and delete projects
- project list in a left sidebar
- terminal tabs in the main area for the selected project
- one or more terminal tabs per project
- built-in shell profile selection per project
- local persistence of projects, tabs, command history, cwd, and terminal snapshots
- lazy restore per project
- project-scoped command history overlay
- clear visual divider between restored content and live output
- graceful handling when a shell exits or fails to start

### Explicitly out of scope

- split panes
- tasks
- favorites
- global history browser
- search panel
- remote sessions
- collaboration or sync
- custom shell profile editing
- true process resurrection
- alternate-screen snapshot restore

## UX and Behavior Rules

### Projects

Each project has:

- `id`
- `name`
- `rootPath`
- `shellProfileId`
- `createdAt`
- `updatedAt`

The sidebar lists projects only. Tabs are shown only after a project is selected.

### Terminal tabs

Persisted tab state is a saved workspace concept, not a running process identity.

Each saved tab has:

- `id`
- `projectId`
- `shellProfileId`
- `title`
- `restoreOrder`
- `lastKnownCwd`
- `wasOpen`
- `lastActivatedAt`
- `createdAt`
- `updatedAt`

Tabs should default their title from the cwd basename or shell label until better title logic exists. Manual tab renaming is not required in v1.

### Live terminal instances

Live process state is runtime-only and must not be persisted as if it were resumable.

Track runtime state separately for active PTYs, including:

- tab id
- PTY pid or handle
- started flag
- exit state
- alternate-screen state
- prompt-tracking validity
- current tracked input buffer

### Restore behavior

When a project opens:

1. Load the project record.
2. Load saved tabs in restore order.
3. Render each tab with its last saved snapshot immediately.
4. Respawn a shell only for the selected tab.
5. Leave other tabs dormant until selected.

When a dormant tab is first selected:

1. Render its saved snapshot if not already visible.
2. Spawn a fresh shell in `lastKnownCwd` if valid.
3. Otherwise fall back to the project root.

When a live tab already exists for the current app session:

- reuse the existing PTY and terminal state
- do not destroy and recreate it on project switch

### Path fallback behavior

If `lastKnownCwd` does not exist:

- fall back to `rootPath`

If `rootPath` does not exist:

- keep the project visible in the sidebar
- show an error state in the main area
- block PTY spawn for that project until the path is corrected

### History capture behavior

History entries are project-scoped with optional tab metadata.

Each history entry has:

- `id`
- `projectId`
- `tabId` nullable
- `shellProfileId`
- `cwd` nullable
- `commandText`
- `source`
- `createdAt`

Allowed `source` values:

- `integration`
- `input_capture`
- `heuristic`

History capture rules for v1:

- record entries on submit only
- do not try to maintain a full semantic model of shell editing
- if the app-side buffer becomes invalid, stop capture until prompt tracking is trustworthy again
- do not promise reliable multiline reconstruction in v1
- do not capture while the terminal is in alternate-screen mode

### History recall behavior

The history overlay:

- opens with `Ctrl+Shift+R`
- shows project history ordered newest first
- may bias same-tab entries visually, but retrieval is still project-scoped
- inserts a selected command only when prompt tracking is valid
- does nothing if the terminal is in an unsafe editing state

Native shell history remains untouched on plain `Up` and `Down`.

## Architecture

### App structure

- Electron main process owns:
  - window lifecycle
  - PTY lifecycle
  - SQLite access
  - IPC handlers
- Preload exposes a typed, minimal API surface to the renderer.
- Renderer uses React, TypeScript, Zustand, and xterm.js.

Security baseline:

- `contextIsolation: true`
- `nodeIntegration: false`
- no direct Node access in the renderer

### PTY hosting

- Use `node-pty` for shell hosting.
- Use xterm.js for terminal rendering.
- The renderer forwards user input through IPC to the PTY owner.
- The main process streams PTY output back to the renderer and also uses the same stream for persistence updates.

### Persistence

Use SQLite with migrations from day one.

Required persisted entities:

- `projects`
- `shell_profiles`
- `saved_terminal_tabs`
- `history_entries`
- `terminal_snapshots`

Do not store `lastTranscript` as an unbounded field on the tab row.

Instead:

- store snapshots separately
- cap each snapshot at:
  - 3,000 lines
  - or 1 MiB serialized size
  - whichever limit is reached first

Snapshot rules:

- persist main-buffer snapshots only
- do not persist alternate-screen contents
- update on a short debounce while output is flowing
- update again on tab close and app shutdown

### Shell integration strategy

Shell integration is session-local only.

Do not:

- modify user dotfiles
- modify user PowerShell profiles permanently
- install anything globally

Support tiers in v1:

- `pwsh` and `powershell.exe`
  - preferred path
  - use session-local integration for prompt and cwd signals
- `cmd.exe`
  - fallback path
  - use input capture and simple cwd heuristics

Heuristic cwd updates for fallback shells may recognize:

- `cd`
- `cd /d`

Do not over-promise cwd accuracy for `cmd.exe`.

## Data Model Summary

### Project

- `id`
- `name`
- `rootPath`
- `shellProfileId`
- `createdAt`
- `updatedAt`

### ShellProfile

- `id`
- `label`
- `executable`
- `argsJson`
- `platform`
- `supportsIntegration`
- `sortOrder`

### SavedTerminalTab

- `id`
- `projectId`
- `shellProfileId`
- `title`
- `restoreOrder`
- `lastKnownCwd`
- `wasOpen`
- `lastActivatedAt`
- `createdAt`
- `updatedAt`

### TerminalSnapshot

- `tabId`
- `serializedBuffer`
- `lineCount`
- `byteCount`
- `updatedAt`

### HistoryEntry

- `id`
- `projectId`
- `tabId` nullable
- `shellProfileId`
- `cwd` nullable
- `commandText`
- `source`
- `createdAt`

## Failure and Edge-Case Rules

- If shell spawn fails, show the error in the tab instead of crashing the app.
- If a shell exits normally, keep the tab and allow the user to reopen or close it.
- If prompt tracking becomes invalid, disable app-history insertion until validity is re-established.
- If the snapshot cap is exceeded, truncate older content and keep the newest retained window.
- If shell integration is unavailable, the shell still works; only tracking quality degrades.

## Implementation Order

1. Create the Electron, renderer, preload, and TypeScript scaffold.
2. Define shared types and SQLite schema with migrations.
3. Implement project CRUD and built-in shell profile discovery.
4. Implement one end-to-end live terminal tab with xterm.js and node-pty.
5. Add saved tab persistence and snapshot persistence.
6. Add lazy restore and restored-content divider.
7. Add project-scoped history capture and `Ctrl+Shift+R` overlay.
8. Add session-local PowerShell integration and `cmd.exe` fallback heuristics.
9. Add failure states and UX polish.

## Acceptance Criteria

Phase 1 is complete when all of the following are true:

- A user can create a project and open terminal tabs inside it.
- Closing and reopening the app restores the project list and saved tabs.
- Opening a project shows prior terminal snapshots immediately.
- Only the selected restored tab respawns a shell automatically.
- Switching projects does not kill already live tabs.
- A restored tab resumes in the last known cwd if it still exists.
- `Ctrl+Shift+R` opens project command history without stealing native `Up` and `Down`.
- PowerShell-based shells provide better prompt and cwd tracking than `cmd.exe`, but all built-in shells remain usable.
- Snapshot growth stays bounded.
- Missing paths and shell failures are handled explicitly in the UI.

## Notes for Implementation

- Keep the code boring and explicit. This app lives or dies on trustworthy behavior, not on ambitious features.
- If a later idea conflicts with the terminal feeling native, the native terminal behavior wins in v1.
