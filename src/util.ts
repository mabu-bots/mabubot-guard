// ==========================================
// 🧰 共通ユーティリティ（埋め込み・期間・実行ログ）
// ==========================================
import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";

// ------------------------------------------
// 🎨 埋め込みの共通部品
// ------------------------------------------
// 📌 すべての返信は埋め込みで統一する（プレーンテキストは使わない）
export const EMBED_COLOR_INFO = 0x5865f2;
export const EMBED_COLOR_SUCCESS = 0x57f287;
export const EMBED_COLOR_ERROR = 0xed4245;
export const EMBED_FOOTER = "✨ まぶさば";

export function buildEmbed(
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: EMBED_FOOTER })
    .setTimestamp(new Date());
  if (fields?.length) embed.addFields(fields);
  return embed;
}

// 📨 コマンド返信の共通経路。限定表示（ephemeral）でも埋め込みは使える。
// deferReply 済みで未返信の場合は editReply で初回応答を完成させる
// （followUp だと「考え中…」のプレースホルダが残ってしまうため）。
export async function replyEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  ephemeral = true,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): Promise<void> {
  const embed = buildEmbed(title, description, color, fields);
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
  } else if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ embeds: [embed], ephemeral });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral });
  }
}

// ------------------------------------------
// ⏱️ 時刻・期間の変換
// ------------------------------------------
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (minutes) parts.push(`${minutes}分`);
  // 📌 より大きい単位で割り切れる場合を除き、秒は常に出す
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join("");
}

// 🕐 期間のパース（/mod timeout など）。
// `30s` / `10m` / `1h` / `1d` / `1w`、日本語の `30秒` / `10分` /
// `2時間` / `3日` / `1週間`、組み合わせ `1時間30分` / `1d12h` を受ける。
// 単位なしの数値だけの場合は分として読む。使えない入力は null。
export function parseDurationMs(input: string): number | null {
  const text = input
    .trim()
    .replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)))
    .replace(/　/g, " ")
    .replace(/\s+/g, "");
  if (!text) return null;
  const unitMs: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)(?:週間|週|w)/, 7 * 86400000],
    [/(\d+(?:\.\d+)?)(?:日|d)/, 86400000],
    [/(\d+(?:\.\d+)?)(?:時間|時|h)/, 3600000],
    [/(\d+(?:\.\d+)?)(?:分|min|m)/, 60000],
    [/(\d+(?:\.\d+)?)(?:秒|sec|s)/, 1000],
  ];
  let total = 0;
  let matched = false;
  let rest = text;
  for (const [re, ms] of unitMs) {
    const m = rest.match(re);
    if (m) {
      matched = true;
      total += Number(m[1]) * ms;
      rest = rest.replace(m[0], "");
    }
  }
  if (!matched && /^\d+(?:\.\d+)?$/.test(rest)) {
    total = Number(rest) * 60000;
    matched = true;
    rest = "";
  }
  if (!matched || rest !== "" || total <= 0) return null;
  return total;
}

// ------------------------------------------
// 🔧 汎用ユーティリティ
// ------------------------------------------
// 📄 埋め込みの説明文の上限（4096字）を超えないよう行を連結する。
// 入らなかった行は捨て、件数を omitted で返す（返信全体を失敗させない）。
export function joinLinesWithinLimit(
  lines: string[],
  maxChars = 3800,
): { text: string; omitted: number } {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + (kept.length ? 1 : 0) + line.length;
    if (next > maxChars) break;
    kept.push(line);
    length = next;
  }
  return { text: kept.join("\n"), omitted: lines.length - kept.length };
}

// ------------------------------------------
// 📝 コマンド実行ログ
// ------------------------------------------
// コマンドが実行されるたびに標準出力へ1行残す（pm2 の out ログに残る）。
// 書式は艦隊で統一する:
//   [exec] <ISO時刻> cmd=<名前> route=<slash|context|prefix>
//          guild=<ID> channel=<ID> user=<ID> result=<ok|error>
// 失敗時は末尾に error="<要点>" を付ける。記録するのはコマンド名・
// ID類・成否のみで、ユーザーの入力テキストは記録しない。運営ログ
// （Discord 送信）とは別に「コマンドが呼ばれた事実」を残すための記録。
export interface CommandExecLogInput {
  commandName: string;
  route: "slash" | "context" | "prefix";
  guildId: string | null;
  channelId: string | null;
  userId: string;
  error?: unknown;
  now?: Date;
}

export function formatCommandExecLog(input: CommandExecLogInput): string {
  const at = (input.now ?? new Date()).toISOString();
  const base =
    `[exec] ${at} cmd=${input.commandName} route=${input.route} ` +
    `guild=${input.guildId ?? "-"} channel=${input.channelId ?? "-"} ` +
    `user=${input.userId} result=${input.error ? "error" : "ok"}`;
  if (!input.error) return base;
  const raw =
    input.error instanceof Error ? input.error.message : String(input.error);
  // 📌 1行書式を保つため、空白類と引用符を潰して短くする
  const summary = raw
    .replace(/[\s"]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base} error="${summary}"`;
}

export function logCommandExec(input: CommandExecLogInput): void {
  console.log(formatCommandExecLog(input));
}
