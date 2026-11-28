# まぶさばボット（mabubot-guard）

| 項目 | 内容 |
| --- | --- |
| バージョン | v1.0.0 |
| 状態 | 稼働中 |
| 稼働先 | 台2（ConoHa VPS、pm2 アプリ名 `mabubot-guard`） |
| 実装 | TypeScript + discord.js v14 / Node 24 / SQLite（`node:sqlite`） |

まぶさばボット（mabubot）を機能グループごとに切り分けたうちの、**管理系**担当の Bot です。元の mabubot から `mod` と `watching` を分離し、レイド防御（v0.2.0）を加えた構成です。単独で起動でき、他の mabubot-\*（play / ops）や p1228・logbot とは接続しません。

📜 更新履歴: [CHANGELOG.md](CHANGELOG.md)

## ✨ できること

- **🛡️ モデレーション**: 警告・タイムアウト・キック・BAN・メッセージ一括削除、モデレーションログ
- **🚨 荒らし対策（自動）**: 短時間の連投（6件/5秒）または同一内容の連投（5件/10秒）を検知して自動で10分タイムアウトし、スパムメッセージを削除してモデレーションログに通知します（モデレーターとサーバーオーナーは対象外）
- **🛡️ レイド防御（運営自動化設計書 §5.8）**: 参加バーストと作成7日未満アカウントの割合を監視し、段階（平常→注意→警戒）を運営ログへ通知します。レイドモードは警戒通知のボタン承認または `/raid on` で発動し、招待の一時停止（Discord Incident Actions）・対象チャンネルの低速モード・新規参加の隔離をまとめて適用し、解除時に適用前の状態へ正確に戻します（既定1時間で期限切れ）。隔離された新規参加者は、認証チャンネルのボタン＋参加後10分経過＋アカウント作成24時間経過の3条件で発言ロールを取得できます。レイドモード中はスパムの自動タイムアウトが10分→30分に延長されます。自動発動は既定で無効で、`/raid set auto-activate` を有効にした場合のみ「1分20人以上 かつ 新規率80%以上」の二重条件で発動します。参加しただけ・新しいだけでの自動BAN/キックはしません
- **👀 プレゼンス**: 全 Bot 共通のプレゼンス・サイクル（Playing、1分ごとに「起動して ○○」と「現在時刻 ○○ JST」を交互表示）。`/watching` でカスタム文言の保存・表示ができます（表示そのものはサイクル形式で固定）

コマンドの返信は埋め込みメッセージで、基本的に実行者にだけ見えます（限定表示）。フッターは `✨ まぶさば` です。

## ⌨️ コマンド

`/mod` はサブコマンドごとに権限が分かれています（warn・timeout・untimeout はメンバーをモデレート、kick はキック、ban・unban はBAN、clear・log はサーバーの管理）。`/raid` はモデレーター以上（set / setup / watch-off は管理者）。`/watching` はサーバー管理（Manage Guild）権限が必要です。

