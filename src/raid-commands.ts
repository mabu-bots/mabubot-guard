// ==========================================
// 🚨 レイド防御コマンド（/raid status|on|off|set|setup|watch-off）
// ==========================================
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  countInWindow,
  parseChannelList,
  youngRatio,
  type RaidManager,
} from "./raid.js";
import { EMBED_COLOR_INFO, EMBED_FOOTER, replyEmbed } from "./util.js";

// ------------------------------------------
// ⌨️ コマンド定義
// ------------------------------------------
// 📌 コマンド全体の既定権限はモデレーター（ModerateMembers）。
// set / setup / watch-off は管理者（ManageGuild）を実行時に追加で要求する。
export const raidCommand = new SlashCommandBuilder()
  .setName("raid")
  .setDescription("レイド防御（参加バースト検知・レイドモード・隔離認証）")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("現在の段階と設定を表示します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("on")
      .setDescription("レイドモードを手動で発動します")
      .addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("継続時間（分）。省略時は設定値（既定60）")
          .setMinValue(5)
          .setMaxValue(720),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("off")
      .setDescription("レイドモードを解除し、適用した変更をすべて戻します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("検知の閾値などを設定します（管理者）")
      .addIntegerOption((opt) =>
        opt
          .setName("watch-joins")
          .setDescription("注意：5分間の参加数")
          .setMinValue(1),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("alert-1min")
          .setDescription("警戒：1分間の参加数")
          .setMinValue(1),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("alert-5min")
          .setDescription("警戒：5分間の参加数")
          .setMinValue(1),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("young-percent")
          .setDescription("注意：作成7日未満の割合（%）")
          .setMinValue(1)
          .setMaxValue(100),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("auto-activate")
          .setDescription("二重条件での自動発動を有効化"),
      )
      .addBooleanOption((opt) =>
        opt.setName("gating-always").setDescription("隔離を常時有効化"),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("slowmode-seconds")
          .setDescription("レイドモード中の低速モード（秒）")
          .setMinValue(0)
          .setMaxValue(21600),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("duration-minutes")
          .setDescription("レイドモードの既定継続時間（分）")
          .setMinValue(5)
          .setMaxValue(720),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("setup")
      .setDescription("対象チャンネルとロールを設定します（管理者）")
      .addChannelOption((opt) =>
        opt
          .setName("slowmode-channel")
          .setDescription("低速モードの対象チャンネル（呼ぶたびに追加）")
          .addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((opt) =>
        opt
          .setName("verify-channel")
          .setDescription("認証ボタンを置くチャンネル")
          .addChannelTypes(ChannelType.GuildText),
      )
      .addRoleOption((opt) =>
        opt
          .setName("talk-role")
          .setDescription("認証通過で付与する発言用ロール"),
      )
      .addRoleOption((opt) =>
        opt.setName("quarantine-role").setDescription("隔離中に付与するロール"),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("watch-off")
      .setDescription("検知の通知を一時的に止めます（記録は続けます・管理者）")
      .addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("停止する時間（分、既定120）")
          .setMinValue(1)
          .setMaxValue(1440),
      ),
  );

// ------------------------------------------
// ⌨️ ハンドラ
// ------------------------------------------
export async function handleRaidCommand(
  interaction: ChatInputCommandInteraction,
  store: MabusabaStore,
  raid: RaidManager,
): Promise<void> {
  const guildId = interaction.guildId;
  const guild = interaction.guild;
  if (!guildId || !guild) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内専用",
      "このコマンドはサーバー内でのみ使えます。",
      EMBED_COLOR_INFO,
      true,
    );
    return;
  }
  const sub = interaction.options.getSubcommand();
  const settings = store.getRaidSettings(guildId);
  const isAdmin =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ??
    false;

  switch (sub) {
    case "status": {
      const now = Date.now();
      const joins = raid.recentJoins(guildId);
      const stage = raid.stageOf(guildId);
      const pending = store.listQuarantine(guildId).length;
      const lines = [
        `段階: **${stage}**`,
        `直近5分の参加: ${countInWindow(joins, now, 5 * 60_000)}人（作成7日未満 ${Math.round(youngRatio(joins, now, 5 * 60_000) * 100)}%）`,
        `閾値: 注意 5分${settings.watch_joins}人 / 警戒 1分${settings.alert_joins_min}人・5分${settings.alert_joins_5min}人`,
        `自動発動: ${settings.auto_activate === 1 ? "有効" : "無効"} ／ 隔離の常時化: ${settings.gating_always === 1 ? "有効" : "レイド中のみ"}`,
        `低速モード対象: ${parseChannelList(settings.slowmode_channels).length}件（${settings.slowmode_seconds}秒）`,
        `隔離中（未認証）: ${pending}人`,
      ];
      if (settings.raid_until_ms > now)
        lines.push(
          `レイドモード期限: ${new Date(settings.raid_until_ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`,
        );
      await replyEmbed(
        interaction,
        "🛡️ レイド防御の状態",
        lines.join("\n"),
        EMBED_COLOR_INFO,
        true,
      );
      return;
    }
    case "on": {
      const minutes = interaction.options.getInteger("minutes");
      if (minutes)
        store.updateRaidSettings(guildId, { duration_minutes: minutes });
      const result = await raid.activate(guild, interaction.user.id);
      await replyEmbed(
        interaction,
        "🛡️ レイドモード",
        result,
        EMBED_COLOR_INFO,
        true,
      );
      return;
    }
    case "off": {
      const result = await raid.deactivate(guild, interaction.user.id);
      await replyEmbed(
        interaction,
        "🛡️ レイドモード",
        result,
        EMBED_COLOR_INFO,
        true,
      );
      return;
    }
    case "set": {
      if (!isAdmin) {
        await replyEmbed(
          interaction,
          "⚠️ 権限不足",
          "設定の変更にはサーバー管理権限が必要です。",
          EMBED_COLOR_INFO,
          true,
        );
        return;
      }
      const patch: Parameters<MabusabaStore["updateRaidSettings"]>[1] = {};
      const watch = interaction.options.getInteger("watch-joins");
      if (watch !== null) patch.watch_joins = watch;
      const a1 = interaction.options.getInteger("alert-1min");
      if (a1 !== null) patch.alert_joins_min = a1;
      const a5 = interaction.options.getInteger("alert-5min");
      if (a5 !== null) patch.alert_joins_5min = a5;
      const young = interaction.options.getInteger("young-percent");
      if (young !== null) patch.young_ratio = young / 100;
      const auto = interaction.options.getBoolean("auto-activate");
      if (auto !== null) patch.auto_activate = auto ? 1 : 0;
      const gating = interaction.options.getBoolean("gating-always");
      if (gating !== null) patch.gating_always = gating ? 1 : 0;
      const slow = interaction.options.getInteger("slowmode-seconds");
      if (slow !== null) patch.slowmode_seconds = slow;
      const dur = interaction.options.getInteger("duration-minutes");
      if (dur !== null) patch.duration_minutes = dur;
      const updated = store.updateRaidSettings(guildId, patch);
      await replyEmbed(
        interaction,
        "🛡️ レイド防御の設定を更新しました",
        `注意 5分${updated.watch_joins}人 / 警戒 1分${updated.alert_joins_min}人・5分${updated.alert_joins_5min}人 / 新規率 ${Math.round(updated.young_ratio * 100)}%\n自動発動: ${updated.auto_activate === 1 ? "有効" : "無効"} ／ 隔離常時化: ${updated.gating_always === 1 ? "有効" : "無効"} ／ 低速 ${updated.slowmode_seconds}秒 ／ 継続 ${updated.duration_minutes}分`,
        EMBED_COLOR_INFO,
        true,
      );
      return;
    }
    case "setup": {
      if (!isAdmin) {
        await replyEmbed(
          interaction,
          "⚠️ 権限不足",
          "設定の変更にはサーバー管理権限が必要です。",
          EMBED_COLOR_INFO,
          true,
        );
        return;
      }
      const patch: Parameters<MabusabaStore["updateRaidSettings"]>[1] = {};
      const slowCh = interaction.options.getChannel("slowmode-channel");
      if (slowCh) {
        const list = parseChannelList(settings.slowmode_channels);
        if (!list.includes(slowCh.id)) list.push(slowCh.id);
        patch.slowmode_channels = JSON.stringify(list);
      }
      const verifyCh = interaction.options.getChannel("verify-channel");
      if (verifyCh) patch.verify_channel_id = verifyCh.id;
      const talk = interaction.options.getRole("talk-role");
      if (talk) patch.talk_role_id = talk.id;
      const quar = interaction.options.getRole("quarantine-role");
      if (quar) patch.quarantine_role_id = quar.id;
      store.updateRaidSettings(guildId, patch);
      // 🔐 認証メッセージを投稿する
      if (verifyCh) {
        const full = await guild.channels.fetch(verifyCh.id).catch(() => null);
        if (full && full.type === ChannelType.GuildText && full.isSendable()) {
          const embed = new EmbedBuilder()
            .setTitle("🔐 参加の認証")
            .setDescription(
              "レイド対策のため、新規参加の方は認証が必要です。\n条件: ルールへの同意として下のボタンを押すこと、参加から10分が経過していること、アカウント作成から24時間が経過していること。\n条件を満たすまでは閲覧のみとなります。",
            )
            .setColor(EMBED_COLOR_INFO)
            .setFooter({ text: EMBED_FOOTER });
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("raidverify")
              .setLabel("ルールに同意して認証する")
              .setStyle(ButtonStyle.Success),
          );
          await full
            .send({ embeds: [embed], components: [row] })
            .catch(() => undefined);
        }
      }
      await replyEmbed(
        interaction,
        "🛡️ レイド防御のセットアップ",
        "設定を保存しました。認証チャンネルを指定した場合は認証メッセージを投稿しました。",
        EMBED_COLOR_INFO,
        true,
      );
      return;
    }
    case "watch-off": {
      if (!isAdmin) {
        await replyEmbed(
          interaction,
          "⚠️ 権限不足",
          "この操作にはサーバー管理権限が必要です。",
          EMBED_COLOR_INFO,
          true,
        );
        return;
      }
      const minutes = interaction.options.getInteger("minutes") ?? 120;
      store.updateRaidSettings(guildId, {
        watch_off_until_ms: Date.now() + minutes * 60_000,
      });
      await replyEmbed(
        interaction,
        "🛡️ 検知通知の一時停止",
        `${minutes} 分間、検知の通知を止めます（記録は続けます）。`,
        EMBED_COLOR_INFO,
        true,
      );
      return;
    }
  }
}
