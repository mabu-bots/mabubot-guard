// ==========================================
// 📡 イベント登録（スパム対策・レイド防御の参加検知）
// ==========================================
// 📌 mabubot-guard が購読するイベントはメッセージ作成（スパム対策）と
// メンバー参加・退出（レイド防御、設計書 §5.8）。
// 元 mabubot の events.ts にあった XP 付与は mabubot-play へ、
// 歓迎・投票等のボタン処理は mabubot-ops へ分離した。
// なお元実装ではスパム判定を XP 付与より先に行い「スパムには XP を
// 付けない」順序だったが、分離後は別 Bot（mabubot-play）が独立に
// XP を付与するため、この順序制御は効かなくなる（README の移行メモ参照）。
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Message,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import { autoTimeoutLogDescription, sendModLog } from "./mod.js";
import { RAID_SPAM_TIMEOUT_MS, type RaidManager } from "./raid.js";

// ------------------------------------------
// 🚨 スパム対策の定数と型
// ------------------------------------------
// 📌 閾値: 同一ユーザーから 5秒に6件以上、または10秒に同一内容が
// 5件以上 → 10分タイムアウト
const SPAM_WINDOW_MS = 5_000;
const SPAM_COUNT = 6;
const SPAM_SAME_WINDOW_MS = 10_000;
const SPAM_SAME_COUNT = 5;
const AUTO_TIMEOUT_MS = 10 * 60_000;
const AUTO_TIMEOUT_COOLDOWN_MS = 60_000;

interface RecentMessage {
  atMs: number;
  content: string;
  messageId: string;
  channelId: string;
}

// ------------------------------------------
// 📡 イベント登録
// ------------------------------------------
export function registerEvents(
  client: Client,
  store: MabusabaStore,
  raid?: RaidManager,
): void {
  const recentByUser = new Map<string, RecentMessage[]>();
  const lastAutoTimeout = new Map<string, number>();

  // 🧹 投稿をやめたユーザーの記録を掃除する（放置すると両マップとも
  // 見かけたユーザーごとに1件ずつ増え続ける）
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, recent] of recentByUser) {
      if (
        !recent.length ||
        now - recent[recent.length - 1]!.atMs > SPAM_SAME_WINDOW_MS
      )
        recentByUser.delete(key);
    }
    for (const [key, at] of lastAutoTimeout) {
      if (now - at > AUTO_TIMEOUT_COOLDOWN_MS) lastAutoTimeout.delete(key);
    }
  }, 10 * 60_000);
  prune.unref();

  // ----- 👋 参加・退出（レイド防御） -----
  if (raid) {
    client.on("guildMemberAdd", async (member) => {
      try {
        await raid.onMemberJoin(member);
      } catch (error) {
        console.error("[raid] guildMemberAdd failed:", error);
      }
    });
    client.on("guildMemberRemove", async (member) => {
      try {
        await raid.onMemberRemove(member);
      } catch (error) {
        console.error("[raid] guildMemberRemove failed:", error);
      }
    });
  }

  // ----- 💬 メッセージ（スパム対策） -----
  client.on("messageCreate", async (message: Message) => {
    try {
      await handleMessageCreate(
        client,
        store,
        recentByUser,
        lastAutoTimeout,
        message,
        raid,
      );
    } catch (error) {
      // 📌 1件の不正なメッセージ（取得失敗・削除済みチャンネル等）で
      // 未処理の rejection になってプロセスが落ちないよう、記録して
      // 次のメッセージの監視を続ける
      console.error("[mabusaba] messageCreate failed:", error);
    }
  });
}