| コマンド | 説明 | 備考 |
| --- | --- | --- |
| `/mod warn add user:<ユーザー> [reason:<理由>]` | 警告を追加（SQLiteに保存） | メンバーをモデレート |
| `/mod warn list user:<ユーザー>` | 警告履歴を表示 | メンバーをモデレート |
| `/mod timeout user:<ユーザー> duration:<期間> [reason:<理由>]` | タイムアウト（期間は `10m` / `1h` / `1d` / `30分` / `2時間`、最大28日） | メンバーをモデレート |
| `/mod untimeout user:<ユーザー>` | タイムアウト解除 | メンバーをモデレート |
| `/mod kick user:<ユーザー> [reason:<理由>]` | キック | メンバーをキック |
| `/mod ban user:<ユーザー> [delete-days:<0〜7>] [reason:<理由>]` | BAN（過去メッセージの削除日数も指定可） | メンバーをBAN |
| `/mod unban user-id:<ユーザーID>` | BAN解除 | メンバーをBAN |
| `/mod clear count:<1〜100>` | メッセージを一括削除（14日より前のメッセージは削除できません） | サーバーの管理 |
| `/mod log set channel:<#チャンネル>` | モデレーションログの通知先を設定 | サーバーの管理 |
| `/mod log disable` | モデレーションログを止める | サーバーの管理 |
| `/raid status` | 現在の段階・直近の参加・設定を表示 | モデレーター |
| `/raid on [minutes:<5〜720>]` | レイドモードを手動で発動 | モデレーター |
| `/raid off` | レイドモードを解除し、適用した変更をすべて戻す | モデレーター |
| `/raid set [watch-joins] [alert-1min] [alert-5min] [young-percent] [auto-activate] [gating-always] [slowmode-seconds] [duration-minutes]` | 検知の閾値などを設定 | 管理者 |
| `/raid setup [slowmode-channel] [verify-channel] [talk-role] [quarantine-role]` | 対象チャンネルとロールを設定（認証チャンネル指定時は認証メッセージを投稿） | 管理者 |
| `/raid watch-off [minutes:<1〜1440>]` | 検知の通知を一時停止（記録は継続、既定120分） | 管理者 |
| `/watching set text:<文言>` | プレゼンスのカスタム文言を保存（Bot全体に適用、SQLiteに保存） | サーバーの管理 |
| `/watching show` | 現在表示中のプレゼンスを表示 | サーバーの管理 |
| `/watching reset` | カスタム文言を消去 | サーバーの管理 |
| `/ping` | 応答確認 | |
| `/help` | コマンド一覧を表示 | 公開表示 |

補足:

- タイムアウト・キック・BANは、実行者と同等以上の役職のメンバーには実行できません（Discord標準の役職階層と同じルール）。Bot 自身・サーバーオーナー・Administrator 保有者も対象外で、実行者の役職情報を取得できない場合は安全のため実行しません。BANだけは、サーバーにいないユーザーへの先行 BAN が可能です。
- **荒らし対策**: 同一ユーザーが直近5秒に6件以上、または10秒に同一内容を5件以上送ると、自動で10分タイムアウト＋該当メッセージを（複数チャンネルにまたがっていても）削除＋モデレーションログへ通知します。自動タイムアウトの成否は運営ログに実際に起きたとおり記録します。サーバーオーナーとモデレーターは対象外で、自動タイムアウト自体にも60秒のクールダウンがあります。
- **レイド防御の段階**: 注意は「5分で設定数（既定10人）以上」または「5人以上かつ新規率が設定割合（既定50%）以上」、警戒は「1分で設定数（既定10人）以上」「5分で設定数（既定30人）以上」または「注意規模かつ新規率70%以上」です。段階は通知のみで、処分はしません。参加ペースが15分間落ち着けば1段階ずつ下がります。
- **隔離と認証**: レイドモード中（または `/raid set gating-always` で常時化した場合）の新規参加者は隔離され、認証ボタン＋参加後10分＋アカウント作成24時間の3条件で発言ロールが付与されます。
- プレゼンスの表示そのものは全 Bot 共通のプレゼンス・サイクル（presence-cycle）が担います。`/watching set` で保存したカスタム文言は互換のため保持されますが、実際に適用される表示はサイクル形式です（`/watching show` は現在の表示を返し、`/watching set` の返信でもその旨を明示します）。

## ⚙️ 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | ○ | Discord Bot のトークン |
| `DISCORD_APPLICATION_ID` | ○ | Discord アプリケーション ID（コマンド同期・削除に使う） |
| `DATA_DIR` | ― | SQLite データの保存先。既定は `./data`（`data/mabubot-guard.db`） |
| `WATCHING_TEXT` | ― | プレゼンスのカスタム文言。`/watching set` の保存値があればそちらが優先 |
| `DB_BACKUP_RETENTION` | ― | 起動時 DB バックアップの保持世代数。既定は 10 |
| `DISCORD_GUILD_ID` / `DISCORD_GUILD_IDS` | ― | `clear:commands` でギルドコマンドも消す場合に指定（カンマ区切り可） |

