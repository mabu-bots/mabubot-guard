// ==========================================
// 🛡️ モデレーション（警告・タイムアウト・キック・BAN・削除・ログ）
// ==========================================
import {
  ChannelType,
  GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  formatDuration,
  joinLinesWithinLimit,
  parseDurationMs,
  replyEmbed,
} from "./util.js";

// ------------------------------------------
// 📏 定数とモデレーションログ
// ------------------------------------------
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// 📨 モデレーション操作を設定済みのモデレーションログへ送る
export async function sendModLog(
  client: Client,
  store: MabusabaStore,
  guildId: string,
  title: string,
  description: string,
): Promise<void> {
  const channelId = store.getModLog(guildId);
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    !channel.isSendable()
  )
    return;
  await channel
    .send({ embeds: [buildEmbed(title, description, EMBED_COLOR_INFO)] })
    .catch(() => undefined);
}

// 🚨 荒らし対策の自動タイムアウトを運営ログへ残す際の文面。
// 成否は実際に起きたとおりに書く: 以前は timeout() の失敗を
// 握りつぶしたまま「タイムアウトしました」と記録しており、
// 監査証跡として運営が誤認する問題があった。
export function autoTimeoutLogDescription(input: {
  userId: string;
  timeoutMs: number;
  in5s: number;
  sameIn10s: number;
  succeeded: boolean;
}): string {
  const reason = `理由：短時間の連投（${input.in5s}件/5秒）または同一内容の連投（${input.sameIn10s}件/10秒）を検知`;
  if (input.succeeded) {
    return `<@${input.userId}> を ${formatDuration(input.timeoutMs)} タイムアウトしました。\n${reason}`;
  }
  return `<@${input.userId}> への ${formatDuration(input.timeoutMs)} タイムアウトに失敗しました（権限・ロール階層を確認してください）。\n${reason}`;
}

// ------------------------------------------
// 🔐 権限と階層のチェック
// ------------------------------------------
function requireGuild(interaction: ChatInputCommandInteraction): string | null {
  return interaction.guildId;
}

// 📌 /mod にはコマンド全体の既定権限を持たせていない（サブコマンド
// ごとに必要な権限が違う）ため、各サブコマンドがここで実行時チェックする
async function requirePerm(
  interaction: ChatInputCommandInteraction,
  perm: bigint,
  label: string,
): Promise<boolean> {
  if (interaction.memberPermissions?.has(perm)) return true;
  await replyEmbed(
    interaction,
    "🛡️ 権限がありません",
    `この操作には「${label}」権限が必要です。`,
    EMBED_COLOR_ERROR,
  );
  return false;
}

// ⚖️ 実行者と対象の役職階層: Discord がタイムアウト・キック・BAN で
// 確認するのは Bot の役職位置だけなので、これがないとモデレーターが
// 自分と同等以上の相手（別のモデレーターや、Bot より下位でも管理者
// 権限を持つ人）を処罰できてしまう。サーバーオーナーは保護対象以外
// の誰にでも実行でき、自分自身には誰も実行できない。
export type HierarchyBlockReason =
  "self" | "bot" | "owner" | "administrator" | "unknown-executor" | "outranks";

export interface HierarchyCheckInput {
  executorId: string;
  targetId: string;
  guildOwnerId: string | null | undefined;
  botUserId: string | null | undefined;
  // 📌 null は実行者のメンバー情報を取得できず、最上位ロールの位置が
  // 不明なことを表す
  executorHighestPosition: number | null;
  targetHighestPosition: number;
  targetHasAdministrator: boolean;
}

// 🧮 requireHierarchy の純粋な判定部分（Gateway なしでテストできるよう分離）。
// 保護対象は実行者が誰でも一律に拒否する: Bot 自身、サーバーオーナー、
// Administrator 保有者（役職位置だけでは Administrator を捉えられない）。
// 実行者の位置が不明な場合は、通すのではなく安全側に倒す（fail closed）。
export function hierarchyBlockReason(
  input: HierarchyCheckInput,
): HierarchyBlockReason | null {
  if (input.targetId === input.executorId) return "self";
  if (input.botUserId && input.targetId === input.botUserId) return "bot";
  if (input.guildOwnerId && input.targetId === input.guildOwnerId)
    return "owner";
  if (input.targetHasAdministrator) return "administrator";
  if (input.guildOwnerId && input.executorId === input.guildOwnerId)
    return null;
  if (input.executorHighestPosition === null) return "unknown-executor";
  if (input.targetHighestPosition >= input.executorHighestPosition)
    return "outranks";
  return null;
}

const HIERARCHY_BLOCK_MESSAGES: Record<HierarchyBlockReason, string> = {
  self: "自分自身には実行できません。",
  bot: "Bot 自身には実行できません。",
  owner: "サーバーオーナーには実行できません。",
  administrator: "Administrator 権限を持つメンバーには実行できません。",
  "unknown-executor":
    "実行者の役職情報を取得できなかったため、安全のため実行できません。",
  outranks: "自分と同等以上の役職のメンバーには実行できません。",
};

