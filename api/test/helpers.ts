import { handle, type Deps } from "../src/app";
import { signBody } from "../src/line";
import type { Env, KVStore, LineClient, LineMessage } from "../src/types";

export const USER = "U1111111111111111111111111111111a";
export const STRANGER = "U9999999999999999999999999999999z";
export const SECRET = "test-channel-secret";
export const TOKEN = "test-api-token";

export class MemoryKV implements KVStore {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

export class FakeLine implements LineClient {
  pushes: { to: string; messages: LineMessage[] }[] = [];
  replies: { replyToken: string; messages: LineMessage[] }[] = [];
  async push(to: string, messages: LineMessage[]) {
    this.pushes.push({ to, messages });
  }
  async reply(replyToken: string, messages: LineMessage[]) {
    this.replies.push({ replyToken, messages });
  }
  async quota() {
    return { limit: 200, used: this.pushes.length };
  }
  lastReplyText(): string {
    const r = this.replies.at(-1);
    return (r?.messages[0] as { text: string } | undefined)?.text ?? "";
  }
}

export function setup(overrides: Partial<Env> = {}) {
  let clock = Date.UTC(2026, 9, 17, 0, 0, 0);
  const kv = new MemoryKV();
  const line = new FakeLine();
  const env: Env = {
    KV: kv,
    LINE_CHANNEL_SECRET: SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: "x",
    API_TOKEN: TOKEN,
    ALLOWED_USER_IDS: USER,
    ...overrides,
  };
  const deps: Deps = { env, line, now: () => clock };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };
  const api = (method: string, path: string, body?: unknown, token = TOKEN): Promise<JsonResponse> =>
    handle(
      new Request(`https://bridge.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      deps,
    ) as Promise<JsonResponse>;

  const webhook = async (events: unknown[], opts: { signature?: string } = {}) => {
    const raw = JSON.stringify({ destination: "Ubot", events });
    const signature = opts.signature ?? (await signBody(SECRET, raw));
    return handle(
      new Request("https://bridge.test/webhook", {
        method: "POST",
        headers: { "X-Line-Signature": signature, "Content-Type": "application/json" },
        body: raw,
      }),
      deps,
    );
  };

  return {
    kv,
    line,
    env,
    deps,
    api,
    webhook,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

export const textEvent = (text: string, userId = USER) => ({
  type: "message",
  replyToken: "rt-" + Math.random(),
  source: { type: "user", userId },
  message: { type: "text", id: "1", text },
});

export const postbackEvent = (data: string, userId = USER) => ({
  type: "postback",
  replyToken: "rt-" + Math.random(),
  source: { type: "user", userId },
  postback: { data },
});