## ⚙️ 必要なDiscord設定

1. [Discord Developer Portal](https://discord.com/developers/applications) で **mabubot-guard 用の新しいアプリケーション** を作成し、Bot を追加します（元の mabubot や他の Bot のアプリは使いません。各 Bot でアプリが別々に必要です）。
2. Bot 設定で Privileged Gateway Intents を有効にします：
   - **Message Content Intent**（荒らし対策の連投判定にメッセージ内容が必要）
   - **Server Members Intent**（レイド防御の参加検知に必要。有効化しないとログインできません）
3. サーバーに Bot を招待します。権限は「チャンネルを見る」「メッセージを送信する」「埋め込みリンク」「メンバーをモデレート」「メンバーをキック」「メンバーをBAN」「メッセージの管理」「ロールを管理」（隔離ロールの付け外し用）を付与してください。タイムアウト・キック・BAN は、Bot の役職より下の役職のメンバーにしか効きません。Bot のロールは隔離対象のロールより上位に置いてください。
4. `.env.example` を `.env` にコピーし、`DISCORD_TOKEN` と `DISCORD_APPLICATION_ID` を設定します。**トークンはチャットには送らず、`.env` にだけ入れてください。**

## 🚀 起動

```bash
npm ci
npm run build
npm run sync:commands   # スラッシュコマンドを上書き同期（初回・コマンド変更時に実行）
npm start
```

### 🔨 ビルド（ワンコマンド）

依存関係のインストール → 型チェック → ビルド → テストまでを 1 コマンドで実行するスクリプトを用意している。失敗した場合は、そのステップで止まってどこで落ちたかを表示する。テストは `dist/` に対して実行されるため、スクリプト内でもビルドを先に行う。

```bat
build.bat
```

```sh
./build.sh
```

開発時は `npm run dev` で起動できます。警告・モデレーションログ設定・レイド防御の設定と記録・視聴中ステータスの文言は `data/mabubot-guard.db`（SQLite、Node 標準の `node:sqlite`）に保存され、再起動しても残ります。起動時には DB のバックアップが `data/backups/<timestamp>/` に作られ、直近10世代（`DB_BACKUP_RETENTION` で変更可）が保持されます。Node 24 以上が必要です。

> [!NOTE]
> `.env` は自動では読み込まれません。`DISCORD_TOKEN` / `DISCORD_APPLICATION_ID` はシェルに export するか、systemd の `EnvironmentFile=` で渡してください。pm2 で起動する場合は `ecosystem.config.cjs` が `.env` を読み込むので、このままで大丈夫です。

## 🖥️ pm2で自動起動

```bash
pm2 start ecosystem.config.cjs
pm2 startup   # 表示されたコマンドを実行
pm2 save
```

## 🔁 コマンド同期（上書き同期式）

スラッシュコマンドの登録は `npm run sync:commands` だけが行います。Bot の起動時には同期しません。実行すると、このアプリのグローバルコマンドを PUT で全置換し、同期後に再取得して検証します。コマンド定義を変えたら必ず実行し直してください。古いコマンドを全削除したい場合は `npm run clear:commands` を使います（グローバル＋任意でギルド）。

## 🔀 元 mabubot からの移行メモ

- **担当データ**: `warns`（警告履歴）、`mod_log`（モデレーションログの通知先）、`settings`（視聴中ステータスの文言 `watching_text` のみ使用）。DB ファイルは `data/mabubot-guard.db` です（元は `data/mabusaba.db`）。
- **データ移行手順**（警告履歴などを引き継ぐ場合）: mabubot-guard を一度起動して `data/mabubot-guard.db` を作り、停止してから、旧 DB の担当テーブルをコピーします（テーブル定義は元と同じなので `INSERT INTO ... SELECT *` が使えます）。
  ```bash
  sqlite3 data/mabubot-guard.db \
    "ATTACH '/path/to/mabubot/data/mabusaba.db' AS old;
     INSERT INTO warns SELECT * FROM old.warns;
     INSERT INTO mod_log SELECT * FROM old.mod_log;
     INSERT INTO settings SELECT * FROM old.settings;
     DETACH old;"
  ```
- **切り替え時の注意**:
  - 旧 mabubot と mabubot-guard を**同時に稼働させないでください**。両方が連投を検知し、二重にタイムアウト・削除・ログ通知を行います。停止 → データ移行 → 起動の順で切り替えてください。
  - 視聴中ステータスは Bot（アプリ）ごとに独立しています。元の mabubot のステータス文言は `settings` の移行で引き継がれますが、表示されるのは mabubot-guard のプロフィール上です。
  - 元の mabubot では「スパム判定を先に行い、スパム投稿には XP を付けない」順序制御がありましたが、分離後は XP 付与が別 Bot（mabubot-play）になるため、この制御は効きません（play 側の README も参照）。

## 🗂️ 構成

- `src/index.ts` — 起動・Intents（コマンド同期はしない）、レイド防御のボタン処理、コマンド実行ログ
- `src/sync-commands.ts` — スラッシュコマンドの上書き同期（PUT 全置換＋検証）
- `src/clear-commands.ts` — アプリケーションのコマンド全削除（グローバル＋ギルド）
- `src/commands.ts` — この Bot のスラッシュコマンド定義と振り分け
- `src/store.ts` — SQLite ストア（settings / warns / mod_log / raid_settings / raid_events / raid_quarantine）
- `src/backup.ts` — 起動時 DB バックアップ（世代管理）
- `src/util.ts` — 埋め込み返信・期間解析・表示整形・コマンド実行ログ
- `src/mod.ts` — モデレーション（警告・タイムアウト・キック・BAN・削除・モデレーションログ）と権限・階層チェック
- `src/raid.ts` — レイド防御（段階判定・レイドモード・隔離と認証・定期処理）
- `src/raid-commands.ts` — /raid コマンドの定義と処理
- `src/watching.ts` — プレゼンス文言の管理（/watching）
- `src/presence-cycle.ts` — プレゼンス・サイクル（全 Bot 共通形式）
- `src/watchdog.ts` — READY ウォッチドッグ（Gateway のサイレント停滞検知）
- `src/events.ts` — messageCreate（スパム対策）・guildMemberAdd/Remove（レイド防御）
- `tests/` — 単体テスト（期間解析・ストア・階層判定・レイド判定・バックアップ・ウォッチドッグ・プレゼンス）

## 🧭 判断記録

- **ゼロから再実装し、バージョンを 1.0.0 に振り直した（2026-11-28）**: 統一開発フロー（aegis-bot が基準）への移行にあわせ、旧実装（最終 v0.2.1）を棚卸しして全機能を再実装した。棚卸しの正は GitHub ではなく**本番サーバー（台2）のスナップショット**とした。コードの構成・コメント規約・ドキュメント形式を基準に揃え、振る舞い（コマンド定義・文言・閾値・保存形式）は旧実装と一致させた。詳細は DESIGN.md の対応表と判断記録を参照。
- **開発手順を統一した（2026-11-28）**: Issue → ブランチ → PR → Rebase and merge の手順、Conventional Commits＋英語の件名、タグ＋GitHub Release（ノートのみ）のリリース手順を採用した。手順の正本は CONTRIBUTING.md。
- **データ保存形式は変えない**: 本番の `data/mabubot-guard.db` をそのまま読み続けられるよう、テーブル定義・既定の保存先・pm2 アプリ名（`mabubot-guard`）は旧実装と同一にした。

## Development

開発手順（Issue → ブランチ → PR → CI → Rebase and merge）は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。設計の詳細は [DESIGN.md](DESIGN.md) にあります。
