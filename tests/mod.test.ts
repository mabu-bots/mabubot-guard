// ==========================================
// 🧪 テスト: モデレーション（階層判定・権限・ログ文面・/watching）
// ==========================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import {
  autoTimeoutLogDescription,
  hierarchyBlockReason,
  type HierarchyCheckInput,
} from "../src/mod.js";
import {
  handleWatchingCommand,
  hasWatchingManagePermission,
  WATCHING_SETTING_KEY,
} from "../src/watching.js";
import { MabusabaStore } from "../src/store.js";

// ------------------------------------------
// ⚖️ 階層チェック（hierarchyBlockReason）
// ------------------------------------------
function input(
  overrides: Partial<HierarchyCheckInput> = {},
): HierarchyCheckInput {
  return {
    executorId: "mod1",
    targetId: "user1",
    guildOwnerId: "owner1",
    botUserId: "bot1",
    executorHighestPosition: 10,
    targetHighestPosition: 5,
    targetHasAdministrator: false,
    ...overrides,
  };
}

describe("hierarchyBlockReason", () => {
  it("allows a lower-ranked, unprotected target", () => {
    assert.equal(hierarchyBlockReason(input()), null);
  });

  it("blocks acting on yourself and on the bot itself", () => {
    assert.equal(hierarchyBlockReason(input({ targetId: "mod1" })), "self");
    assert.equal(hierarchyBlockReason(input({ targetId: "bot1" })), "bot");
  });

  it("blocks the guild owner and Administrator holders regardless of role position", () => {
    assert.equal(hierarchyBlockReason(input({ targetId: "owner1" })), "owner");
    // 📌 低い役職位置の Administrator 保有者も保護される
    assert.equal(
      hierarchyBlockReason(
        input({ targetHasAdministrator: true, targetHighestPosition: 1 }),
      ),
      "administrator",
    );
    // 📌 実行者がサーバーオーナーでも Administrator には実行できない
    assert.equal(
      hierarchyBlockReason(
        input({ executorId: "owner1", targetHasAdministrator: true }),
      ),
      "administrator",
    );
  });

  it("fails closed when the executor member could not be obtained", () => {
    assert.equal(
      hierarchyBlockReason(input({ executorHighestPosition: null })),
      "unknown-executor",
    );
  });

  it("blocks equal or higher role positions, but not for the guild owner executor", () => {
    assert.equal(
      hierarchyBlockReason(input({ targetHighestPosition: 10 })),
      "outranks",
    );
    assert.equal(
      hierarchyBlockReason(input({ targetHighestPosition: 11 })),
      "outranks",
    );
    assert.equal(
      hierarchyBlockReason(
        input({ executorId: "owner1", targetHighestPosition: 99 }),
      ),
      null,
    );
  });
});

// ------------------------------------------
// 🔐 /watching の実行時権限チェック
// ------------------------------------------
describe("hasWatchingManagePermission", () => {
  it("requires ManageGuild at runtime", () => {
    const withPerm = {
      has: (perm: bigint) => perm === PermissionFlagsBits.ManageGuild,
    };
    const withoutPerm = { has: (_perm: bigint) => false };
    assert.equal(hasWatchingManagePermission(withPerm), true);
    assert.equal(hasWatchingManagePermission(withoutPerm), false);
    assert.equal(hasWatchingManagePermission(null), false);
    assert.equal(hasWatchingManagePermission(undefined), false);
  });
});

// ------------------------------------------
// 🚨 自動タイムアウトの運営ログ文面
// ------------------------------------------
describe("autoTimeoutLogDescription", () => {
  const base = { userId: "user1", timeoutMs: 600_000, in5s: 6, sameIn10s: 1 };

  it("states success as success", () => {
    const text = autoTimeoutLogDescription({ ...base, succeeded: true });
    assert.ok(text.includes("<@user1> を"));
    assert.ok(text.includes("タイムアウトしました"));
    assert.ok(!text.includes("失敗"));
    assert.ok(text.includes("6件/5秒"));
  });

  it("states failure as failure (no false success in the audit trail)", () => {
    const text = autoTimeoutLogDescription({ ...base, succeeded: false });
    assert.ok(text.includes("タイムアウトに失敗しました"));
    assert.ok(!text.includes("タイムアウトしました。"));
  });
});

// ------------------------------------------
// 👀 /watching set の返信文面
// ------------------------------------------
// 📌 旧テストは旧統一形式「/help | {ping}ms」の表示を前提にしていたが、
// 本番コードはプレゼンス・サイクル（Playing の分交替表示）に移行済みで、
// 旧テストは本番スナップショットでも失敗していた（43件中1件）。
// ここでは実挙動（サイクル文言が返ること）に合わせて検証する。
describe("handleWatchingCommand (set)", () => {
  it("explains the unified format instead of claiming the text was applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-watching-"));
    const store = new MabusabaStore(dir);
    try {
      const replies: Array<{
        embeds: Array<{ data: { title?: string; description?: string } }>;
      }> = [];
      const interaction = {
        memberPermissions: { has: () => true },
        deferred: false,
        replied: false,
        options: {
          getSubcommand: () => "set",
          getString: () => "カスタム文言",
        },
        reply: async (payload: (typeof replies)[number]) => {
          replies.push(payload);
        },
      } as unknown as ChatInputCommandInteraction;
      const client = {
        ws: { ping: 42 },
        user: { username: "mabubot-guard", setActivity: () => undefined },
      } as unknown as Client;

      await handleWatchingCommand(interaction, client, store);

      assert.equal(replies.length, 1);
      const embed = replies[0]!.embeds[0]!.data;
      assert.notEqual(embed.title, "👀 視聴中ステータスを設定しました");
      assert.ok(embed.description?.includes("統一形式"));
      // 🎮 現在のプレゼンスはサイクル文言（起動して…／現在時刻…）で返る
      assert.ok(
        /mabubot-guard \| (起動して|現在時刻)/.test(embed.description ?? ""),
      );
      assert.ok(embed.description?.includes("カスタム文言"));
      // 📌 保存自体は互換のため残っている
      assert.equal(store.getSetting(WATCHING_SETTING_KEY), "カスタム文言");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
