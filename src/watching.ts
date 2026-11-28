// ==========================================
// 👀 プレゼンス文言の管理（/watching）
// ==========================================
import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import { currentPresenceText, startPresenceCycle } from "./presence-cycle.js";
import { EMBED_COLOR_ERROR, EMBED_COLOR_SUCCESS, replyEmbed } from "./util.js";

// ------------------------------------------
// 📝 ステータス文の解決と適用
// ------------------------------------------
// 📌 既定のカスタム文言。環境変数 WATCHING_TEXT、次いで /watching set で
// 保存した文言（SQLite）の順に上書きされる（解決順は resolveWatchingText）
export const DEFAULT_WATCHING_TEXT = "まぶさばを見守り中";
export const WATCHING_SETTING_KEY = "watching_text";

// 🔍 カスタム文言を解決する: 保存値 → 環境変数 → 既定値
export function resolveWatchingText(store: MabusabaStore): string {
  const stored = store.getSetting(WATCHING_SETTING_KEY)?.trim();
  if (stored) return stored;
  const env = process.env.WATCHING_TEXT?.trim();
  if (env) return env;
  return DEFAULT_WATCHING_TEXT;
}

// 🎮 実際に表示されるプレゼンスは全 Bot 共通のプレゼンス・サイクル
// （presence-cycle.ts）が担う。/watching set/reset の保存動作は互換の
// ため残すが、適用される表示は保存テキストではなくサイクル形式である
export function presenceText(client: Client): string {
  return currentPresenceText(client);
}

// 🚀 プレゼンス・サイクルを開始（再適用）する
export function applyWatching(client: Client, store: MabusabaStore): void {
  void store;
  startPresenceCycle(client);
}

// ------------------------------------------
// ⌨️ コマンド処理
// ------------------------------------------
// 📌 実行時権限チェック（/mod log と同じ考え方）: コマンド定義の
// setDefaultMemberPermissions(ManageGuild) だけでは、連携権限の
// 上書きで全員に開かれてしまう可能性がある。プレゼンスは Bot 全体
// （全ギルド）に効き、set/reset は設定の保存・削除も伴うため、
// 実行時にも「サーバーの管理」を要求する。
export function hasWatchingManagePermission(
  memberPermissions: { has: (perm: bigint) => boolean } | null | undefined,
): boolean {
  return memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function requireWatchingPerm(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (hasWatchingManagePermission(interaction.memberPermissions)) return true;
  await replyEmbed(
    interaction,
    "🛡️ 権限がありません",
    "この操作には「サーバーの管理」権限が必要です。",
    EMBED_COLOR_ERROR,
  );
  return false;
}

export async function handleWatchingCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  if (!(await requireWatchingPerm(interaction))) return;
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    await replyEmbed(
      interaction,
      "👀 視聴中ステータス",
      `現在の視聴中ステータス：${presenceText(client)}`,
    );
    return;
  }
  if (sub === "reset") {
    store.deleteSetting(WATCHING_SETTING_KEY);
    applyWatching(client, store);
    await replyEmbed(
      interaction,
      "👀 視聴中ステータスを既定に戻しました",
      `現在の視聴中ステータス：${presenceText(client)}`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  // set — 文言は互換のため保存するが、実際に表示されるプレゼンスは
  // 統一形式（presenceText）であり、保存テキストではない。返信で
  // その旨を明示する: 以前の版は保存テキストで「設定しました」と
  // 返しており、表示されていると誤認されていた。
  const text = interaction.options.getString("text", true).trim();
  store.setSetting(WATCHING_SETTING_KEY, text);
  applyWatching(client, store);
  await replyEmbed(
    interaction,
    "👀 視聴中ステータスは統一形式で固定されています",
    `現在のプレゼンスは全 Bot 統一形式「${presenceText(client)}」で固定されており、指定したテキスト（${text}）は表示には使われません（互換のため保存のみ行いました）。`,
    EMBED_COLOR_SUCCESS,
  );
}
