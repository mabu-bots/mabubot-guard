// ==========================================
// 🗄️ SQLite ストア（設定・警告・モデレーションログ・レイド防御）
// ==========================================
// 📌 Node 標準の node:sqlite を使い、ネイティブ依存を持たない。
// ファイルは1つ: data/mabubot-guard.db（DATA_DIR で変更可）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase } from "./backup.js";

// ------------------------------------------
// 📋 行データの型定義
// ------------------------------------------
export interface WarnRow {
  id: number;
  guild_id: string;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at_ms: number;
}

// 🚨 レイド防御の設定（運営自動化設計書 §5.8 / §6.2）
export interface RaidSettingsRow {
  guild_id: string;
  watch_joins: number;
  alert_joins_min: number;
  alert_joins_5min: number;
  young_ratio: number;
  auto_activate: number;
  gating_always: number;
  slowmode_seconds: number;
  slowmode_channels: string | null;
  verify_channel_id: string | null;
  talk_role_id: string | null;
  quarantine_role_id: string | null;
  duration_minutes: number;
  watch_off_until_ms: number;
  raid_until_ms: number;
  updated_at: string;
}

export interface RaidEventRow {
  id: number;
  guild_id: string;
  started_at: string;
  ended_at: string | null;
  peak_stage: string;
  activated_by: string | null;
  joins: number;
  leaves: number;
  auto_timeouts: number;
  deleted: number;
  quarantined: number;
  verified: number;
  false_positive: number;
  prev_state: string | null;
}

export interface RaidQuarantineRow {
  guild_id: string;
  user_id: string;
  joined_at: string;
  account_created_at: string;
  verified_at: string | null;
}

// ------------------------------------------
// 🗄️ ストア本体
// ------------------------------------------
export class MabusabaStore {
  private db: DatabaseSync;

