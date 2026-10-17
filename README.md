# line-approval-bridge

AI エージェント（Claude Code の定期タスク、シェルスクリプトなど）から **あなたの LINE に通知し、返信・承認を待って、その答えで処理を分岐する** ための小さなブリッジです。

```
Claude Code / スクリプト ──(MCP / CLI)──▶ Cloudflare Worker ──push──▶ あなたの LINE
          ▲                                   │  ▲                         │
          └──────── 結果をポーリング ───────────┘  └──── Webhook（返信）────────┘
```

- `notify(text)` … 一方向の通知
- `ask_approval(question, options, timeout)` … 「承認 / 却下」などのボタン付きで質問し、**回答が来るまで待つ**
- `get_reply(id)` … 回答の取得（待ちの再開）

## 公式 LINE Bot MCP Server との違い

[公式 LINE Bot MCP Server](https://github.com/line/line-bot-mcp-server) は **送信専用** です。メッセージを送ることはできますが、ユーザーの返信を受け取ってエージェントに返す仕組みはありません。

line-approval-bridge は **人間の判断を待つ（human-in-the-loop）** ことに特化しています。

| | 公式 LINE Bot MCP Server | line-approval-bridge |
|---|---|---|
| メッセージ送信 | できる | できる |
| 返信の受信（Webhook） | なし | あり（署名検証つき） |
| 承認ボタンを出して待つ | なし | `ask_approval` |
| 返信内容で処理を分岐 | なし | `answer.value` で分岐 |
| 自由入力の返信 | なし | あり（`#ID` 指定で過去の依頼にも回答可） |
| 受信者の制限 | — | 許可した userId のみ |

## 特徴

- **無料で動く**: Cloudflare Workers 無料プラン + Workers KV、LINE コミュニケーションプラン（無料・月 200 通）
- **安全**: `X-Line-Signature`（HMAC-SHA256）を検証。許可リストにない userId は無視。API は Bearer トークン必須
- **返信は通数を消費しない**: 「受け付けました」の返事は reply API（無料）で返す
- **MCP サーバー + CLI**: Claude Code からはツールとして、シェルからは終了コードで分岐
- **ローカル開発モード**: LINE に実際に送らず、署名付き Webhook をシミュレートして全フローを試せる

## なぜ Cloudflare Workers か（Vercel ではなく）

- KV ストアが Workers に標準で付いてくる（Vercel は外部の Redis 連携が必要で、設定項目が増える）
- 無料枠で十分（1 日 10 万リクエスト、KV 読み取り 10 万回・書き込み 1,000 回）
- Web Crypto がそのまま使えるので、署名検証が依存ライブラリなしで書ける
- スリープ（コールドスタート）が実質なく、LINE の Webhook にすぐ応答できる

---

## セットアップ

所要時間は 30 分ほどです。**トークンやパスワードはすべてご自身で発行・入力してください。** このリポジトリやチャットに貼る必要はありません。

### 必要なもの

- LINE アカウント（スマホの LINE アプリ）
- Cloudflare アカウント（無料）
- Node.js 20 以上、git

### 1. LINE 公式アカウントを作り、Messaging API を有効にする

1. [LINE Official Account Manager](https://manager.line.biz/) を開き、LINE アカウントでログイン
2. 「アカウントを作成」から LINE 公式アカウントを作る（名前は何でもよい。例: `My Agent`）
3. 作ったアカウントを開き、右上の **設定** → 左メニュー **Messaging API** → **「Messaging API を利用する」**
4. プロバイダーを選ぶ（なければ新規作成。名前は何でもよい）→ OK
5. 同じ設定画面の左メニュー **応答設定** で次のようにする
   - **応答メッセージ: オフ**（自動返信がブリッジの返事と混ざるのを防ぐ）
   - **Webhook: オン**
   - あいさつメッセージ: お好みで

### 2. トークンと自分の userId を確認する

[LINE Developers コンソール](https://developers.line.biz/console/) を開き、手順 1 のプロバイダー → チャネル（公式アカウント名）を選びます。

| 確認する値 | 場所 | このあと入れる先 |
|---|---|---|
| チャネルシークレット | 「チャネル基本設定」タブ → チャネルシークレット | Worker の secret `LINE_CHANNEL_SECRET` |
| あなたの userId（`U` で始まる 33 文字） | 「チャネル基本設定」タブ → 一番下の「あなたのユーザーID」 | Worker の secret `ALLOWED_USER_IDS` |
| チャネルアクセストークン（長期） | 「Messaging API設定」タブ → 一番下「チャネルアクセストークン（長期）」の **発行** | Worker の secret `LINE_CHANNEL_ACCESS_TOKEN` |

続けて「Messaging API設定」タブにある **QR コードを LINE アプリで読み取り、公式アカウントを友だち追加** してください（友だちでないと通知が届きません）。

### 3. Worker をデプロイする

```bash
git clone https://github.com/fumy98/line-approval-bridge.git
cd line-approval-bridge
npm install
cd api
npx wrangler login                 # ブラウザが開くので Cloudflare にログインして許可
npx wrangler kv namespace create KV
```

最後のコマンドが表示する `id = "..."` を、`api/wrangler.toml` の `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` と置き換えます。

次に secret を 4 つ登録します。コマンドごとに入力を求められるので、値を貼り付けて Enter（画面には表示されません）。

```bash
npx wrangler secret put LINE_CHANNEL_SECRET        # 手順 2 のチャネルシークレット
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN  # 手順 2 のチャネルアクセストークン（長期）
npx wrangler secret put ALLOWED_USER_IDS           # 手順 2 のあなたの userId（複数ならカンマ区切り）
openssl rand -hex 32                               # API_TOKEN 用のランダム文字列を作る（控えておく）
npx wrangler secret put API_TOKEN                  # ↑で作った文字列
npx wrangler deploy
```

`deploy` の最後に `https://line-approval-bridge.<あなたのサブドメイン>.workers.dev` が表示されます。これが **Worker の URL** です。

### 4. LINE に Webhook URL を登録する

LINE Developers コンソール →「Messaging API設定」タブ → **Webhook URL** の「編集」に

```
https://line-approval-bridge.<あなたのサブドメイン>.workers.dev/webhook
```

を入れて「更新」→「検証」で **成功** と出れば OK。その下の **Webhook の利用** をオンにします。

### 5. クライアント（CLI / MCP）を準備する

```bash
cd ..                      # リポジトリ直下に戻る
npm run build
```

環境変数を 2 つ使います（`.env.example` 参照）。シェルで使う場合は `~/.zshrc` などに書きます。

```bash
export LINE_APPROVAL_URL="https://line-approval-bridge.<あなたのサブドメイン>.workers.dev"
export LINE_APPROVAL_TOKEN="<手順 3 で作った API_TOKEN>"
```

動作確認:

```bash
node client/dist/cli.js notify "テスト通知です"
node client/dist/cli.js ask "承認テストです。どちらかを押してください" --wait 300 --print value
```

LINE に届いたメッセージの「承認」ボタンを押すと、ターミナルに `承認` と表示されます。

### 6. Claude Code に MCP サーバーとして登録する

```bash
claude mcp add line-approval --scope user \
  -e LINE_APPROVAL_URL="https://line-approval-bridge.<あなたのサブドメイン>.workers.dev" \
  -e LINE_APPROVAL_TOKEN="<API_TOKEN>" \
  -- node "$(pwd)/client/dist/mcp.js"
```

`--scope user` にすると、すべてのプロジェクトと定期タスクから使えます。値は手元の `~/.claude.json` にだけ保存されます。`claude mcp list` で `line-approval` が `Connected` になっていれば完了です。

### トークンの置き場所まとめ

| 値 | 置き場所 | git に入るか |
|---|---|---|
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `ALLOWED_USER_IDS` / `API_TOKEN` | Cloudflare の Worker secret（`wrangler secret put`） | 入らない |
| `LINE_APPROVAL_URL` / `LINE_APPROVAL_TOKEN` | シェルの環境変数、または `claude mcp add -e` | 入らない |
| ローカル開発用の値 | `api/.dev.vars`（`.gitignore` 済み） | 入らない |
| KV namespace id | `api/wrangler.toml` | 入る（秘密情報ではない） |

---

## 使い方

### MCP ツール（Claude Code から）

| ツール | 引数 | 戻り値 |
|---|---|---|
| `notify` | `text` | `sent` |
| `ask_approval` | `question`, `options?`（既定 `["承認","却下"]`、最大 13 個・各 20 文字）, `allow_free_text?`（既定 true）, `timeout?`（期限・秒、既定 86400）, `wait_seconds?`（この呼び出しで待つ秒数、既定 600） | `status`（`answered` / `expired` / `pending`）, `answer.value`, `answer.kind`（`option` / `text`）, `id` |
| `get_reply` | `id`, `wait_seconds?` | 同上 |

`wait_seconds` を過ぎても回答がなければ `pending` と `id` を返します。エージェントは `get_reply(id)` を呼べば待ちを再開できます（依頼そのものは `timeout` まで有効）。

### 例: 週の動画トピックを LINE で承認する

Claude Code の定期タスクのプロンプトに、次のように書きます。

```text
1. 来週の動画トピックを 7 本考えて topics.md に書く。
2. line-approval の ask_approval を呼ぶ。
   question: 「来週のトピック案です」+ 7 本のタイトルを番号付きで
   options: ["承認", "却下"]
   timeout: 43200（12 時間）
3. 返ってきた answer で分岐する。
   - 「承認」: topics.md の状態を approved にしてコミットする。
   - 「却下」: 何もせず notify で「今週は見送りました」と送る。
   - 自由入力（例「3 番を別の話題に」）: 指示どおり直して、もう一度 ask_approval する（最大 3 回）。
   - expired / pending: notify で「未承認のため保留しました」と送って終了する。
```

### CLI（シェルスクリプトから）

```bash
line-approval notify "<text>"
line-approval ask "<question>" [--options 承認,却下] [--no-free-text] [--timeout 秒] [--wait 秒 | --no-wait] [--print value|json]
line-approval get <id> [--wait 秒] [--print value|json]
line-approval quota          # 今月の送信数
```

（`npm link -w client` で `line-approval` コマンドとして使えます。そうしない場合は `node client/dist/cli.js`。）

終了コード: `0` 回答あり / `2` 期限切れ / `3` まだ回答待ち（`--wait` 経過） / `1` エラー

```bash
answer=$(line-approval ask "本番にデプロイしますか？" --timeout 3600 --print value)
case "$?:$answer" in
  0:承認) ./deploy.sh ;;
  0:*)    echo "却下またはコメント: $answer" ;;
  *)      echo "回答なし" ;;
esac
```

### LINE 側での答え方

- **ボタンを押す**（いちばん確実）
- **ボタンと同じ文字を送る**（例: `承認`）→ 最新の依頼への回答
- **自由に書いて送る**（例: `3 番だけ差し替えて`）→ 最新の依頼への自由入力回答（`allow_free_text` が true の場合）
- **`#ID 内容` と送る**（例: `#K7Q2MX 却下`）→ 古い依頼にも回答できる。ID はメッセージ内の `[#K7Q2MX]`
- 回答は最初の 1 回だけ有効。期限切れ・回答済みの依頼にはそう返事します

## HTTP API

すべて `Authorization: Bearer <API_TOKEN>` が必要です（`/health` と `/webhook` を除く）。

| メソッド | パス | 本文 / 結果 |
|---|---|---|
| `POST` | `/api/notify` | `{ "text": "...", "to"?: "U..." }` → `{ "ok": true }` |
| `POST` | `/api/requests` | `{ "question": "...", "options"?: [...], "allowFreeText"?: true, "timeoutSeconds"?: 86400, "to"?: "U..." }` → `201` 依頼オブジェクト |
| `GET` | `/api/requests/:id` | 依頼オブジェクト `{ id, status, question, options, answer: { kind, value, answeredAt } \| null, ... }` |
| `GET` | `/api/quota` | `{ "limit": 200, "used": 12 }` |
| `POST` | `/webhook` | LINE からの Webhook（署名検証） |
| `GET` | `/health` | `{ "ok": true }` |

`to` を省略すると `DEFAULT_TO`（なければ `ALLOWED_USER_IDS` の先頭）に送ります。`to` に許可リスト外の userId を指定すると `400` になります。

## 制限と注意

- **月 200 通**: LINE の無料プランでは push（`notify` と `ask_approval`）が 1 回 1 通として数えられます。「受け付けました」の返事は reply なので数えられません。`line-approval quota` で確認できます
- **反映に最大 1 分ほどかかることがあります**: Workers KV は結果整合のため、ボタンを押してから `answered` が読めるまで遅れる場合があります。人の承認待ちという用途では問題にならない想定です
- **ボタンは最新のメッセージにしか出ません**: LINE のクイックリプライの仕様です。古い依頼には `#ID 内容` で答えてください
- **1 対 1 のトークのみ**: グループ・複数人での承認は対象外です

## ローカル開発

LINE に実際には送らず（`LINE_DRY_RUN=true`）、ログに出すだけのモードです。

```bash
cp api/.dev.vars.example api/.dev.vars
npm run dev                                   # http://localhost:8787

# 別のターミナルで
export LINE_APPROVAL_URL=http://localhost:8787 LINE_APPROVAL_TOKEN=local-dev-token
node client/dist/cli.js ask "テスト" --wait 120 --print value

# さらに別のターミナルで、LINE で返信したことにする（ID は dev サーバーのログの [#XXXXXX]）
npm run simulate -- tap XXXXXX 0              # ボタン 0 番を押す
npm run simulate -- text "承認"                # 文字で返信
npm run simulate -- text "hi" --user Uother   # 許可リスト外のユーザー（無視される）
```

テスト:

```bash
npm test          # 署名検証・許可リスト・依頼のライフサイクル・CLI・MCP
npm run typecheck
```

## ディレクトリ構成

```
api/       Cloudflare Worker（Webhook 受信・HTTP API・KV）
client/    クライアントライブラリ、CLI（line-approval）、MCP サーバー（line-approval-mcp）
scripts/   ローカル開発用の Webhook シミュレータ
```

API（`api/`）とクライアント（`client/`）は分離しており、クライアントは HTTP 経由でのみ API を呼びます。

---

## English summary

**line-approval-bridge** lets an AI agent (Claude Code scheduled tasks, scripts) send you a LINE message and **wait for your reply or approval**, then branch on it. The official LINE Bot MCP Server can only send; this project adds the receiving side: a Cloudflare Worker that verifies LINE webhook signatures, accepts replies only from allowlisted userIds, stores them in Workers KV, and exposes a bearer-token HTTP API. A stdio MCP server (`notify`, `ask_approval`, `get_reply`) and a CLI (exit codes for branching) wrap the API. Runs on free tiers (Cloudflare Workers + LINE's 200 messages/month plan; acknowledgements use the free reply API). Includes a local dry-run mode with a signed-webhook simulator and tests for signature verification, the allowlist and the request lifecycle.

## License

[MIT](LICENSE)
