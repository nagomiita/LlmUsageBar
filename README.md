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
- ホバーで各ウィンドウの棒グラフ(`5h  ▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  30%  2h 13m (18:09)`)とリセットまでのカウントダウン+ローカル時刻(日本時間環境なら日本時間)でのリセット時刻を表示。別日の場合は `4d 17h (9/4 12:00)` のように日付付き
- ホバーで CLI にサインイン中のアカウント名・メールアドレスと、取得できる場合は組織名を表示
- ステータスバー本体も設定でバーゲージ表示に切替可能(`llmUsageBar.displayFormat`: percent / bar / both)
- 使用率が閾値(既定 80% / 95%)を超えると警告色 / エラー色に変化
- **ペース判定**: 直近1時間の実測消費レート(%/時)から、リセット前に制限へ到達するペースかを判定。到達見込みのウィンドウには `↗` を表示し、ツールチップに到達予測時刻を表示(1時間以内ならエラー色)
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

## 注意

どちらも非公式 API のため、予告なく形式が変わる可能性があります。取得に失敗しても最後に取得できたデータを表示し続け、`⚠` アイコンを添えて指数バックオフ付きで再試行します(一度もデータが取れていない場合のみ `⚠ CC —` 表示)。レート制限(429)は異常扱いせず、静かに再試行します。
