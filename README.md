# LLM Usage Bar

Claude Code / Codex CLI のレート制限使用量を VS Code のステータスバーに常時表示する拡張機能。
[CodexBar](https://github.com/steipete/CodexBar)(macOS メニューバーアプリ)と同じデータ取得方式を VS Code 向けに実装したもの。

## 表示

```
CC 5h 30% · 7d 50%    CX 5h 47% · 7d 62%
```

- **CC** = Claude(セッション 5h / 週間 7d の使用率)
- **CX** = Codex(primary / secondary レート制限ウィンドウ)
- ホバーで各ウィンドウの詳細とリセットまでのカウントダウンを表示
- 使用率が閾値(既定 80% / 95%)を超えると警告色 / エラー色に変化
- クリックで即時リフレッシュ

## 仕組み(追加ログイン不要)

既存 CLI のログイン情報を **読み取り専用** で流用します。

| Provider | 認証 | エンドポイント |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json` の OAuth トークン | `GET https://api.anthropic.com/api/oauth/usage` |
| Codex | `~/.codex/auth.json`(`CODEX_HOME` 対応) | `GET https://chatgpt.com/backend-api/wham/usage` |

認証ファイルへの書き込みは一切行いません。トークンが失効した場合は各 CLI を一度実行すればリフレッシュされます。

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
| `llmUsageBar.codex.enabled` | true | Codex の表示 |

## 注意

どちらも非公式 API のため、予告なく形式が変わる可能性があります。取得に失敗しても最後に取得できたデータを表示し続け、`⚠` アイコンを添えて指数バックオフ付きで再試行します(一度もデータが取れていない場合のみ `⚠ CC —` 表示)。レート制限(429)は異常扱いせず、静かに再試行します。
