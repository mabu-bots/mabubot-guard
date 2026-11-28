// ==========================================
// 🚨 レイド防御（検知・段階通知・レイドモード・隔離認証）
// ==========================================
// 📌 運営自動化設計書 §5.8。検知は「量」と「アカウントの若さ」だけに
// 基づく。IP・端末情報は Bot から取得できないため、Alt 検出のような
// 判定はしない。参加しただけ・新しいだけでの自動 BAN/キックはしない。
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { MabusabaStore, RaidSettingsRow } from "./store.js";
import { EMBED_COLOR_ERROR, EMBED_COLOR_INFO, EMBED_FOOTER } from "./util.js";

// ------------------------------------------
// 📏 定数と純粋関数（テスト対象）
// ------------------------------------------
export type RaidStage = "normal" | "watch" | "alert" | "raid";

export interface JoinRecord {
  userId: string;
  atMs: number;
  accountCreatedAtMs: number;
}

export const YOUNG_ACCOUNT_MS = 7 * 24 * 60 * 60_000;
export const AUTO_ACTIVATE_JOINS_1MIN = 20;
export const AUTO_ACTIVATE_YOUNG_RATIO = 0.8;
export const VERIFY_WAIT_MS = 10 * 60_000; // 参加後10分
export const VERIFY_ACCOUNT_AGE_MS = 24 * 60 * 60_000; // 作成後24時間
export const RAID_SPAM_TIMEOUT_MS = 30 * 60_000;

// 🔢 窓の中の参加件数
export function countInWindow(
  joins: JoinRecord[],
  now: number,
  windowMs: number,
): number {
  return joins.filter((j) => now - j.atMs <= windowMs).length;
}

// 📊 窓の中の「作成7日未満アカウント」の割合（参加ゼロなら 0）
export function youngRatio(
  joins: JoinRecord[],
  now: number,
  windowMs: number,
): number {
  const recent = joins.filter((j) => now - j.atMs <= windowMs);
  if (!recent.length) return 0;
  const young = recent.filter(
    (j) => now - j.accountCreatedAtMs < YOUNG_ACCOUNT_MS,
  ).length;
  return young / recent.length;
}

// 🚦 段階判定: 検知だけで処分はしない（§5.8.2）
export function evaluateStage(
  joins: JoinRecord[],
  now: number,
  settings: Pick<
    RaidSettingsRow,
    "watch_joins" | "alert_joins_min" | "alert_joins_5min" | "young_ratio"
  >,
): Exclude<RaidStage, "raid"> {
  const in1m = countInWindow(joins, now, 60_000);
  const in5m = countInWindow(joins, now, 5 * 60_000);
  const young = youngRatio(joins, now, 5 * 60_000);
  if (
    in1m >= settings.alert_joins_min ||
    in5m >= settings.alert_joins_5min ||
    (in5m >= settings.watch_joins && young >= 0.7)
  )
    return "alert";
  if (
    in5m >= settings.watch_joins ||
    (in5m >= 5 && young >= settings.young_ratio)
  )
    return "watch";
  return "normal";
}

// ⚡ 自動発動の二重条件（1分20人以上 かつ 新規率80%以上）
export function shouldAutoActivate(joins: JoinRecord[], now: number): boolean {
  return (
    countInWindow(joins, now, 60_000) >= AUTO_ACTIVATE_JOINS_1MIN &&
    youngRatio(joins, now, 5 * 60_000) >= AUTO_ACTIVATE_YOUNG_RATIO
  );
}

// 🔐 認証の3条件（§5.8.5）のうち時刻の2条件を判定する。
// ボタン押下そのものは呼び出し側で確認済みとする。通過できれば null。
export function verifyBlockReason(
  joinedAtMs: number,
  accountCreatedAtMs: number,
  now: number,
): string | null {
  if (now - accountCreatedAtMs < VERIFY_ACCOUNT_AGE_MS)
    return "アカウント作成から24時間が経過していません。経過後に再度お試しください（閲覧はそのまま可能です）。";
  if (now - joinedAtMs < VERIFY_WAIT_MS)
    return "参加から10分が経過していません。少し待ってから再度お試しください。";
  return null;
}

