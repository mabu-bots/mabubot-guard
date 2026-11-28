// ==========================================
// 🚀 エントリポイント（起動・イベント配線・終了処理）
// ==========================================
import { Client, EmbedBuilder, GatewayIntentBits, Partials } from "discord.js";
import { MabusabaStore } from "./store.js";
import { handleChatInputCommand } from "./commands.js";
import { registerEvents } from "./events.js";
import { RaidManager } from "./raid.js";
import { applyWatching } from "./watching.js";
import { EMBED_COLOR_ERROR, EMBED_FOOTER, logCommandExec } from "./util.js";
import { attachReadyWatchdog } from "./watchdog.js";

// ------------------------------------------
// 🏗️ 初期化
// ------------------------------------------
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error(
    "DISCORD_TOKEN is required. Copy .env.example to .env and set it.",
  );
  process.exit(1);
}
const dataDir = process.env.DATA_DIR?.trim() || "./data";
const store = new MabusabaStore(dataDir);

// 📌 Partials: キャッシュにないオブジェクトでもイベントが内容・作者を
// 運んでくるようにするために必要
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: レイド検知に参加検知が必要
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: 荒らし対策に内容が必要
    GatewayIntentBits.GuildModeration, // BAN・BAN解除
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
});

// 🐕 Gateway 安全構造: READY が来ないサイレント停滞を検知して終了する
attachReadyWatchdog(client);

const raid = new RaidManager(client, store);

// ------------------------------------------
// 🏁 起動時の処理
// ------------------------------------------
client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  raid.start();
  // 👀 プレゼンス: 保存済みの文言 → WATCHING_TEXT → 既定値の順で解決し、
  // 実際の表示はプレゼンス・サイクルが担う（watching.ts）
  applyWatching(client, store);
  // 📌 コマンドはここでは同期しない。登録は `npm run sync:commands` の
  // 上書き同期だけが行う（同期で消したコマンドが再起動で復活しないため）
});

// ------------------------------------------
// ⌨️ コマンド・ボタン実行時の処理
// ------------------------------------------
client.on("interactionCreate", async (interaction) => {
  // 🚨 レイド防御のボタン（認証・発動・解除・誤報）
  if (interaction.isButton()) {
    try {
      const id = interaction.customId;
      if (id === "raidverify") {
        await raid.handleVerifyButton(interaction);
        return;
      }
      if (
        id.startsWith("raidon:") ||
        id.startsWith("raidoff:") ||
        id.startsWith("raidignore:")
      ) {
        if (!(await RaidManager.requireModerator(interaction))) return;
        const guild = interaction.guild;
        if (!guild) return;
        if (id.startsWith("raidon:")) {
          const result = await raid.activate(guild, interaction.user.id);
          await interaction.reply({ content: result, ephemeral: true });
        } else if (id.startsWith("raidoff:")) {
          const result = await raid.deactivate(guild, interaction.user.id);
          await interaction.reply({ content: result, ephemeral: true });
        } else {
          const eventId = Number(id.split(":")[1]);
          const ev = Number.isFinite(eventId)
            ? store.getRaidEvent(eventId)
            : null;
          if (ev && !ev.activated_by) {
            store.updateRaidEvent(ev.id, {
              ended_at: new Date().toISOString(),
              false_positive: 1,
            });
          } else if (ev) {
            await raid.deactivate(guild, interaction.user.id, true);
          }
          await interaction.reply({
            content: "誤報として閉じました。",
            ephemeral: true,
          });
        }
        return;
      }
    } catch (error) {
      console.error("[raid] button failed:", error);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  // 📝 コマンド実行ログ（util.ts）: コマンド名・ID類・成否のみを1行残す
  const execLog = {
    commandName: interaction.commandName,
    route: "slash" as const,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
  };
  try {
    await handleChatInputCommand(interaction, client, store, raid);
    logCommandExec(execLog);
  } catch (error) {
    logCommandExec({ ...execLog, error });
    console.error("interaction failed", error);
    // 📌 reply() が使えるのは未応答のときだけ: 応答済み・defer 済みの
    // 場合は followUp でないと投げられず、利用者に何も見えなくなる
    const embed = new EmbedBuilder()
      .setTitle("⚠️ 処理に失敗しました")
      .setDescription("処理に失敗しました。")
      .setColor(EMBED_COLOR_ERROR)
      .setFooter({ text: EMBED_FOOTER })
      .setTimestamp(new Date());
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    }
  }
});

// ------------------------------------------
// 📡 イベント登録と終了処理
// ------------------------------------------
registerEvents(client, store, raid);

// 📌 ログのみのグローバルハンドラ: これらがないと、浮いた rejection や
// Gateway/クライアントのエラーが文脈なしの未処理 rejection になり、
// 最近の Node ではプロセス終了にもつながる。記録すれば Bot は生き続け、
// 診断の手がかりも残る。
client.on("error", (error) => {
  console.error("[mabusaba] client error:", error);
});
client.on("shardError", (error) => {
  console.error("[mabusaba] shard error:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[mabusaba] unhandled rejection:", reason);
});

process.on("SIGINT", () => {
  raid.stop();
  store.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  raid.stop();
  store.close();
  process.exit(0);
});

await client.login(token);