// 📌 interaction.member が GuildMember なのはキャッシュ経由の場合だけ。
// GuildMembers インテントなしではロールを持たない API オブジェクトに
// なることがあるため、その場合は実行者のメンバーを取得し直し、
// 取得できなければ安全側に倒す（null）。
async function resolveExecutorMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  if (interaction.member instanceof GuildMember) return interaction.member;
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function requireHierarchy(
  interaction: ChatInputCommandInteraction,
  target: GuildMember,
): Promise<boolean> {
  const executor = await resolveExecutorMember(interaction);
  const reason = hierarchyBlockReason({
    executorId: interaction.user.id,
    targetId: target.id,
    guildOwnerId: interaction.guild?.ownerId,
    botUserId: interaction.client.user?.id,
    executorHighestPosition: executor ? executor.roles.highest.position : null,
    targetHighestPosition: target.roles.highest.position,
    targetHasAdministrator:
      target.permissions?.has(PermissionFlagsBits.Administrator) ?? false,
  });
  if (!reason) return true;
  await replyEmbed(
    interaction,
    "🛡️ 実行できません",
    HIERARCHY_BLOCK_MESSAGES[reason],
    EMBED_COLOR_ERROR,
  );
  return false;
}

// ⏳ メンバー取得・処罰・一括削除など Discord API 呼び出しが初回応答の
// 3秒枠を超えうるサブコマンドは先に defer する（Unknown Interaction 回避）。
// replyEmbed は defer 済みの応答を editReply で完成させる。
async function deferEphemeral(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}