const STAGE_ORDER: Record<RaidStage, number> = {
  normal: 0,
  watch: 1,
  alert: 2,
  raid: 3,
};

// 📋 低速モード対象チャンネルの JSON 配列を読み出す（壊れていれば空）
export function parseChannelList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

// ------------------------------------------
// 🛡️ レイドマネージャー
// ------------------------------------------
interface GuildRaidState {
  joins: JoinRecord[];
  stage: RaidStage;
  calmSinceMs: number | null;
}

export class RaidManager {
  private states = new Map<string, GuildRaidState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private client: Client,
    private store: MabusabaStore,
  ) {}

  // ▶️ 30秒間隔の定期処理を開始する（二重開始はしない）
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error("[raid] tick failed:", e));
    }, 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stageOf(guildId: string): RaidStage {
    const settings = this.store.getRaidSettings(guildId);
    if (settings.raid_until_ms > Date.now()) return "raid";
    return this.state(guildId).stage;
  }

  isRaidActive(guildId: string): boolean {
    return this.store.getRaidSettings(guildId).raid_until_ms > Date.now();
  }

  recentJoins(guildId: string): JoinRecord[] {
    return [...this.state(guildId).joins];
  }

  private state(guildId: string): GuildRaidState {
    let s = this.states.get(guildId);
    if (!s) {
      s = { joins: [], stage: "normal", calmSinceMs: null };
      this.states.set(guildId, s);
    }
    return s;
  }

  // ----- 👋 参加・退出 -----
  async onMemberJoin(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const now = Date.now();
    const s = this.state(guild.id);
    s.joins = s.joins.filter((j) => now - j.atMs <= 15 * 60_000);
    s.joins.push({
      userId: member.id,
      atMs: now,
      accountCreatedAtMs: member.user.createdTimestamp,
    });

    const settings = this.store.getRaidSettings(guild.id);
    const open = this.store.getOpenRaidEvent(guild.id);
    if (open) this.store.bumpRaidEvent(open.id, "joins");

    // 🚧 隔離: レイドモード中、または常時化が有効な場合
    if (
      (settings.raid_until_ms > now || settings.gating_always === 1) &&
      !member.user.bot
    ) {
      await this.quarantineMember(member, settings);
    }

    if (settings.watch_off_until_ms > now) return; // 記録のみ、通知しない

    // ⚡ 自動発動（二重条件・設定で有効化した場合のみ、§5.8.4 方法3）
    if (
      settings.auto_activate === 1 &&
      settings.raid_until_ms <= now &&
      shouldAutoActivate(s.joins, now)
    ) {
      await this.activate(guild, "auto");
      return;
    }

    // 🚦 段階遷移（レイドモード中は検知段階を動かさない）
    if (settings.raid_until_ms > now) return;
    const next = evaluateStage(s.joins, now, settings);
    if (STAGE_ORDER[next] > STAGE_ORDER[s.stage]) {
      const prev = s.stage;
      s.stage = next;
      s.calmSinceMs = null;
      await this.onStageUp(guild, prev, next, settings);
    }
  }

  async onMemberRemove(member: { guild: Guild; id: string }): Promise<void> {
    const open = this.store.getOpenRaidEvent(member.guild.id);
    if (open) this.store.bumpRaidEvent(open.id, "leaves");
    this.store.removeQuarantine(member.guild.id, member.id);
  }

  // ----- 🔔 段階上昇の通知 -----
  private async onStageUp(
    guild: Guild,
    _prev: RaidStage,
    next: Exclude<RaidStage, "raid">,
    settings: RaidSettingsRow,
  ): Promise<void> {
    const now = Date.now();
    const s = this.state(guild.id);
    const in5m = countInWindow(s.joins, now, 5 * 60_000);
    const young = Math.round(youngRatio(s.joins, now, 5 * 60_000) * 100);
    if (next === "watch") {
      let ev = this.store.getOpenRaidEvent(guild.id);
      if (!ev) {
        const id = this.store.createRaidEvent(guild.id, "watch");
        ev = this.store.getRaidEvent(id);
      }
      await this.sendModLog(
        guild.id,
        "👀 レイド検知：注意",
        `参加が増えています（直近5分で ${in5m} 人、作成7日未満 ${young}%）。\n現時点では通知のみで、権限への操作はしていません。`,
        EMBED_COLOR_INFO,
      );
    } else if (next === "alert") {
      let ev = this.store.getOpenRaidEvent(guild.id);
      if (!ev) {
        const id = this.store.createRaidEvent(guild.id, "alert");
        ev = this.store.getRaidEvent(id);
      } else if (ev.peak_stage !== "alert") {
        this.store.updateRaidEvent(ev.id, { peak_stage: "alert" });
      }
      const recent = s.joins
        .slice(-10)
        .map(
          (j) =>
            `<@${j.userId}>（作成 ${new Date(j.accountCreatedAtMs).toISOString().slice(0, 10)}）`,
        )
        .join("\n");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`raidon:${ev?.id ?? 0}`)
          .setLabel("レイドモードを発動")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`raidignore:${ev?.id ?? 0}`)
          .setLabel("誤報として閉じる")
          .setStyle(ButtonStyle.Secondary),
      );
      await this.sendModLog(
        guild.id,
        "🚨 レイド検知：警戒",
        `参加バーストを検知しました（直近5分で ${in5m} 人、作成7日未満 ${young}%）。\n直近の参加者:\n${recent}\n\n発動すると招待の一時停止・低速モード・新規参加の隔離をまとめて適用します（既定 ${settings.duration_minutes} 分）。`,
        EMBED_COLOR_ERROR,
        [row],
      );
    }
  }

  // ----- 🚧 隔離と認証 -----
  private async quarantineMember(
    member: GuildMember,
    settings: RaidSettingsRow,
  ): Promise<void> {
    const guildId = member.guild.id;
    const already = this.store.getQuarantine(guildId, member.id);
    this.store.addQuarantine(
      guildId,
      member.id,
      new Date(member.joinedTimestamp ?? Date.now()).toISOString(),
      new Date(member.user.createdTimestamp).toISOString(),
    );
    if (settings.quarantine_role_id) {
      await member.roles
        .add(settings.quarantine_role_id, "レイド防御：隔離")
        .catch(() => undefined);
    }
    if (!already) {
      const open = this.store.getOpenRaidEvent(guildId);
      if (open) this.store.bumpRaidEvent(open.id, "quarantined");
    }
  }

  // 🔐 認証ボタン（raidverify）の処理。押した本人のみ対象。
  async handleVerifyButton(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId || !interaction.guild) {
      await interaction.reply({
        content: "サーバー内でのみ使えます。",
        ephemeral: true,
      });
      return;
    }
    const settings = this.store.getRaidSettings(guildId);
    const q = this.store.getQuarantine(guildId, interaction.user.id);
    if (!q) {
      await interaction.reply({
        content:
          "あなたは隔離対象ではありません（すでに認証済みか、隔離が有効ではありません）。",
        ephemeral: true,
      });
      return;
    }
    if (q.verified_at) {
      await interaction.reply({ content: "認証済みです。", ephemeral: true });
      return;
    }
    const reason = verifyBlockReason(
      Date.parse(q.joined_at),
      Date.parse(q.account_created_at),
      Date.now(),
    );
    if (reason) {
      await interaction.reply({ content: reason, ephemeral: true });
      return;
    }
    const member = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (!member) {
      await interaction.reply({
        content: "メンバー情報を取得できませんでした。",
        ephemeral: true,
      });
      return;
    }
    if (settings.talk_role_id) {
      await member.roles
        .add(settings.talk_role_id, "レイド防御：認証通過")
        .catch(() => undefined);
    }
    if (settings.quarantine_role_id) {
      await member.roles
        .remove(settings.quarantine_role_id, "レイド防御：認証通過")
        .catch(() => undefined);
    }
    this.store.markQuarantineVerified(guildId, interaction.user.id);
    const open = this.store.getOpenRaidEvent(guildId);
    if (open) this.store.bumpRaidEvent(open.id, "verified");
    await interaction.reply({
      content: "✅ 認証が完了しました。発言できるようになりました。",
      ephemeral: true,
    });
  }

  // ----- 🛡️ レイドモード -----
  async activate(guild: Guild, by: string): Promise<string> {
    const settings = this.store.getRaidSettings(guild.id);
    const now = Date.now();
    if (settings.raid_until_ms > now) return "すでにレイドモードが有効です。";
    const until = now + settings.duration_minutes * 60_000;

    let ev = this.store.getOpenRaidEvent(guild.id);
    if (!ev) {
      const id = this.store.createRaidEvent(guild.id, "raid");
      ev = this.store.getRaidEvent(id);
    }

    // 💾 適用前の状態を保存する（解除で正確に戻すため）
    const prevSlow: Record<string, number> = {};
    const channels = parseChannelList(settings.slowmode_channels);
    for (const channelId of channels) {
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (ch && ch.type === ChannelType.GuildText) {
        prevSlow[channelId] = ch.rateLimitPerUser;
        await ch
          .setRateLimitPerUser(settings.slowmode_seconds, "レイドモード")
          .catch(() => undefined);
      }
    }
    if (ev) {
      this.store.updateRaidEvent(ev.id, {
        peak_stage: "raid",
        activated_by: by,
        prev_state: JSON.stringify({ slowmode: prevSlow }),
      });
    }
    // ⏸️ 招待の一時停止（Discord の Incident Actions）
    await guild
      .setIncidentActions({
        invitesDisabledUntil: new Date(until),
        dmsDisabledUntil: null,
      })
      .catch(() => undefined);
    this.store.updateRaidSettings(guild.id, { raid_until_ms: until });
    this.state(guild.id).stage = "raid";

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`raidoff:${ev?.id ?? 0}`)
        .setLabel("レイドモードを解除")
        .setStyle(ButtonStyle.Primary),
    );
    await this.sendModLog(
      guild.id,
      "🛡️ レイドモードを発動しました",
      `発動者: ${by === "auto" ? "自動（二重条件）" : `<@${by}>`}\n期限: ${new Date(until).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST まで（招待停止・低速モード ${settings.slowmode_seconds} 秒・新規参加の隔離）`,
      EMBED_COLOR_ERROR,
      [row],
    );
    return "レイドモードを発動しました。";
  }

  async deactivate(
    guild: Guild,
    by: string,
    falsePositive = false,
  ): Promise<string> {
    const settings = this.store.getRaidSettings(guild.id);
    const ev = this.store.getOpenRaidEvent(guild.id);
    // ↩️ 低速モードの復元
    if (ev?.prev_state) {
      try {
        const prev = JSON.parse(ev.prev_state) as {
          slowmode?: Record<string, number>;
        };
        for (const [channelId, seconds] of Object.entries(
          prev.slowmode ?? {},
        )) {
          const ch = await guild.channels.fetch(channelId).catch(() => null);
          if (ch && ch.type === ChannelType.GuildText) {
            await ch
              .setRateLimitPerUser(seconds, "レイドモード解除")
              .catch(() => undefined);
          }
        }
      } catch {
        // 📌 prev_state が壊れていても解除自体は続ける
      }
    }
    await guild
      .setIncidentActions({
        invitesDisabledUntil: null,
        dmsDisabledUntil: null,
      })
      .catch(() => undefined);
    this.store.updateRaidSettings(guild.id, { raid_until_ms: 0 });
    this.state(guild.id).stage = "normal";
    this.state(guild.id).calmSinceMs = null;

    if (ev) {
      this.store.updateRaidEvent(ev.id, {
        ended_at: new Date().toISOString(),
        false_positive: falsePositive ? 1 : 0,
      });
      const done = this.store.getRaidEvent(ev.id);
      if (done) {
        await this.sendModLog(
          guild.id,
          falsePositive
            ? "レイド検知を誤報として閉じました"
            : "レイドモードを解除しました",
          `解除者: ${by === "system" ? "自動（期限切れ）" : `<@${by}>`}\n期間中の集計: 参加 ${done.joins} / 退出 ${done.leaves} / 自動タイムアウト ${done.auto_timeouts} / 隔離 ${done.quarantined} / 認証通過 ${done.verified}`,
          EMBED_COLOR_INFO,
        );
      }
    }
    return "レイドモードを解除しました。";
  }

  // ----- 🔄 定期処理 -----
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const guild of this.client.guilds.cache.values()) {
      const settings = this.store.getRaidSettings(guild.id);
      const s = this.state(guild.id);
      s.joins = s.joins.filter((j) => now - j.atMs <= 15 * 60_000);
      // ⏰ レイドモードの期限切れ
      if (settings.raid_until_ms > 0 && settings.raid_until_ms <= now) {
        await this.deactivate(guild, "system");
        continue;
      }
      if (settings.raid_until_ms > now) continue;
      // 📉 段階の下げ: 15分間 calm（1分2人未満）が続けば1段階ずつ
      if (s.stage === "watch" || s.stage === "alert") {
        const calm = countInWindow(s.joins, now, 60_000) < 2;
        if (calm) {
          if (s.calmSinceMs === null) s.calmSinceMs = now;
          else if (now - s.calmSinceMs >= 15 * 60_000) {
            const next = s.stage === "alert" ? "watch" : "normal";
            s.stage = next as RaidStage;
            s.calmSinceMs = null;
            if (next === "normal") {
              const ev = this.store.getOpenRaidEvent(guild.id);
              if (ev && !ev.activated_by) {
                this.store.updateRaidEvent(ev.id, {
                  ended_at: new Date().toISOString(),
                });
              }
            }
            await this.sendModLog(
              guild.id,
              "レイド検知：段階が下がりました",
              `現在の段階: ${next}（参加ペースが通常に戻りました）`,
              EMBED_COLOR_INFO,
            );
          }
        } else {
          s.calmSinceMs = null;
        }
      }
    }
  }

  // ----- 📨 モデレーションログ送信（ボタン付き対応） -----
  async sendModLog(
    guildId: string,
    title: string,
    description: string,
    color: number = EMBED_COLOR_INFO,
    components: ActionRowBuilder<ButtonBuilder>[] = [],
  ): Promise<void> {
    const channelId = this.store.getModLog(guildId);
    if (!channelId) return;
    const channel = await this.client.channels
      .fetch(channelId)
      .catch(() => null);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      !channel.isSendable()
    )
      return;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setFooter({ text: EMBED_FOOTER })
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed], components }).catch(() => undefined);
  }

  // ----- 🔐 ボタンの権限確認 -----
  static async requireModerator(
    interaction: ButtonInteraction,
  ): Promise<boolean> {
    const member = interaction.member;
    const perms = member?.permissions;
    const ok =
      perms != null &&
      typeof perms !== "string" &&
      (perms.has(PermissionFlagsBits.ModerateMembers) ||
        perms.has(PermissionFlagsBits.ManageGuild) ||
        perms.has(PermissionFlagsBits.Administrator));
    if (!ok) {
      await interaction.reply({
        content: "この操作にはモデレーター以上の権限が必要です。",
        ephemeral: true,
      });
    }
    return ok;
  }
}
