import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createSingleLeafLayout } from "../../shared/layout.js";
import { parseStoredSessionBorderColor } from "../../shared/session-colors.js";
import { SNAPSHOT_FORMAT } from "../../shared/snapshot.js";
import type {
  HistoryEntry,
  HistorySource,
  PersistedTabLayout,
  Project,
  SavedTerminalSession,
  SavedWorkspaceTab,
  ShellProfile,
  TemplateTab,
  TerminalSnapshot,
  WorkspaceTemplate,
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
  title: string;
  customTitle: string | null;
  restoreOrder: number;
  layout: PersistedTabLayout;
  focusedSessionId: string;
}

interface CreateSessionParams {
  id: string;
  tabId: string;
  shellProfileId: string;
  lastKnownCwd: string | null;
  borderColor?: string | null;
  sessionOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

interface SnapshotParams {
  sessionId: string;
  snapshotFormat: string;
  transcriptText: string;
  serializedState: string;
  viewportOffsetFromBottom: number;
  byteCount: number;
}

interface CreateTemplateParams {
  id: string;
  name: string;
  tabs: TemplateTab[];
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
        custom_title TEXT,
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
        snapshot_format TEXT NOT NULL,
        transcript_text TEXT NOT NULL,
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

function parseLayout(
  rawValue: unknown,
  fallbackSessionId: string,
): PersistedTabLayout {
  if (typeof rawValue === "string" && rawValue.trim()) {
    try {
      const parsed = JSON.parse(rawValue) as PersistedTabLayout;
      if (parsed?.version === 1 && parsed.root) {
        return parsed;
      }
    } catch {
      // Fall back to a valid single-leaf layout.
    }
  }

  return createSingleLeafLayout(fallbackSessionId, `${fallbackSessionId}:root`);
}

function mapTab(row: Record<string, unknown>): SavedWorkspaceTab {
  const focusedSessionId = String(row.focused_session_id);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    customTitle: row.custom_title ? String(row.custom_title) : null,
    restoreOrder: Number(row.restore_order),
    layout: parseLayout(row.layout_json, focusedSessionId),
    focusedSessionId,
    wasOpen: Boolean(row.was_open),
    lastActivatedAt: String(row.last_activated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSession(row: Record<string, unknown>): SavedTerminalSession {
  return {
    id: String(row.id),
    tabId: String(row.tab_id),
    shellProfileId: String(row.shell_profile_id),
    lastKnownCwd: row.last_known_cwd ? String(row.last_known_cwd) : null,
    borderColor: parseStoredSessionBorderColor(row.session_border_color),
    sessionOrder: Number(row.session_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSnapshot(row: Record<string, unknown>): TerminalSnapshot {
  return {
    sessionId: String(row.session_id),
    snapshotFormat: String(row.snapshot_format) as TerminalSnapshot["snapshotFormat"],
    transcriptText: String(row.transcript_text),
    serializedState: row.serialized_state ? String(row.serialized_state) : "",
    viewportOffsetFromBottom: Number(row.viewport_offset_from_bottom ?? 0),
    byteCount: Number(row.byte_count),
    updatedAt: String(row.updated_at),
  };
}

function mapHistory(row: Record<string, unknown>): HistoryEntry {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    tabId: row.tab_id ? String(row.tab_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    shellProfileId: String(row.shell_profile_id),
    cwd: row.cwd ? String(row.cwd) : null,
    commandText: String(row.command_text),
    source: row.source as HistorySource,
    createdAt: String(row.created_at),
  };
}

function parseTemplateTabs(rawValue: unknown): TemplateTab[] {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    throw new Error("Invalid stored template payload.");
  }

  const parsed = JSON.parse(rawValue) as { version?: number; tabs?: TemplateTab[] };
  if (parsed?.version !== 1 || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
    throw new Error("Invalid stored template payload.");
  }

  return parsed.tabs;
}

function mapTemplate(row: Record<string, unknown>): WorkspaceTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    tabs: parseTemplateTabs(row.payload_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

    if (!existing.has("003_tab_custom_title")) {
      this.db.exec("BEGIN");
      try {
        const tabColumns = new Set(this.getTableColumns("saved_terminal_tabs"));
        if (!tabColumns.has("custom_title")) {
          this.db.exec("ALTER TABLE saved_terminal_tabs ADD COLUMN custom_title TEXT");
        }
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("003_tab_custom_title", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("004_serialized_terminal_snapshots")) {
      this.db.exec("BEGIN");
      try {
        const snapshotColumns = new Set(this.getTableColumns("terminal_snapshots"));
        if (
          snapshotColumns.has("serialized_buffer") &&
          !snapshotColumns.has("transcript_text")
        ) {
          this.db.exec(
            "ALTER TABLE terminal_snapshots RENAME COLUMN serialized_buffer TO transcript_text",
          );
        }
        if (!snapshotColumns.has("snapshot_format")) {
          this.db.exec(
            `ALTER TABLE terminal_snapshots
             ADD COLUMN snapshot_format TEXT NOT NULL DEFAULT '${SNAPSHOT_FORMAT}'`,
          );
        }

        this.db.exec("DELETE FROM terminal_snapshots");
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("004_serialized_terminal_snapshots", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("005_snapshot_table_cleanup")) {
      this.db.exec("BEGIN");
      try {
        const snapshotColumns = new Set(this.getTableColumns("terminal_snapshots"));
        if (snapshotColumns.has("line_count")) {
          this.db.exec(`
            CREATE TABLE terminal_snapshots_next (
              tab_id TEXT PRIMARY KEY,
              snapshot_format TEXT NOT NULL,
              transcript_text TEXT NOT NULL,
              byte_count INTEGER NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(tab_id) REFERENCES saved_terminal_tabs(id) ON DELETE CASCADE
            );
          `);
          this.db.exec(`
            INSERT INTO terminal_snapshots_next (
              tab_id, snapshot_format, transcript_text, byte_count, updated_at
            )
            SELECT
              tab_id,
              COALESCE(snapshot_format, '${SNAPSHOT_FORMAT}'),
              '',
              byte_count,
              updated_at
            FROM terminal_snapshots;
          `);
          this.db.exec("DROP TABLE terminal_snapshots");
          this.db.exec("ALTER TABLE terminal_snapshots_next RENAME TO terminal_snapshots");
        }

        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("005_snapshot_table_cleanup", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("006_snapshot_dimensions")) {
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("006_snapshot_dimensions", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("007_reset_corrupted_snapshots")) {
      this.db.exec("BEGIN");
      try {
        this.db.exec("DELETE FROM terminal_snapshots");
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("007_reset_corrupted_snapshots", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("008_transcript_snapshots")) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE terminal_snapshots_next (
            tab_id TEXT PRIMARY KEY,
            snapshot_format TEXT NOT NULL,
            transcript_text TEXT NOT NULL,
            byte_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(tab_id) REFERENCES saved_terminal_tabs(id) ON DELETE CASCADE
          );
        `);
        this.db.exec("DROP TABLE terminal_snapshots");
        this.db.exec("ALTER TABLE terminal_snapshots_next RENAME TO terminal_snapshots");
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("008_transcript_snapshots", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("009_tab_sessions_and_layouts")) {
      this.db.exec("BEGIN");
      try {
        const tabColumns = new Set(this.getTableColumns("saved_terminal_tabs"));
        const snapshotColumns = new Set(this.getTableColumns("terminal_snapshots"));
        const historyColumns = new Set(this.getTableColumns("history_entries"));
        const isFinalSchema =
          tabColumns.has("layout_json") &&
          tabColumns.has("focused_session_id") &&
          !tabColumns.has("shell_profile_id") &&
          this.tableExists("tab_shell_sessions") &&
          snapshotColumns.has("session_id") &&
          !snapshotColumns.has("tab_id") &&
          historyColumns.has("session_id");

        if (!isFinalSchema) {
          this.migrateTabsToSessions();
        }

        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("009_tab_sessions_and_layouts", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("010_workspace_templates")) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workspace_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_workspace_templates_updated
            ON workspace_templates(updated_at DESC, created_at DESC);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("010_workspace_templates", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("011_snapshot_serialized_state")) {
      this.db.exec("BEGIN");
      try {
        const snapshotColumns = new Set(this.getTableColumns("terminal_snapshots"));
        if (!snapshotColumns.has("serialized_state")) {
          this.db.exec(
            "ALTER TABLE terminal_snapshots ADD COLUMN serialized_state TEXT NOT NULL DEFAULT ''",
          );
        }
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("011_snapshot_serialized_state", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("012_session_border_color")) {
      this.db.exec("BEGIN");
      try {
        const sessionColumns = new Set(this.getTableColumns("tab_shell_sessions"));
        if (!sessionColumns.has("session_border_color")) {
          this.db.exec("ALTER TABLE tab_shell_sessions ADD COLUMN session_border_color TEXT");
        }
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("012_session_border_color", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    if (!existing.has("013_snapshot_viewport_offset")) {
      this.db.exec("BEGIN");
      try {
        const snapshotColumns = new Set(this.getTableColumns("terminal_snapshots"));
        if (!snapshotColumns.has("viewport_offset_from_bottom")) {
          this.db.exec(
            "ALTER TABLE terminal_snapshots ADD COLUMN viewport_offset_from_bottom INTEGER NOT NULL DEFAULT 0",
          );
        }
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("013_snapshot_viewport_offset", nowIso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private migrateTabsToSessions(): void {
    this.db.exec("ALTER TABLE history_entries RENAME TO history_entries_legacy");
    this.db.exec("ALTER TABLE terminal_snapshots RENAME TO terminal_snapshots_legacy");
    this.db.exec("ALTER TABLE saved_terminal_tabs RENAME TO saved_terminal_tabs_legacy");

    this.db.exec(`
      CREATE TABLE saved_terminal_tabs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        custom_title TEXT,
        restore_order INTEGER NOT NULL,
        layout_json TEXT NOT NULL,
        focused_session_id TEXT NOT NULL,
        was_open INTEGER NOT NULL DEFAULT 1,
        last_activated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE tab_shell_sessions (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL,
        shell_profile_id TEXT NOT NULL,
        last_known_cwd TEXT,
        session_border_color TEXT,
        session_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(tab_id) REFERENCES saved_terminal_tabs(id) ON DELETE CASCADE,
        FOREIGN KEY(shell_profile_id) REFERENCES shell_profiles(id)
      );

      CREATE TABLE terminal_snapshots (
        session_id TEXT PRIMARY KEY,
        snapshot_format TEXT NOT NULL,
        transcript_text TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES tab_shell_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE history_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        tab_id TEXT,
        session_id TEXT,
        shell_profile_id TEXT NOT NULL,
        cwd TEXT,
        command_text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(tab_id) REFERENCES saved_terminal_tabs(id) ON DELETE SET NULL,
        FOREIGN KEY(session_id) REFERENCES tab_shell_sessions(id) ON DELETE SET NULL,
        FOREIGN KEY(shell_profile_id) REFERENCES shell_profiles(id)
      );
    `);

    const legacyTabs = this.db
      .prepare(
        `SELECT
           id,
           project_id,
           shell_profile_id,
           title,
           custom_title,
           restore_order,
           last_known_cwd,
           was_open,
           last_activated_at,
           created_at,
           updated_at
         FROM saved_terminal_tabs_legacy
         ORDER BY restore_order ASC, created_at ASC`,
      )
      .all() as Record<string, unknown>[];

    const insertTab = this.db.prepare(`
      INSERT INTO saved_terminal_tabs (
        id, project_id, title, custom_title, restore_order, layout_json, focused_session_id,
        was_open, last_activated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSession = this.db.prepare(`
      INSERT INTO tab_shell_sessions (
        id, tab_id, shell_profile_id, last_known_cwd, session_border_color, session_order,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sessionIdsByTabId = new Map<string, string>();
    for (const legacyTab of legacyTabs) {
      const tabId = String(legacyTab.id);
      const sessionId = crypto.randomUUID();
      sessionIdsByTabId.set(tabId, sessionId);

      insertTab.run(
        tabId,
        String(legacyTab.project_id),
        String(legacyTab.title),
        legacyTab.custom_title ? String(legacyTab.custom_title) : null,
        Number(legacyTab.restore_order),
        JSON.stringify(createSingleLeafLayout(sessionId, `${sessionId}:root`)),
        sessionId,
        Number(legacyTab.was_open ?? 1),
        String(legacyTab.last_activated_at),
        String(legacyTab.created_at),
        String(legacyTab.updated_at),
      );

      insertSession.run(
        sessionId,
        tabId,
        String(legacyTab.shell_profile_id),
        legacyTab.last_known_cwd ? String(legacyTab.last_known_cwd) : null,
        null,
        1,
        String(legacyTab.created_at),
        String(legacyTab.updated_at),
      );
    }

    const legacySnapshots = this.db
      .prepare(
        `SELECT tab_id, snapshot_format, transcript_text, byte_count, updated_at
         FROM terminal_snapshots_legacy`,
      )
      .all() as Record<string, unknown>[];
    const insertSnapshot = this.db.prepare(`
      INSERT INTO terminal_snapshots (
        session_id, snapshot_format, transcript_text, byte_count, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const snapshot of legacySnapshots) {
      const sessionId = sessionIdsByTabId.get(String(snapshot.tab_id));
      if (!sessionId) {
        continue;
      }

      insertSnapshot.run(
        sessionId,
        String(snapshot.snapshot_format),
        String(snapshot.transcript_text),
        Number(snapshot.byte_count),
        String(snapshot.updated_at),
      );
    }

    const legacyHistoryEntries = this.db
      .prepare(
        `SELECT
           id, project_id, tab_id, shell_profile_id, cwd, command_text, source, created_at
         FROM history_entries_legacy
         ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[];
    const insertHistory = this.db.prepare(`
      INSERT INTO history_entries (
        id, project_id, tab_id, session_id, shell_profile_id, cwd, command_text, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const historyEntry of legacyHistoryEntries) {
      const legacyTabId =
        historyEntry.tab_id !== null && historyEntry.tab_id !== undefined
          ? String(historyEntry.tab_id)
          : null;
      insertHistory.run(
        String(historyEntry.id),
        String(historyEntry.project_id),
        legacyTabId,
        legacyTabId ? (sessionIdsByTabId.get(legacyTabId) ?? null) : null,
        String(historyEntry.shell_profile_id),
        historyEntry.cwd ? String(historyEntry.cwd) : null,
        String(historyEntry.command_text),
        String(historyEntry.source),
        String(historyEntry.created_at),
      );
    }

    this.db.exec("DROP TABLE history_entries_legacy");
    this.db.exec("DROP TABLE terminal_snapshots_legacy");
    this.db.exec("DROP TABLE saved_terminal_tabs_legacy");

    this.db.exec(`
      CREATE INDEX idx_tabs_project_restore
        ON saved_terminal_tabs(project_id, restore_order ASC);

      CREATE INDEX idx_sessions_tab_order
        ON tab_shell_sessions(tab_id, session_order ASC);

      CREATE INDEX idx_history_project_created
        ON history_entries(project_id, created_at DESC);
    `);
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  private getTableColumns(tableName: string): string[] {
    if (!this.tableExists(tableName)) {
      return [];
    }

    return this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((row: unknown) => String((row as { name: unknown }).name));
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

  listTemplates(): WorkspaceTemplate[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, payload_json, created_at, updated_at
         FROM workspace_templates
         ORDER BY updated_at DESC, created_at DESC, name COLLATE NOCASE ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapTemplate);
  }

  getTemplate(templateId: string): WorkspaceTemplate | null {
    const row = this.db
      .prepare(
        `SELECT id, name, payload_json, created_at, updated_at
         FROM workspace_templates
         WHERE id = ?`,
      )
      .get(templateId) as Record<string, unknown> | undefined;
    return row ? mapTemplate(row) : null;
  }

  createTemplate(params: CreateTemplateParams): WorkspaceTemplate {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspace_templates (
          id, name, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.name,
        JSON.stringify({ version: 1, tabs: params.tabs }),
        timestamp,
        timestamp,
      );
    return this.getTemplate(params.id)!;
  }

  updateTemplate(template: WorkspaceTemplate): WorkspaceTemplate {
    this.db
      .prepare(
        `UPDATE workspace_templates
         SET name = ?, payload_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        template.name,
        JSON.stringify({ version: 1, tabs: template.tabs }),
        nowIso(),
        template.id,
      );
    return this.getTemplate(template.id)!;
  }

  deleteTemplate(templateId: string): void {
    this.db.prepare("DELETE FROM workspace_templates WHERE id = ?").run(templateId);
  }

  listTabsForProject(projectId: string): SavedWorkspaceTab[] {
    const rows = this.db
      .prepare(
        `SELECT
           id, project_id, title, custom_title, restore_order, layout_json, focused_session_id,
           was_open, last_activated_at, created_at, updated_at
         FROM saved_terminal_tabs
         WHERE project_id = ?
         ORDER BY restore_order ASC, created_at ASC`,
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map(mapTab);
  }

  getTab(tabId: string): SavedWorkspaceTab | null {
    const row = this.db
      .prepare(
        `SELECT
           id, project_id, title, custom_title, restore_order, layout_json, focused_session_id,
           was_open, last_activated_at, created_at, updated_at
         FROM saved_terminal_tabs
         WHERE id = ?`,
      )
      .get(tabId) as Record<string, unknown> | undefined;
    return row ? mapTab(row) : null;
  }

  listSessionsForTab(tabId: string): SavedTerminalSession[] {
    const rows = this.db
      .prepare(
        `SELECT
           id, tab_id, shell_profile_id, last_known_cwd, session_border_color, session_order,
           created_at, updated_at
         FROM tab_shell_sessions
         WHERE tab_id = ?
         ORDER BY session_order ASC, created_at ASC`,
      )
      .all(tabId) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  getSession(sessionId: string): SavedTerminalSession | null {
    const row = this.db
      .prepare(
        `SELECT
           id, tab_id, shell_profile_id, last_known_cwd, session_border_color, session_order,
           created_at, updated_at
         FROM tab_shell_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
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

  createTabWithInitialSession(params: {
    tab: CreateTabParams;
    session: CreateSessionParams;
  }): { tab: SavedWorkspaceTab; session: SavedTerminalSession } {
    const transaction = this.db.transaction(
      (nextParams: { tab: CreateTabParams; session: CreateSessionParams }) => {
        const timestamp = nowIso();
        this.db
          .prepare(
            `INSERT INTO saved_terminal_tabs (
              id, project_id, title, custom_title, restore_order, layout_json, focused_session_id,
              was_open, last_activated_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            nextParams.tab.id,
            nextParams.tab.projectId,
            nextParams.tab.title,
            nextParams.tab.customTitle,
            nextParams.tab.restoreOrder,
            JSON.stringify(nextParams.tab.layout),
            nextParams.tab.focusedSessionId,
            timestamp,
            timestamp,
            timestamp,
          );

        this.db
          .prepare(
            `INSERT INTO tab_shell_sessions (
              id, tab_id, shell_profile_id, last_known_cwd, session_border_color, session_order,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            nextParams.session.id,
            nextParams.session.tabId,
            nextParams.session.shellProfileId,
            nextParams.session.lastKnownCwd,
            nextParams.session.borderColor ?? null,
            nextParams.session.sessionOrder,
            nextParams.session.createdAt ?? timestamp,
            nextParams.session.updatedAt ?? timestamp,
          );

        this.touchProject(nextParams.tab.projectId);
      },
    );

    transaction(params);

    return {
      tab: this.getTab(params.tab.id)!,
      session: this.getSession(params.session.id)!,
    };
  }

  createTabWithSessions(params: {
    tab: CreateTabParams;
    sessions: CreateSessionParams[];
  }): { tab: SavedWorkspaceTab; sessions: SavedTerminalSession[] } {
    const transaction = this.db.transaction(
      (nextParams: { tab: CreateTabParams; sessions: CreateSessionParams[] }) => {
        const timestamp = nowIso();
        this.db
          .prepare(
            `INSERT INTO saved_terminal_tabs (
              id, project_id, title, custom_title, restore_order, layout_json, focused_session_id,
              was_open, last_activated_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            nextParams.tab.id,
            nextParams.tab.projectId,
            nextParams.tab.title,
            nextParams.tab.customTitle,
            nextParams.tab.restoreOrder,
            JSON.stringify(nextParams.tab.layout),
            nextParams.tab.focusedSessionId,
            timestamp,
            timestamp,
            timestamp,
          );

        const insertSession = this.db.prepare(
          `INSERT INTO tab_shell_sessions (
            id, tab_id, shell_profile_id, last_known_cwd, session_border_color, session_order,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const session of nextParams.sessions) {
          insertSession.run(
            session.id,
            session.tabId,
            session.shellProfileId,
            session.lastKnownCwd,
            session.borderColor ?? null,
            session.sessionOrder,
            session.createdAt ?? timestamp,
            session.updatedAt ?? timestamp,
          );
        }

        this.touchProject(nextParams.tab.projectId);
      },
    );

    transaction(params);

    return {
      tab: this.getTab(params.tab.id)!,
      sessions: params.sessions.map((session) => this.getSession(session.id)!),
    };
  }

  createSession(params: CreateSessionParams): SavedTerminalSession {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO tab_shell_sessions (
          id, tab_id, shell_profile_id, last_known_cwd, session_border_color, session_order,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.tabId,
        params.shellProfileId,
        params.lastKnownCwd,
        params.borderColor ?? null,
        params.sessionOrder,
        params.createdAt ?? timestamp,
        params.updatedAt ?? timestamp,
      );

    const tab = this.getTab(params.tabId);
    if (tab) {
      this.touchProject(tab.projectId);
    }

    return this.getSession(params.id)!;
  }

  updateTab(tab: SavedWorkspaceTab): SavedWorkspaceTab {
    this.db
      .prepare(
        `UPDATE saved_terminal_tabs
         SET title = ?, custom_title = ?, restore_order = ?, layout_json = ?,
             focused_session_id = ?, was_open = ?, last_activated_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        tab.title,
        tab.customTitle,
        tab.restoreOrder,
        JSON.stringify(tab.layout),
        tab.focusedSessionId,
        tab.wasOpen ? 1 : 0,
        tab.lastActivatedAt,
        nowIso(),
        tab.id,
      );
    this.touchProject(tab.projectId);
    return this.getTab(tab.id)!;
  }

  updateSession(session: SavedTerminalSession): SavedTerminalSession {
    this.db
      .prepare(
        `UPDATE tab_shell_sessions
         SET shell_profile_id = ?, last_known_cwd = ?, session_border_color = ?,
             session_order = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        session.shellProfileId,
        session.lastKnownCwd,
        session.borderColor,
        session.sessionOrder,
        nowIso(),
        session.id,
      );

    const tab = this.getTab(session.tabId);
    if (tab) {
      this.touchProject(tab.projectId);
    }

    return this.getSession(session.id)!;
  }

  markTabActivated(tabId: string): SavedWorkspaceTab {
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

  getSnapshot(sessionId: string): TerminalSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT session_id, snapshot_format, transcript_text, serialized_state,
                viewport_offset_from_bottom, byte_count, updated_at
         FROM terminal_snapshots
         WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : null;
  }

  upsertSnapshot(params: SnapshotParams): TerminalSnapshot {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO terminal_snapshots (
          session_id, snapshot_format, transcript_text, serialized_state,
          viewport_offset_from_bottom, byte_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          snapshot_format = excluded.snapshot_format,
          transcript_text = excluded.transcript_text,
          serialized_state = excluded.serialized_state,
          viewport_offset_from_bottom = excluded.viewport_offset_from_bottom,
          byte_count = excluded.byte_count,
          updated_at = excluded.updated_at`,
      )
      .run(
        params.sessionId,
        params.snapshotFormat,
        params.transcriptText,
        params.serializedState,
        params.viewportOffsetFromBottom,
        params.byteCount,
        timestamp,
      );
    return this.getSnapshot(params.sessionId)!;
  }

  listSnapshotsForProject(projectId: string): TerminalSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT s.session_id, s.snapshot_format, s.transcript_text, s.serialized_state,
                s.viewport_offset_from_bottom, s.byte_count, s.updated_at
         FROM terminal_snapshots s
         INNER JOIN tab_shell_sessions ts ON ts.id = s.session_id
         INNER JOIN saved_terminal_tabs t ON t.id = ts.tab_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map(mapSnapshot);
  }

  addHistoryEntry(params: {
    id: string;
    projectId: string;
    tabId: string | null;
    sessionId: string | null;
    shellProfileId: string;
    cwd: string | null;
    commandText: string;
    source: HistorySource;
  }): HistoryEntry {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO history_entries (
          id, project_id, tab_id, session_id, shell_profile_id, cwd, command_text, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.projectId,
        params.tabId,
        params.sessionId,
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
        `SELECT
           id, project_id, tab_id, session_id, shell_profile_id, cwd, command_text, source, created_at
         FROM history_entries
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map(mapHistory);
  }

  listHistoryForSession(sessionId: string, limit = 100): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT
           id, project_id, tab_id, session_id, shell_profile_id, cwd, command_text, source, created_at
         FROM history_entries
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(mapHistory);
  }

  close(): void {
    this.db.close();
  }
}