async function handleMessageCreate(
  client: Client,
  store: MabusabaStore,
  recentByUser: Map<string, RecentMessage[]>,
  lastAutoTimeout: Map<string, number>,
  message: Message,
  raid?: RaidManager,
): Promise<void> {
  if (!message.guildId || !message.guild || message.author.bot) return;
  if (message.channel.type !== ChannelType.GuildText) return;
  const guildId = message.guildId;
  const userId = message.author.id;
  const now = Date.now();

  const key = `${guildId}:${userId}`;
  const recent = (recentByUser.get(key) ?? []).filter(
    (r) => now - r.atMs <= SPAM_SAME_WINDOW_MS,
  );
  recent.push({
    atMs: now,
    content: message.content,
    messageId: message.id,
    channelId: message.channelId,
  });
  recentByUser.set(key, recent);
  const in5s = recent.filter((r) => now - r.atMs <= SPAM_WINDOW_MS).length;
  const sameIn10s = recent.filter(
    (r) => r.content === message.content && message.content.length > 0,
  ).length;
  if (
    (in5s >= SPAM_COUNT || sameIn10s >= SPAM_SAME_COUNT) &&
    now - (lastAutoTimeout.get(key) ?? 0) > AUTO_TIMEOUT_COOLDOWN_MS
  ) {
    const member = await message.guild.members.fetch(userId).catch(() => null);
    // 📌 モデレーターとオーナーは自動タイムアウトしない: 対応中に
    // 素早く投稿するモデレーターは職務中である（オーナーや上位ロールは
    // moderatable でも守られていたが、Bot より下位のモデレーターは
    // 守られていなかった）
    const exempt =
      member !== null &&
      (member.id === message.guild.ownerId ||
        member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
        member.permissions.has(PermissionFlagsBits.Administrator));
    if (exempt) {
      // 窓をリセットする。この Bot では他にすることはない
      recentByUser.set(key, []);
    } else {
      lastAutoTimeout.set(key, now);
      if (member?.moderatable) {
        // 🚨 レイドモード中は自動タイムアウトを30分へ延長する（§5.8.4）
        const timeoutMs =
          raid?.isRaidActive(guildId) === true
            ? RAID_SPAM_TIMEOUT_MS
            : AUTO_TIMEOUT_MS;
        // 📌 成否を必ず把握する: 失敗を握りつぶしたまま成功と
        // 運営ログへ記録すると、処罰が効いていないことに
        // 運営が気づけない（監査指摘）
        const timeoutError = await member
          .timeout(timeoutMs, "荒らし対策：短時間の連投を検知")
          .then(() => null)
          .catch((error: unknown) => error);
        if (timeoutError) {
          console.error("[mabusaba] auto timeout failed:", timeoutError);
        }
        const openEvent = store.getOpenRaidEvent(guildId);
        if (openEvent) {
          store.bumpRaidEvent(openEvent.id, "auto_timeouts");
          store.bumpRaidEvent(openEvent.id, "deleted", recent.length);
        }
        // 🗑️ スパムメッセージを削除する。記録はギルド＋ユーザー単位で
        // 複数チャンネルにまたがりうるため、チャンネルごとにまとめて
        // 一括削除する（現在のチャンネルだけを1件ずつ消す方式では、
        // 他チャンネルのスパムが残ってしまっていた）
        const byChannel = new Map<string, string[]>();
        for (const r of recent) {
          const ids = byChannel.get(r.channelId) ?? [];
          ids.push(r.messageId);
          byChannel.set(r.channelId, ids);
        }
        for (const [channelId, ids] of byChannel) {
          const ch =
            channelId === message.channelId
              ? message.channel
              : await message.guild.channels.fetch(channelId).catch(() => null);
          if (!ch || !("bulkDelete" in ch)) continue;
          for (let i = 0; i < ids.length; i += 100) {
            await ch
              .bulkDelete(ids.slice(i, i + 100), true)
              .catch(() => undefined);
          }
        }
        await sendModLog(
          client,
          store,
          guildId,
          "🚨 荒らし対策：自動タイムアウト",
          autoTimeoutLogDescription({
            userId,
            timeoutMs,
            in5s,
            sameIn10s,
            succeeded: timeoutError === null,
          }),
        );
      }
      recentByUser.set(key, []);
      return;
    }
  }
}
