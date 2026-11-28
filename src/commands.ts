// ==========================================
// ⌨️ スラッシュコマンド定義と振り分け
// ==========================================
// 📌 すべてのコマンド定義はここに置き、sync-commands.ts が同じ一覧を
// 取り込んで登録する。必須オプションは任意オプションより前に置く
// （逆だと Discord が 50035 で拒否する）。
import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  replyEmbed,
} from "./util.js";
import { handleModCommand } from "./mod.js";
import { handleWatchingCommand } from "./watching.js";
import { raidCommand, handleRaidCommand } from "./raid-commands.js";
import type { RaidManager } from "./raid.js";

// ------------------------------------------
// 🛡️ モデレーション（/mod）
// ------------------------------------------
// 📌 コマンド全体の既定権限は持たせない: サブコマンドごとに必要な
// 権限が異なる（warn/timeout はモデレート、kick はキック、ban/unban
// は BAN、clear/log はサーバーの管理）ため、単一のゲートでは権限を
// 1つだけ持つモデレーターから /mod が見えなくなってしまう。
// 各サブコマンドは mod.ts で実行時チェックする。
export const modCommand = new SlashCommandBuilder()
  .setName("mod")
  .setDescription("モデレーション（警告・タイムアウト・キック・BAN・削除）")
  .addSubcommandGroup((group) =>
    group
      .setName("warn")
      .setDescription("警告の追加・確認")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("ユーザーに警告を追加します")
          .addUserOption((opt) =>
            opt
              .setName("user")
              .setDescription("警告するユーザー")
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("理由").setMaxLength(500),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("ユーザーの警告履歴を表示します")
          .addUserOption((opt) =>
            opt
              .setName("user")
              .setDescription("確認するユーザー")
              .setRequired(true),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("timeout")
      .setDescription("ユーザーをタイムアウトします（最大28日）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("duration")
          .setDescription("期間（例：10m / 1h / 1d / 30分）")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("理由").setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("untimeout")
      .setDescription("ユーザーのタイムアウトを解除します")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("kick")
      .setDescription("ユーザーをキックします")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("理由").setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ban")
      .setDescription("ユーザーをBANします")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー").setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("delete-days")
          .setDescription("削除する過去のメッセージ日数（0〜7）")
          .setMinValue(0)
          .setMaxValue(7),
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("理由").setMaxLength(500),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("unban")
      .setDescription("ユーザーのBANを解除します")
      .addStringOption((opt) =>
        opt
          .setName("user-id")
          .setDescription("BAN解除するユーザーのID")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("メッセージを一括削除します")
      .addIntegerOption((opt) =>
        opt
          .setName("count")
          .setDescription("削除する件数（1〜100）")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("log")
      .setDescription("モデレーションログの通知先")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("モデレーションログの通知先を設定します")
          .addChannelOption((opt) =>
            opt
              .setName("channel")
              .setDescription("通知先チャンネル")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("disable").setDescription("モデレーションログを止めます"),
      ),
  );

// ------------------------------------------
// 👀 ステータス表示（/watching）
// ------------------------------------------
export const watchingCommand = new SlashCommandBuilder()
  .setName("watching")
  .setDescription("視聴中ステータス（○○を視聴中）を設定します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("視聴中ステータスの文言を設定します（Bot全体に適用）")
      .addStringOption((opt) =>
        opt
          .setName("text")
          .setDescription("表示する文言（例：まぶさばを見守り中）")
          .setRequired(true)
          .setMaxLength(128),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("現在の視聴中ステータスを表示します"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("視聴中ステータスを既定（まぶさばを見守り中）に戻します"),
  );

// ------------------------------------------
// ⚙️ その他（/ping・/help）
// ------------------------------------------
export const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("mabubot-guard の応答状態を確認します");

export const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("mabubot-guard のコマンド一覧を表示します");

// ------------------------------------------
// 📋 コマンド一覧とヘルプ文
// ------------------------------------------
export const allCommands = [
  modCommand,
  raidCommand,
  watchingCommand,
  pingCommand,
  helpCommand,
];

const HELP_TEXT = [
  "**🛡️ モデレーション**\n`/mod warn add|list` `/mod timeout` `/mod untimeout` `/mod kick` `/mod ban` `/mod unban` `/mod clear` `/mod log set|disable`\n短時間の連投・同一内容の連投は自動で10分タイムアウトします。",
  "**🚨 レイド防御**\n`/raid status|on|off|set|setup|watch-off`\n参加バーストを検知して運営ログへ通知します。レイドモードの発動はボタン承認または `/raid on` です。",
  "**⚙️ その他**\n`/watching set|show|reset`（管理者） ／ `/ping`",
].join("\n\n");

// ------------------------------------------
// ⌨️ コマンド処理
// ------------------------------------------
export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await replyEmbed(
    interaction,
    "✨ mabubot-guard のコマンド一覧",
    HELP_TEXT,
    EMBED_COLOR_INFO,
    false,
  );
}

export async function handlePingCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  await replyEmbed(
    interaction,
    "🏓 Pong!",
    `mabubot-guard は正常に稼働しています。（ping: ${client.ws.ping}ms）`,
    EMBED_COLOR_SUCCESS,
  );
}

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
  raid?: RaidManager,
): Promise<void> {
  switch (interaction.commandName) {
    case "mod":
      await handleModCommand(interaction, client, store);
      break;
    case "raid":
      if (raid) await handleRaidCommand(interaction, store, raid);
      break;
    case "watching":
      await handleWatchingCommand(interaction, client, store);
      break;
    case "ping":
      await handlePingCommand(interaction, client);
      break;
    case "help":
      await handleHelpCommand(interaction);
      break;
    default:
      await replyEmbed(
        interaction,
        "⚠️ 不明なコマンドです",
        "不明なコマンドです。",
        EMBED_COLOR_ERROR,
      );
  }
}
