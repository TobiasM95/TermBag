# TermBag Phase 1 TODO

## Status

- [x] Read `Phase_1_Implementation.md`
- [x] Scaffold Electron + React + TypeScript app structure
- [x] Define shared types and IPC contracts
- [x] Add SQLite schema and migration runner
- [x] Implement built-in shell profile discovery
- [x] Implement project CRUD persistence
- [x] Implement saved tab persistence
- [x] Implement PTY lifecycle management with lazy start
- [x] Implement bounded terminal snapshot persistence
- [x] Implement session-local shell integration hooks
- [x] Implement project-scoped history capture and recall
- [x] Build renderer UI for projects, tabs, and terminal states
- [x] Add restored snapshot divider and dormant-tab UX
- [x] Handle missing paths, shell start failures, and shell exits
- [x] Add tests for pure logic
- [x] Run install, build, and tests
- [x] Final pass on docs and polish

## Notes

- Persistence is always on in Phase 1 and must be called out in the UI.
- Restored tabs must render saved snapshot content immediately.
- Only the selected restored tab should spawn automatically.