  // ----- 🏗️ 初期化 -----
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "mabubot-guard.db");
    this.db = new DatabaseSync(dbPath);
    // 📌 WAL + NORMAL synchronous: コミットを安くし、読み取りが
    // 単一の書き手をブロックしないようにする（この Bot のアクセス形態）
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS warns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mod_log (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_warns_guild_user ON warns (guild_id, user_id);
      CREATE TABLE IF NOT EXISTS raid_settings (
        guild_id TEXT PRIMARY KEY,
        watch_joins INTEGER NOT NULL DEFAULT 10,
        alert_joins_min INTEGER NOT NULL DEFAULT 10,
        alert_joins_5min INTEGER NOT NULL DEFAULT 30,
        young_ratio REAL NOT NULL DEFAULT 0.5,
        auto_activate INTEGER NOT NULL DEFAULT 0,
        gating_always INTEGER NOT NULL DEFAULT 0,
        slowmode_seconds INTEGER NOT NULL DEFAULT 10,
        slowmode_channels TEXT,
        verify_channel_id TEXT,
        talk_role_id TEXT,
        quarantine_role_id TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 60,
        watch_off_until_ms INTEGER NOT NULL DEFAULT 0,
        raid_until_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS raid_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        peak_stage TEXT NOT NULL,
        activated_by TEXT,
        joins INTEGER NOT NULL DEFAULT 0,
        leaves INTEGER NOT NULL DEFAULT 0,
        auto_timeouts INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        false_positive INTEGER NOT NULL DEFAULT 0,
        prev_state TEXT
      );
      CREATE TABLE IF NOT EXISTS raid_quarantine (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        account_created_at TEXT NOT NULL,
        verified_at TEXT,
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    // 💾 起動時バックアップ: DB を data/backups/<timestamp>/ へコピーし、
    // 直近の世代だけを残す（backup.ts、suzushiro と同じ方式）。
    // バックアップの失敗で起動自体は止めない。
    try {
      const backupPath = backupDatabase(this.db, dbPath);
      if (backupPath) {
        console.log(`[mabusaba] database backup: ${backupPath}`);
      }
    } catch (error) {
      console.warn("[mabusaba] database backup failed:", error);
    }
  }

  // ----- ⚙️ 設定（ボット全体） -----

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // ----- ⚠️ 警告 -----

  addWarn(
    guildId: string,
    userId: string,
    moderatorId: string,
    reason: string,
    now = Date.now(),
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO warns (guild_id, user_id, moderator_id, reason, created_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run(guildId, userId, moderatorId, reason, now);
    return Number(info.lastInsertRowid);
  }

  listWarns(guildId: string, userId: string): WarnRow[] {
    return this.db
      .prepare(
        "SELECT id, guild_id, user_id, moderator_id, reason, created_at_ms FROM warns WHERE guild_id = ? AND user_id = ? ORDER BY created_at_ms DESC",
      )
      .all(guildId, userId) as unknown as WarnRow[];
  }

  countWarns(guildId: string, userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM warns WHERE guild_id = ? AND user_id = ?",
      )
      .get(guildId, userId) as { n: number };
    return row.n;
  }

  // ----- 🛡️ モデレーションログ -----

  getModLog(guildId: string): string | null {
    const row = this.db
      .prepare("SELECT channel_id FROM mod_log WHERE guild_id = ?")
      .get(guildId) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  setModLog(guildId: string, channelId: string): void {
    this.db
      .prepare(
        `INSERT INTO mod_log (guild_id, channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, new Date().toISOString());
  }

  deleteModLog(guildId: string): void {
    this.db.prepare("DELETE FROM mod_log WHERE guild_id = ?").run(guildId);
  }

  // ----- 🚨 レイド防御 -----

  getRaidSettings(guildId: string): RaidSettingsRow {
    const row = this.db
      .prepare("SELECT * FROM raid_settings WHERE guild_id = ?")
      .get(guildId) as unknown as RaidSettingsRow | undefined;
    if (row) return row;
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO raid_settings (guild_id, updated_at) VALUES (?, ?)")
      .run(guildId, now);
    return this.db
      .prepare("SELECT * FROM raid_settings WHERE guild_id = ?")
      .get(guildId) as unknown as RaidSettingsRow;
  }

  updateRaidSettings(
    guildId: string,
    patch: Partial<
      Omit<RaidSettingsRow, "guild_id" | "updated_at" | "slowmode_channels">
    > & { slowmode_channels?: string | null },
  ): RaidSettingsRow {
    this.getRaidSettings(guildId);
    const allowed = [
      "watch_joins",
      "alert_joins_min",
      "alert_joins_5min",
      "young_ratio",
      "auto_activate",
      "gating_always",
      "slowmode_seconds",
      "slowmode_channels",
      "verify_channel_id",
      "talk_role_id",
      "quarantine_role_id",
      "duration_minutes",
      "watch_off_until_ms",
      "raid_until_ms",
    ] as const;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(patch[key] as string | number | null);
      }
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      values.push(new Date().toISOString(), guildId);
      this.db
        .prepare(
          `UPDATE raid_settings SET ${sets.join(", ")} WHERE guild_id = ?`,
        )
        .run(...values);
    }
    return this.getRaidSettings(guildId);
  }

  createRaidEvent(guildId: string, peakStage: string): number {
    const info = this.db
      .prepare(
        "INSERT INTO raid_events (guild_id, started_at, peak_stage) VALUES (?, ?, ?)",
      )
      .run(guildId, new Date().toISOString(), peakStage);
    return Number(info.lastInsertRowid);
  }

  getRaidEvent(id: number): RaidEventRow | null {
    const row = this.db
      .prepare("SELECT * FROM raid_events WHERE id = ?")
      .get(id) as unknown as RaidEventRow | undefined;
    return row ?? null;
  }

  getOpenRaidEvent(guildId: string): RaidEventRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM raid_events WHERE guild_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(guildId) as unknown as RaidEventRow | undefined;
    return row ?? null;
  }

  updateRaidEvent(
    id: number,
    patch: Partial<
      Pick<
        RaidEventRow,
        | "peak_stage"
        | "activated_by"
        | "prev_state"
        | "false_positive"
        | "ended_at"
      >
    >,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      values.push(v as string | number | null);
    }
    if (!sets.length) return;
    values.push(id);
    this.db
      .prepare(`UPDATE raid_events SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  bumpRaidEvent(
    id: number,
    field:
      | "joins"
      | "leaves"
      | "auto_timeouts"
      | "deleted"
      | "quarantined"
      | "verified",
    by = 1,
  ): void {
    this.db
      .prepare(`UPDATE raid_events SET ${field} = ${field} + ? WHERE id = ?`)
      .run(by, id);
  }

  addQuarantine(
    guildId: string,
    userId: string,
    joinedAt: string,
    accountCreatedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO raid_quarantine (guild_id, user_id, joined_at, account_created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO NOTHING`,
      )
      .run(guildId, userId, joinedAt, accountCreatedAt);
  }

  getQuarantine(guildId: string, userId: string): RaidQuarantineRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM raid_quarantine WHERE guild_id = ? AND user_id = ?",
      )
      .get(guildId, userId) as unknown as RaidQuarantineRow | undefined;
    return row ?? null;
  }

  markQuarantineVerified(guildId: string, userId: string): void {
    this.db
      .prepare(
        "UPDATE raid_quarantine SET verified_at = ? WHERE guild_id = ? AND user_id = ?",
      )
      .run(new Date().toISOString(), guildId, userId);
  }

  removeQuarantine(guildId: string, userId: string): void {
    this.db
      .prepare("DELETE FROM raid_quarantine WHERE guild_id = ? AND user_id = ?")
      .run(guildId, userId);
  }

  listQuarantine(guildId: string): RaidQuarantineRow[] {
    return this.db
      .prepare(
        "SELECT * FROM raid_quarantine WHERE guild_id = ? AND verified_at IS NULL ORDER BY joined_at",
      )
      .all(guildId) as unknown as RaidQuarantineRow[];
  }

  // ----- 🔚 終了処理 -----
  close(): void {
    this.db.close();
  }
}
