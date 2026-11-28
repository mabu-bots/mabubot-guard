// ==========================================
// 🧪 テスト: レイド防御（段階判定・自動発動・認証条件・ストア）
// ==========================================
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MabusabaStore } from "../src/store.js";
import {
  countInWindow,
  evaluateStage,
  parseChannelList,
  shouldAutoActivate,
  verifyBlockReason,
  youngRatio,
  type JoinRecord,
} from "../src/raid.js";

// ------------------------------------------
// 🧰 テスト用ヘルパー
// ------------------------------------------
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

function joins(n: number, accountAgeMs: number, stepMs = 0): JoinRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: `u${i}`,
    atMs: NOW - i * stepMs,
    accountCreatedAtMs: NOW - accountAgeMs,
  }));
}

const SETTINGS = {
  watch_joins: 10,
  alert_joins_min: 10,
  alert_joins_5min: 30,
  young_ratio: 0.5,
};

// ------------------------------------------
// 🚦 段階判定
// ------------------------------------------
describe("raid stage evaluation", () => {
  it("stays normal for a small number of old accounts", () => {
    assert.equal(evaluateStage(joins(3, 90 * DAY), NOW, SETTINGS), "normal");
    assert.equal(evaluateStage([], NOW, SETTINGS), "normal");
  });

  it("watch at 10 joins in 5 minutes", () => {
    assert.equal(
      evaluateStage(joins(10, 90 * DAY, 20_000), NOW, SETTINGS),
      "watch",
    );
  });

  it("watch when young accounts dominate a smaller burst", () => {
    assert.equal(
      evaluateStage(joins(6, 1 * DAY, 20_000), NOW, SETTINGS),
      "watch",
    );
  });

  it("alert at 10 joins within 1 minute", () => {
    assert.equal(evaluateStage(joins(10, 90 * DAY), NOW, SETTINGS), "alert");
  });

  it("alert at 30 joins in 5 minutes", () => {
    assert.equal(
      evaluateStage(joins(30, 90 * DAY, 9_000), NOW, SETTINGS),
      "alert",
    );
  });

  it("alert when a watch-sized burst is mostly young accounts", () => {
    assert.equal(
      evaluateStage(joins(12, 1 * DAY, 20_000), NOW, SETTINGS),
      "alert",
    );
  });

  it("youngRatio is 0 with no joins (no division by zero)", () => {
    assert.equal(youngRatio([], NOW, 5 * 60_000), 0);
    assert.equal(countInWindow([], NOW, 60_000), 0);
  });
});

// ------------------------------------------
// ⚡ 自動発動の二重条件
// ------------------------------------------
describe("raid auto-activation", () => {
  it("requires both the join rate and the young ratio", () => {
    assert.equal(shouldAutoActivate(joins(20, 1 * DAY), NOW), true);
    assert.equal(shouldAutoActivate(joins(20, 90 * DAY), NOW), false);
    assert.equal(shouldAutoActivate(joins(10, 1 * DAY), NOW), false);
  });
});

// ------------------------------------------
// 🔐 認証条件
// ------------------------------------------
describe("raid verify conditions", () => {
  it("passes when both time conditions are met", () => {
    assert.equal(
      verifyBlockReason(NOW - 11 * 60_000, NOW - 2 * DAY, NOW),
      null,
    );
  });
  it("blocks accounts younger than 24 hours", () => {
    assert.match(
      verifyBlockReason(NOW - 11 * 60_000, NOW - 1 * 60_000, NOW) ?? "",
      /24時間/,
    );
  });
  it("blocks members who joined less than 10 minutes ago", () => {
    assert.match(
      verifyBlockReason(NOW - 5 * 60_000, NOW - 2 * DAY, NOW) ?? "",
      /10分/,
    );
  });
});

// ------------------------------------------
// 🗄️ ストア往復
// ------------------------------------------
describe("raid store", () => {
  it("returns default settings and persists updates", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-raid-"));
    try {
      const store = new MabusabaStore(dir);
      const s = store.getRaidSettings("g1");
      assert.equal(s.watch_joins, 10);
      assert.equal(s.auto_activate, 0);
      const updated = store.updateRaidSettings("g1", {
        watch_joins: 7,
        auto_activate: 1,
        slowmode_channels: JSON.stringify(["c1", "c2"]),
      });
      assert.equal(updated.watch_joins, 7);
      assert.equal(updated.auto_activate, 1);
      assert.deepEqual(parseChannelList(updated.slowmode_channels), [
        "c1",
        "c2",
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks an event lifecycle and quarantine", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-raid-"));
    try {
      const store = new MabusabaStore(dir);
      const id = store.createRaidEvent("g1", "watch");
      store.bumpRaidEvent(id, "joins", 12);
      store.bumpRaidEvent(id, "quarantined");
      store.updateRaidEvent(id, {
        peak_stage: "raid",
        activated_by: "mod1",
        prev_state: "{}",
      });
      const open = store.getOpenRaidEvent("g1");
      assert.equal(open?.joins, 12);
      assert.equal(open?.quarantined, 1);
      assert.equal(open?.peak_stage, "raid");

      store.addQuarantine(
        "g1",
        "u1",
        new Date(NOW).toISOString(),
        new Date(NOW - DAY).toISOString(),
      );
      assert.equal(store.listQuarantine("g1").length, 1);
      store.markQuarantineVerified("g1", "u1");
      assert.equal(store.listQuarantine("g1").length, 0);
      assert.ok(store.getQuarantine("g1", "u1")?.verified_at);

      store.updateRaidEvent(id, { ended_at: new Date().toISOString() });
      assert.equal(store.getOpenRaidEvent("g1"), null);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseChannelList tolerates broken JSON", () => {
    assert.deepEqual(parseChannelList(null), []);
    assert.deepEqual(parseChannelList("{oops"), []);
    assert.deepEqual(parseChannelList('["a", 1, "b"]'), ["a", "b"]);
  });
});
