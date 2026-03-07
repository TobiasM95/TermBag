import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  HistoryEntry,
  HistorySource,
  Project,
  SavedTerminalTab,
  ShellProfile,
  TerminalSnapshot,
} from "../../shared/types.js";

interface CreateProjectParams {
  id: string;
  name: string;
  rootPath: string;
  defaultShellProfileId: string;
}

interface CreateTabParams {
  id: string;
  projectId: string;
  shellProfileId: string;
  title: string;
  restoreOrder: number;
  lastKnownCwd: string | null;
}

interface SnapshotParams {
  tabId: string;
  serializedBuffer: string;
  lineCount: number;
  byteCount: number;
}

const MIGRATIONS = [
  {
    id: "001_initial",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shell_profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        executable TEXT NOT NULL,
        args_json TEXT NOT NULL,
        platform TEXT NOT NULL,
        supports_integration INTEGER NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        default_shell_profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(default_shell_profile_id) REFERENCES shell_profiles(id)
      );

      CREATE TABLE IF NOT EXISTS saved_terminal_tabs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        shell_profile_id TEXT NOT NULL,
        title TEXT NOT NULL,
        restore_order INTEGER NOT NULL,
        last_known_cwd TEXT,
        was_open INTEGER NOT NULL DEFAULT 1,
        last_activated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(shell_profile_id) REFERENCES shell_profiles(id)
      );

      CREATE TABLE IF NOT EXISTS terminal_snapshots (
        tab_id TEXT PRIMARY KEY,
        serialized_buffer TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        byte_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(tab_id) REFERENCES saved_terminal_tabs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS history_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        tab_id TEXT,
        shell_profile_id TEXT NOT NULL,
        cwd TEXT,
        command_text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(tab_id) REFERENCES saved_terminal_tabs(id) ON DELETE SET NULL,
        FOREIGN KEY(shell_profile_id) REFERENCES shell_profiles(id)
      );

      CREATE INDEX IF NOT EXISTS idx_projects_updated_at
        ON projects(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_tabs_project_restore
        ON saved_terminal_tabs(project_id, restore_order ASC);

      CREATE INDEX IF NOT EXISTS idx_history_project_created
        ON history_entries(project_id, created_at DESC);
    `,
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    defaultShellProfileId: String(row.default_shell_profile_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapShellProfile(row: Record<string, unknown>): ShellProfile {
  return {
    id: String(row.id),
    label: String(row.label),
    executable: String(row.executable),
    argsJson: String(row.args_json),
    platform: "win32",
    supportsIntegration: Boolean(row.supports_integration),
    sortOrder: Number(row.sort_order),
  };
}

function mapTab(row: Record<string, unknown>): SavedTerminalTab {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    shellProfileId: String(row.shell_profile_id),
    title: String(row.title),
    restoreOrder: Number(row.restore_order),
    lastKnownCwd: row.last_known_cwd ? String(row.last_known_cwd) : null,
    wasOpen: Boolean(row.was_open),
    lastActivatedAt: String(row.last_activated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSnapshot(row: Record<string, unknown>): TerminalSnapshot {
  return {
    tabId: String(row.tab_id),
    serializedBuffer: String(row.serialized_buffer),
    lineCount: Number(row.line_count),
    byteCount: Number(row.byte_count),
    updatedAt: String(row.updated_at),
  };
}

function mapHistory(row: Record<string, unknown>): HistoryEntry {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    tabId: row.tab_id ? String(row.tab_id) : null,
    shellProfileId: String(row.shell_profile_id),
    cwd: row.cwd ? String(row.cwd) : null,
    commandText: String(row.command_text),
    source: row.source as HistorySource,
    createdAt: String(row.created_at),
  };
}

export class DatabaseService {
  private readonly db: Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const existing = new Set(
      this.db
        .prepare("SELECT id FROM schema_migrations")
        .all()
        .map((row: unknown) => String((row as { id: unknown }).id)),
    );

    for (const migration of MIGRATIONS) {
      if (existing.has(migration.id)) {
        continue;
      }

      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("002_project_default_shell")) {
      this.db.exec("BEGIN");
      try {
        const projectColumns = new Set(this.getTableColumns("projects"));
        if (
          projectColumns.has("shell_profile_id") &&
          !projectColumns.has("default_shell_profile_id")
        ) {
          this.db.exec(
            "ALTER TABLE projects RENAME COLUMN shell_profile_id TO default_shell_profile_id",
          );
        }
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("002_project_default_shell", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private getTableColumns(tableName: string): string[] {
    return this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((row: unknown) => String((row as { name: unknown }).name));
  }

  close(): void {
    this.db.close();
  }

  upsertShellProfiles(profiles: ShellProfile[]): void {
    const statement = this.db.prepare(`
      INSERT INTO shell_profiles (
        id, label, executable, args_json, platform, supports_integration, sort_order
      ) VALUES (
        @id, @label, @executable, @args_json, @platform, @supports_integration, @sort_order
      )
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        executable = excluded.executable,
        args_json = excluded.args_json,
        platform = excluded.platform,
        supports_integration = excluded.supports_integration,
        sort_order = excluded.sort_order
    `);

    const transaction = this.db.transaction((rows: ShellProfile[]) => {
      for (const profile of rows) {
        statement.run({
          id: profile.id,
          label: profile.label,
          executable: profile.executable,
          args_json: profile.argsJson,
          platform: profile.platform,
          supports_integration: profile.supportsIntegration ? 1 : 0,
          sort_order: profile.sortOrder,
        });
      }
    });

    transaction(profiles);
  }

  listShellProfiles(): ShellProfile[] {
    const rows = this.db
      .prepare(
        `SELECT id, label, executable, args_json, platform, supports_integration, sort_order
         FROM shell_profiles
         ORDER BY sort_order ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapShellProfile);
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, root_path, default_shell_profile_id, created_at, updated_at
         FROM projects
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapProject);
  }

  getProject(projectId: string): Project | null {
    const row = this.db
      .prepare(
        `SELECT id, name, root_path, default_shell_profile_id, created_at, updated_at
         FROM projects
         WHERE id = ?`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? mapProject(row) : null;
  }

  createProject(params: CreateProjectParams): Project {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (
          id, name, root_path, default_shell_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.name,
        params.rootPath,
        params.defaultShellProfileId,
        timestamp,
        timestamp,
      );
    return this.getProject(params.id)!;
  }

  updateProject(project: Project): Project {
    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, root_path = ?, default_shell_profile_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        project.name,
        project.rootPath,
        project.defaultShellProfileId,
        nowIso(),
        project.id,
      );
    return this.getProject(project.id)!;
  }

  touchProject(projectId: string): void {
    this.db
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(nowIso(), projectId);
  }

  deleteProject(projectId: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }

  listTabsForProject(projectId: string): SavedTerminalTab[] {
    const rows = this.db
      .prepare(
        `SELECT
           id, project_id, shell_profile_id, title, restore_order,
           last_known_cwd, was_open, last_activated_at, created_at, updated_at
         FROM saved_terminal_tabs
         WHERE project_id = ?
         ORDER BY restore_order ASC, created_at ASC`,
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map(mapTab);
  }

  getTab(tabId: string): SavedTerminalTab | null {
    const row = this.db
      .prepare(
        `SELECT
           id, project_id, shell_profile_id, title, restore_order,
           last_known_cwd, was_open, last_activated_at, created_at, updated_at
         FROM saved_terminal_tabs
         WHERE id = ?`,
      )
      .get(tabId) as Record<string, unknown> | undefined;
    return row ? mapTab(row) : null;
  }

  getTabCountForProject(projectId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM saved_terminal_tabs WHERE project_id = ?")
      .get(projectId) as { count: number };
    return Number(row.count);
  }

  getMaxRestoreOrder(projectId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(restore_order), 0) AS max_restore_order FROM saved_terminal_tabs WHERE project_id = ?",
      )
      .get(projectId) as { max_restore_order: number };
    return Number(row.max_restore_order);
  }

  createTab(params: CreateTabParams): SavedTerminalTab {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO saved_terminal_tabs (
          id, project_id, shell_profile_id, title, restore_order,
          last_known_cwd, was_open, last_activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.projectId,
        params.shellProfileId,
        params.title,
        params.restoreOrder,
        params.lastKnownCwd,
        timestamp,
        timestamp,
        timestamp,
      );
    this.touchProject(params.projectId);
    return this.getTab(params.id)!;
  }

  updateTab(tab: SavedTerminalTab): SavedTerminalTab {
    this.db
      .prepare(
        `UPDATE saved_terminal_tabs
         SET shell_profile_id = ?, title = ?, restore_order = ?, last_known_cwd = ?,
             was_open = ?, last_activated_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        tab.shellProfileId,
        tab.title,
        tab.restoreOrder,
        tab.lastKnownCwd,
        tab.wasOpen ? 1 : 0,
        tab.lastActivatedAt,
        nowIso(),
        tab.id,
      );
    this.touchProject(tab.projectId);
    return this.getTab(tab.id)!;
  }

  markTabActivated(tabId: string): SavedTerminalTab {
    const tab = this.getTab(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    return this.updateTab({
      ...tab,
      lastActivatedAt: nowIso(),
      wasOpen: true,
    });
  }

  deleteTab(tabId: string): void {
    const tab = this.getTab(tabId);
    this.db.prepare("DELETE FROM saved_terminal_tabs WHERE id = ?").run(tabId);
    if (tab) {
      this.touchProject(tab.projectId);
    }
  }

  getSnapshot(tabId: string): TerminalSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT tab_id, serialized_buffer, line_count, byte_count, updated_at
         FROM terminal_snapshots
         WHERE tab_id = ?`,
      )
      .get(tabId) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : null;
  }

  upsertSnapshot(params: SnapshotParams): TerminalSnapshot {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO terminal_snapshots (
          tab_id, serialized_buffer, line_count, byte_count, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tab_id) DO UPDATE SET
          serialized_buffer = excluded.serialized_buffer,
          line_count = excluded.line_count,
          byte_count = excluded.byte_count,
          updated_at = excluded.updated_at`,
      )
      .run(
        params.tabId,
        params.serializedBuffer,
        params.lineCount,
        params.byteCount,
        timestamp,
      );
    return this.getSnapshot(params.tabId)!;
  }

  listSnapshotsForProject(projectId: string): TerminalSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT s.tab_id, s.serialized_buffer, s.line_count, s.byte_count, s.updated_at
         FROM terminal_snapshots s
         INNER JOIN saved_terminal_tabs t ON t.id = s.tab_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map(mapSnapshot);
  }

  addHistoryEntry(params: {
    id: string;
    projectId: string;
    tabId: string | null;
    shellProfileId: string;
    cwd: string | null;
    commandText: string;
    source: HistorySource;
  }): HistoryEntry {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO history_entries (
          id, project_id, tab_id, shell_profile_id, cwd, command_text, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.projectId,
        params.tabId,
        params.shellProfileId,
        params.cwd,
        params.commandText,
        params.source,
        timestamp,
      );
    return this.listHistoryForProject(params.projectId, 1)[0]!;
  }

  listHistoryForProject(projectId: string, limit = 100): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, tab_id, shell_profile_id, cwd, command_text, source, created_at
         FROM history_entries
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map(mapHistory);
  }
}
