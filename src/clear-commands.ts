// ==========================================
// 🧹 アプリケーションコマンドの全削除
// ==========================================
// 📌 `npm run sync:commands` のあとも古いコマンドが残るときに使う。
// 上書き同期が置き換えるのは「このアプリのグローバルコマンド」だけ
// なので、次のものは消せない:
//  - ギルド限定コマンド（サーバーごとに登録される別エンドポイント）
//  - 別アプリケーション（旧プログラム）のコマンド
//
// 使い方:
//   # このアプリのグローバル＋1ギルド分のコマンド:
//   DISCORD_GUILD_ID=<guild id> npm run clear:commands
//
//   # 別プログラムのコマンド（そのアプリのトークン／IDで実行する。
//   # このアプリの .env を旧認証情報で上書きせず、このコマンドの
//   # シェルでだけ渡すこと）:
//   DISCORD_TOKEN=<redacted> DISCORD_APPLICATION_ID=<old app id> npm run clear:commands
//
// 環境変数はシェルに export するか systemd の EnvironmentFile で渡す。
// このファイルは .env を読まない（dotenv に依存しない）。
// DISCORD_GUILD_ID / DISCORD_GUILD_IDS（カンマ区切り）は任意。
import { REST, Routes } from "discord.js";

// ------------------------------------------
// ⚙️ 環境変数の読み込み
// ------------------------------------------
const token = process.env.DISCORD_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
if (!token || !applicationId) {
  console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required.");
  process.exit(1);
}
const guildIds = [
  ...new Set(
    (process.env.DISCORD_GUILD_IDS ?? process.env.DISCORD_GUILD_ID ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

// ------------------------------------------
// 🧹 コマンド削除処理
// ------------------------------------------
const rest = new REST({ version: "10" }).setToken(token);

async function clearScope(label: string, route: `/${string}`): Promise<void> {
  const before = (await rest.get(route)) as Array<{ name: string }>;
  const beforeNames = before.map((c) => c.name).sort();
  if (!before.length) {
    console.log(`${label}: no commands to delete.`);
    return;
  }
  // 📌 PUT [] は空の一式での全置換: すべてのコマンドが削除される
  await rest.put(route, { body: [] });
  const after = (await rest.get(route)) as Array<{ name: string }>;
  if (after.length) {
    console.error(
      `${label}: verification failed, ${after.length} command(s) remain: ${after.map((c) => c.name).join(", ")}.`,
    );
    process.exit(1);
  }
  console.log(
    `${label}: deleted ${before.length} command(s): ${beforeNames.join(", ")}`,
  );
}

// ------------------------------------------
// ▶️ 実行
// ------------------------------------------
await clearScope("Global commands", Routes.applicationCommands(applicationId));
for (const guildId of guildIds) {
  await clearScope(
    `Guild commands (${guildId})`,
    Routes.applicationGuildCommands(applicationId, guildId),
  );
}
console.log("All commands cleared for this application.");
if (!guildIds.length) {
  console.log(
    "Note: guild-scoped commands were not checked. Set DISCORD_GUILD_ID to clear them too.",
  );
}
