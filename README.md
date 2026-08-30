# LLM Usage Bar

Claude Code / Codex CLI のレート制限使用量と GitHub Actions の無料枠消費を VS Code のステータスバーに常時表示する拡張機能。
[CodexBar](https://github.com/steipete/CodexBar)(macOS メニューバーアプリ)と同じデータ取得方式を VS Code 向けに実装したもの。

## 表示

```
CC 5h 30% · 7d 50%    CX 5h 47% · 7d 62%    GH 月間 10%
```

- **CC** = Claude(セッション 5h / 週間 7d の使用率。Fable など モデル別の週間枠は `7d Fable` として取得され、ツールチップに常時表示。`llmUsageBar.statusBarWindows` を 3 にするとステータスバーにも表示)
- **CX** = Codex(primary / secondary レート制限ウィンドウ)
- **GH** = GitHub Actions(月間無料枠に対する使用率。ツールチップに使用分数 / 無料枠を表示)
- ホバーで各ウィンドウの棒グラフ(`5h  ▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  30%  2h 13m (18:09)`)とリセットまでのカウントダウン+ローカル時刻(日本時間環境なら日本時間)でのリセット時刻を表示。別日の場合は `4d 17h (9/4(金) 12:00)` のように日付+曜日付き
- ホバーで CLI にサインイン中のアカウント名・メールアドレスと、取得できる場合は組織名を表示
- ステータスバー本体も設定でバーゲージ表示に切替可能(`llmUsageBar.displayFormat`: percent / bar / both)
- 使用率が閾値(既定 80% / 95%)を超えると警告色 / エラー色に変化
- **ペース判定**: 直近1時間の実測消費レート(%/時)から、リセット前に制限へ到達するペースかを判定。到達見込みのウィンドウには `↗` を表示し、ツールチップに到達予測時刻を表示(1時間以内ならエラー色)
- **予算線と着地予測**: ウィンドウごとにツールチップへ `5h ウィンドウ: 経過 60% / 使用 40% — このペースだとリセット時点で約 65% の見込みです。` のように、時間の経過率と使用率の比較(飛ばしすぎかどうか)と、現在ペース維持時のリセット時点の着地使用率を常時表示
- **従量課金の概算**(Claude): 現在のワークスペースの Claude Code セッション記録(`~/.claude/projects/`)から、現在のコンテキスト量と、もし従量課金だった場合のセッション累計コストを推定してツールチップに表示(`llmUsageBar.claude.showSessionCost` で無効化可)。キャッシュ読み取り(入力単価の 0.1 倍)/書き込み(5分 1.25 倍・1時間 2 倍)を区別して計算
- クリックで即時リフレッシュ

## 仕組み(追加ログイン不要)

既存 CLI のログイン情報を **読み取り専用** で流用します。

| Provider | 認証 | エンドポイント |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json` の OAuth トークン | `GET https://api.anthropic.com/api/oauth/usage` |
| Codex | `~/.codex/auth.json`(`CODEX_HOME` 対応) | `GET https://chatgpt.com/backend-api/wham/usage` |
| GitHub | `gh auth token`(GitHub CLI)、なければ `GH_TOKEN` / `GITHUB_TOKEN` | `GET /users/{user}/settings/billing/actions`(旧課金 API が使えないアカウントは `GET /users/{user}/settings/billing/usage` にフォールバック) |

認証ファイルへの書き込みは一切行いません。トークンが失効した場合は各 CLI を一度実行すればリフレッシュされます。

GitHub の課金 API には `user` スコープが必要です。gh CLI の既定トークンには付いていないため、初回は次を実行してください(未実行の場合はツールチップに同じ案内が表示されます):

```bash
gh auth refresh -h github.com -s user
```

## 使用枠アンカー(定時挨拶で 5h 枠の開始を揃える)

[「挨拶ハラスメント」](https://qiita.com/inoyu-qiita/items/1953d640bc0a7c0b16fc)と呼ばれる運用 — 決まった時刻に軽いプロンプトを 1 回送り、5 時間ごとにリセットされる使用枠の開始位置を業務時間に揃える — を拡張機能が自動で行います。既定は無効(オプトイン)。Settings Sync を使っていれば設定は全端末に同期されるため、端末ごとの cron やクラウドルーティンの設定は不要です。

```jsonc
"llmUsageBar.windowAnchor.enabled": true
```

- 平日 07:00 / 12:00 / 17:00(ローカル時刻)に `claude --model haiku -p '...'` / `codex exec --skip-git-repo-check --sandbox read-only '...'` を実行して枠を開始。時刻は `windowAnchor.times` で変更可(5 時間間隔にすると境界が一日中揃う)
- 実行前に使用量 API を確認し、枠がすでに開始済み(別マシンが先に実行した、朝すでに作業していた等)ならスキップ。同一マシンの複数 VS Code ウィンドウでも 1 回だけ実行
- 指定時刻に VS Code が閉じていた/スリープしていた場合は、`windowAnchor.graceMinutes`(既定 30 分)以内の復帰なら追い掛けて実行。過ぎたらズレた時刻に枠を開始せず次の時刻まで待つ
- 有効時は CC / CX のツールチップに `📌 使用枠アンカー: 有効 — 次回開始 12:00` のように次回実行時刻を常時表示(有効になっているかの確認はここで)
- コマンドパレット「LLM Usage Bar: 使用枠ウィンドウを今すぐ開始」で手動実行可。実行ログは出力パネル「LLM Usage Bar」に記録
- 消費はごくわずか(Claude は Haiku 1 応答)。claude / codex CLI がインストール・ログイン済みで、VS Code が起動していることが前提(枠の開始そのものはアカウント単位なので、起動中の端末が 1 台あればよい)

## 開発

```bash
npm install
npm run check   # 型チェック
npm run lint    # ESLint
npm test        # ユニットテスト (node:test)
# VS Code でこのフォルダを開き F5 で Extension Development Host を起動
# (esbuild で dist/extension.js にバンドルされる)

npm run package:vsix  # .vsix パッケージ作成
```

## 設定

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `llmUsageBar.pollIntervalSeconds` | 300 | ポーリング間隔(秒、最小 60)。Claude の usage API はレート制限が厳しいため短くしすぎないこと |
| `llmUsageBar.warnThresholdPercent` | 80 | 警告色の閾値 |
| `llmUsageBar.errorThresholdPercent` | 95 | エラー色の閾値 |
| `llmUsageBar.claude.enabled` | true | Claude の表示 |
| `llmUsageBar.claude.showSessionCost` | true | セッションの従量課金概算をツールチップに表示 |
| `llmUsageBar.codex.enabled` | true | Codex の表示 |
| `llmUsageBar.github.enabled` | true | GitHub Actions の表示 |
| `llmUsageBar.github.includedMinutesPerMonth` | 0 | Actions の月間無料枠(分)。0 = プランから自動判定(Free 2000 / Pro 3000)。API が枠を返す場合は API 値を優先 |
| `llmUsageBar.statusBarWindows` | 2 | ステータスバーに表示するウィンドウ数。3 で `7d Fable` などモデル別枠も表示 |
| `llmUsageBar.windowAnchor.enabled` | false | 定時に CLI 経由で極小プロンプトを送り使用枠ウィンドウを開始(上記「使用枠アンカー」) |
| `llmUsageBar.windowAnchor.times` | `["07:00","12:00","17:00"]` | 枠を開始するローカル時刻(HH:MM) |
| `llmUsageBar.windowAnchor.weekdaysOnly` | true | 平日のみ実行 |
| `llmUsageBar.windowAnchor.graceMinutes` | 30 | 指定時刻に VS Code がなくても、この分数以内の復帰なら実行 |
| `llmUsageBar.windowAnchor.providers` | `["claude","codex"]` | 対象プロバイダ |
| `llmUsageBar.windowAnchor.claudeCommand` | `""` | Claude の枠開始コマンドの上書き(空 = 既定コマンド) |
| `llmUsageBar.windowAnchor.codexCommand` | `""` | Codex の枠開始コマンドの上書き(空 = 既定コマンド) |

## 注意

どちらも非公式 API のため、予告なく形式が変わる可能性があります。取得に失敗しても最後に取得できたデータを表示し続け、`⚠` アイコンを添えて指数バックオフ付きで再試行します(一度もデータが取れていない場合のみ `⚠ CC —` 表示)。レート制限(429)は異常扱いせず、静かに再試行します。
