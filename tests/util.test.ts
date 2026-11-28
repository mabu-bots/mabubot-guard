// ==========================================
// 🧪 テスト: ユーティリティとストア
// ==========================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCommandExecLog,
  joinLinesWithinLimit,
  parseDurationMs,
} from "../src/util.js";
import { MabusabaStore } from "../src/store.js";

// ------------------------------------------
// 🕐 parseDurationMs
// ------------------------------------------
describe("parseDurationMs", () => {
  it("parses English and Japanese units", () => {
    assert.equal(parseDurationMs("10m"), 600_000);
    assert.equal(parseDurationMs("1h"), 3_600_000);
    assert.equal(parseDurationMs("1d"), 86_400_000);
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("30分"), 1_800_000);
    assert.equal(parseDurationMs("2時間"), 7_200_000);
    assert.equal(parseDurationMs("3日"), 259_200_000);
  });

  it("parses combinations", () => {
    assert.equal(parseDurationMs("1時間30分"), 5_400_000);
    assert.equal(parseDurationMs("1d12h"), 129_600_000);
    assert.equal(parseDurationMs("90分"), 5_400_000);
  });

  it("rejects unusable input", () => {
    assert.equal(parseDurationMs("abc"), null);
    assert.equal(parseDurationMs("0m"), null);
    assert.equal(parseDurationMs(""), null);
    assert.equal(parseDurationMs("10x"), null);
  });
});

// ------------------------------------------
// 📄 joinLinesWithinLimit
// ------------------------------------------
describe("joinLinesWithinLimit", () => {
  it("keeps short lists intact and truncates long ones", () => {
    assert.deepEqual(joinLinesWithinLimit(["a", "b"], 100), {
      text: "a\nb",
      omitted: 0,
    });
    const lines = Array.from({ length: 10 }, () => "x".repeat(100));
    const { text, omitted } = joinLinesWithinLimit(lines, 350);
    assert.ok(text.length <= 350);
    assert.ok(omitted > 0);
  });
});

// ------------------------------------------
// 🗄️ ストア
// ------------------------------------------
describe("store (SQLite)", () => {
  it("warns, mod log and settings round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "mabubot-guard-test-"));
    const store = new MabusabaStore(dir);
    try {
      const warnId = store.addWarn("g1", "u1", "mod1", "連投");
      assert.equal(store.listWarns("g1", "u1").length, 1);
      assert.equal(store.listWarns("g1", "u1")[0]?.id, warnId);
      assert.equal(store.countWarns("g1", "u1"), 1);
      assert.equal(store.countWarns("g1", "u2"), 0);

      assert.equal(store.getModLog("g1"), null);
      store.setModLog("g1", "c1");
      assert.equal(store.getModLog("g1"), "c1");
      store.deleteModLog("g1");
      assert.equal(store.getModLog("g1"), null);

      // 👀 視聴中ステータスの文言は共有の settings テーブルに住む
      assert.equal(store.getSetting("watching_text"), null);
      store.setSetting("watching_text", "見守り中");
      assert.equal(store.getSetting("watching_text"), "見守り中");
      store.deleteSetting("watching_text");
      assert.equal(store.getSetting("watching_text"), null);
    } finally {
      store.close();
    }
  });
});

// ------------------------------------------
// 📝 コマンド実行ログ（formatCommandExecLog）
// ------------------------------------------
describe("formatCommandExecLog", () => {
  const now = new Date("2026-11-23T00:00:00.000Z");
  const base = {
    commandName: "ping",
    route: "slash" as const,
    guildId: "g1",
    channelId: "c1",
    userId: "u1",
    now,
  };

  it("formats a successful execution in the fleet-wide format", () => {
    assert.equal(
      formatCommandExecLog(base),
      "[exec] 2026-11-23T00:00:00.000Z cmd=ping route=slash guild=g1 channel=c1 user=u1 result=ok",
    );
  });

  it("uses - for missing guild/channel (e.g. DM)", () => {
    const line = formatCommandExecLog({
      ...base,
      guildId: null,
      channelId: null,
    });
    assert.ok(line.includes("guild=- channel=-"));
    assert.ok(line.endsWith("result=ok"));
  });

  it("appends a single-line error summary on failure", () => {
    const line = formatCommandExecLog({
      ...base,
      error: new Error('boom\n"quoted"  details'),
    });
    assert.ok(line.includes("result=error"));
    assert.ok(line.endsWith('error="boom quoted details"'));
    assert.ok(!line.includes("\n"));
  });

  it("stringifies non-Error failures", () => {
    const line = formatCommandExecLog({ ...base, error: "plain failure" });
    assert.ok(line.endsWith('error="plain failure"'));
  });
});