// ------------------------------------------
// ⌨️ コマンド処理
// ------------------------------------------
export async function handleModCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  const guildId = requireGuild(interaction);
  if (!guildId || !interaction.guild) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const sub = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);

  // ----- 📨 ログ設定（/mod log set|disable） -----
  if (group === "log") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ManageGuild,
        "サーバーの管理",
      ))
    )
      return;
    if (sub === "disable") {
      store.deleteModLog(guildId);
      await replyEmbed(
        interaction,
        "🛡️ モデレーションログを止めました",
        "モデレーションログの送信を止めます。",
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
    const channel = interaction.options.getChannel("channel", true);
    store.setModLog(guildId, channel.id);
    await replyEmbed(
      interaction,
      "🛡️ モデレーションログを設定しました",
      `モデレーションログを <#${channel.id}> に送信します。`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }

  // ----- ⚠️ 警告（/mod warn add|list） -----
  if (group === "warn") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "メンバーをモデレート",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    if (sub === "list") {
      const warns = store.listWarns(guildId, user.id);
      if (!warns.length) {
        await replyEmbed(
          interaction,
          `⚠️ <@${user.id}> の警告`,
          "警告はありません。",
        );
        return;
      }
      const lines = warns.map(
        (w) =>
          `#${w.id}　<t:${Math.floor(w.created_at_ms / 1000)}:f>　<@${w.moderator_id}>\n　${w.reason || "（理由なし）"}`,
      );
      // 📌 長い警告履歴は埋め込み説明文の上限（4096字）を超えて
      // 返信全体が失敗するため、上限内に収めて省略件数を添える
      const { text, omitted } = joinLinesWithinLimit(lines);
      await replyEmbed(
        interaction,
        `⚠️ <@${user.id}> の警告（${warns.length}件）`,
        omitted ? `${text}\n…他 ${omitted} 件（古い警告は省略）` : text,
      );
      return;
    }
    // add — 必須の user が任意の reason より前に来る
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    const id = store.addWarn(guildId, user.id, interaction.user.id, reason);
    await replyEmbed(
      interaction,
      "⚠️ 警告を追加しました",
      `<@${user.id}> に警告 #${id} を追加しました。\n理由：${reason}\n累計：${store.countWarns(guildId, user.id)}件`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "⚠️ 警告",
      `<@${user.id}> に警告 #${id} を追加（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 🔇 タイムアウト -----
  if (sub === "timeout") {
    await deferEphemeral(interaction);
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "メンバーをモデレート",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const durationInput = interaction.options.getString("duration", true);
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    const ms = parseDurationMs(durationInput);
    if (ms === null || ms > MAX_TIMEOUT_MS) {
      await replyEmbed(
        interaction,
        "⚠️ 期間を読み取れませんでした",
        "例：`10m` / `1h` / `1d` / `30分` / `2時間`（最大28日）",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      await replyEmbed(
        interaction,
        "⚠️ メンバーが見つかりません",
        "指定したユーザーはこのサーバーにいません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (!(await requireHierarchy(interaction, member))) return;
    try {
      await member.timeout(ms, reason);
    } catch (error) {
      console.error("[mabusaba] timeout failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ タイムアウトできませんでした",
        "Botの権限が不足しているか、役職の階層が足りません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔇 タイムアウトしました",
      `<@${user.id}> を ${formatDuration(ms)} タイムアウトしました。\n理由：${reason}`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔇 タイムアウト",
      `<@${user.id}> を ${formatDuration(ms)} タイムアウト（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 🔊 タイムアウト解除 -----
  if (sub === "untimeout") {
    await deferEphemeral(interaction);
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "メンバーをモデレート",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      await replyEmbed(
        interaction,
        "⚠️ メンバーが見つかりません",
        "指定したユーザーはこのサーバーにいません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    // 📌 解除もモデレーション操作: 階層チェックがないと、下位の
    // モデレーターが上位の課したタイムアウトを（自分のものも含め）
    // 取り消せてしまう
    if (!(await requireHierarchy(interaction, member))) return;
    try {
      await member.timeout(null);
    } catch (error) {
      console.error("[mabusaba] untimeout failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ タイムアウト解除できませんでした",
        "Botの権限が不足している可能性があります。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔊 タイムアウトを解除しました",
      `<@${user.id}> のタイムアウトを解除しました。`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔊 タイムアウト解除",
      `<@${user.id}> のタイムアウトを解除（実行者：<@${interaction.user.id}>）`,
    );
    return;
  }

  // ----- 👢 キック -----
  if (sub === "kick") {
    await deferEphemeral(interaction);
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.KickMembers,
        "メンバーをキック",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      await replyEmbed(
        interaction,
        "⚠️ メンバーが見つかりません",
        "指定したユーザーはこのサーバーにいません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (!(await requireHierarchy(interaction, member))) return;
    try {
      await member.kick(reason);
    } catch (error) {
      console.error("[mabusaba] kick failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ キックできませんでした",
        "Botの権限が不足しているか、役職の階層が足りません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "👢 キックしました",
      `<@${user.id}> をキックしました。\n理由：${reason}`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "👢 キック",
      `<@${user.id}> をキック（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 🔨 バン -----
  if (sub === "ban") {
    await deferEphemeral(interaction);
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.BanMembers,
        "メンバーをBAN",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const deleteDays = interaction.options.getInteger("delete-days") ?? 0;
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    // 📌 非メンバーへの先行 BAN は許可する。対象がメンバーの場合は
    // 実行者の階層チェックも適用する
    const targetMember = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (targetMember && !(await requireHierarchy(interaction, targetMember)))
      return;
    try {
      await interaction.guild.members.ban(user.id, {
        deleteMessageDays: deleteDays,
        reason,
      });
    } catch (error) {
      console.error("[mabusaba] ban failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ BANできませんでした",
        "Botの権限が不足しているか、役職の階層が足りません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔨 BANしました",
      `<@${user.id}> をBANしました。\n理由：${reason}${deleteDays ? `\n過去${deleteDays}日分のメッセージを削除しました。` : ""}`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔨 BAN",
      `<@${user.id}> をBAN（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 🔓 バン解除 -----
  if (sub === "unban") {
    await deferEphemeral(interaction);
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.BanMembers,
        "メンバーをBAN",
      ))
    )
      return;
    const userId = interaction.options.getString("user-id", true).trim();
    try {
      await interaction.guild.members.unban(userId);
    } catch (error) {
      console.error("[mabusaba] unban failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ BAN解除できませんでした",
        "ユーザーIDを確認してください。BANされていないか、権限が不足している可能性があります。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔓 BANを解除しました",
      `<@${userId}> のBANを解除しました。`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔓 BAN解除",
      `<@${userId}> のBANを解除（実行者：<@${interaction.user.id}>）`,
    );
    return;
  }

  // ----- 🗑️ メッセージ一括削除 -----
  if (sub === "clear") {
    await deferEphemeral(interaction);
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ManageGuild,
        "サーバーの管理",
      ))
    )
      return;
    const count = interaction.options.getInteger("count", true);
    const channel = interaction.channel;
    if (!channel || !("bulkDelete" in channel)) {
      await replyEmbed(
        interaction,
        "⚠️ サーバー内で使用してください",
        "このコマンドはサーバーのテキストチャンネルで使用してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    try {
      const deleted = await channel.bulkDelete(count, true);
      await replyEmbed(
        interaction,
        "🗑️ メッセージを削除しました",
        `${deleted.size}件のメッセージを削除しました。`,
        EMBED_COLOR_SUCCESS,
      );
      await sendModLog(
        client,
        store,
        guildId,
        "🗑️ メッセージ一括削除",
        `<#${channel.id}> で ${deleted.size}件を削除（実行者：<@${interaction.user.id}>）`,
      );
    } catch (error) {
      console.error("[mabusaba] clear failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ 削除できませんでした",
        "14日より前のメッセージは一括削除できません。Botの権限も確認してください。",
        EMBED_COLOR_ERROR,
      );
    }
    return;
  }

  await replyEmbed(
    interaction,
    "⚠️ 不明なサブコマンドです",
    "不明なサブコマンドです。",
    EMBED_COLOR_ERROR,
  );
}
