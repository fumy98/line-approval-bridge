#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isMain } from "./entry.js";
import { BridgeClient, type ApprovalResult } from "./client.js";

const USAGE = `line-approval — LINE への通知と承認待ち

使い方:
  line-approval notify <text> [--at 2026-10-18T07:00+09:00]
                               --at を付けるとサーバー側で予約し、その時刻に送信
  line-approval scheduled           予約中の通知を一覧
  line-approval cancel <id>         予約中の通知を取り消し
  line-approval ask <question> [--options 承認,却下] [--no-free-text]
                               [--timeout 秒] [--wait 秒 | --no-wait] [--print value|json]
  line-approval get <id> [--wait 秒] [--print value|json]
  line-approval quota
  line-approval setup-webhook   LINE チャネルに Webhook URL を登録して疎通テスト

環境変数:
  LINE_APPROVAL_URL    デプロイした Worker の URL (例 https://line-approval-bridge.xxx.workers.dev)
  LINE_APPROVAL_TOKEN  Worker に設定した API_TOKEN

終了コード (ask / get):
  0 = 回答あり   2 = 期限切れ   3 = まだ回答待ち(--wait 経過)   1 = エラー
`;

export function exitCodeFor(r: ApprovalResult): number {
  return r.status === "answered" ? 0 : r.status === "expired" ? 2 : 3;
}

function output(r: ApprovalResult, mode: string) {
  if (mode === "value") {
    if (r.answer) process.stdout.write(r.answer.value + "\n");
  } else {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  }
}

export async function main(argv: string[], client?: BridgeClient): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      options: { type: "string" },
      "no-free-text": { type: "boolean" },
      timeout: { type: "string" },
      wait: { type: "string" },
      "no-wait": { type: "boolean" },
      print: { type: "string", default: "json" },
      to: { type: "string" },
      at: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const c = client ?? BridgeClient.fromEnv();
  const arg = rest.join(" ");

  switch (cmd) {
    case "notify": {
      if (!arg) throw new Error("notify には本文が必要です");
      const r = await c.notify(arg, { to: values.to, sendAt: values.at });
      if (r.scheduled) process.stdout.write(`予約しました: #${r.scheduled.id} ${r.scheduled.sendAt}\n`);
      return 0;
    }
    case "scheduled": {
      process.stdout.write(JSON.stringify(await c.listScheduled(), null, 2) + "\n");
      return 0;
    }
    case "cancel": {
      if (!rest[0]) throw new Error("cancel には id が必要です");
      await c.cancelScheduled(rest[0]);
      process.stdout.write(`取り消しました: #${rest[0].toUpperCase()}\n`);
      return 0;
    }
    case "ask": {
      if (!arg) throw new Error("ask には質問文が必要です");
      const timeoutSeconds = values.timeout ? Number(values.timeout) : undefined;
      const created = await c.ask({
        question: arg,
        options: values.options?.split(",").map((s) => s.trim()).filter(Boolean),
        allowFreeText: !values["no-free-text"],
        timeoutSeconds,
        to: values.to,
      });
      if (values["no-wait"]) {
        output(created, values.print!);
        if (values.print === "value") process.stdout.write(created.id + "\n");
        return 0;
      }
      const waitSeconds = values.wait ? Number(values.wait) : (timeoutSeconds ?? 86400);
      const r = await c.waitFor(created.id, { waitSeconds });
      output(r, values.print!);
      return exitCodeFor(r);
    }
    case "get": {
      if (!rest[0]) throw new Error("get には id が必要です");
      const r = values.wait ? await c.waitFor(rest[0], { waitSeconds: Number(values.wait) }) : await c.get(rest[0]);
      output(r, values.print!);
      return exitCodeFor(r);
    }
    case "quota": {
      process.stdout.write(JSON.stringify(await c.quota()) + "\n");
      return 0;
    }
    case "setup-webhook": {
      const r = await c.setupWebhook();
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      if (!r.active) process.stderr.write("注意: LINE 側で「Webhook の利用」がオフです。コンソールでオンにしてください。\n");
      return r.test.success && r.active ? 0 : 1;
    }
    default:
      process.stderr.write(`不明なコマンド: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

const isEntry = isMain(import.meta.url);
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
      process.exit(1);
    },
  );
}
