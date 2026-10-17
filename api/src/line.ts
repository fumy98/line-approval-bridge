import type { Env, LineClient, LineMessage, WebhookSetupResult } from "./types";

const API = "https://api.line.me/v2/bot";

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Verifies X-Line-Signature: base64(HMAC-SHA256(channelSecret, rawBody)).
 * Uses crypto.subtle.verify, which compares in constant time.
 */
export async function verifySignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!channelSecret || !signature) return false;
  const sig = base64ToBytes(signature);
  if (!sig || sig.length !== 32) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(rawBody));
}

/** Computes a signature. Used by tests and the local webhook simulator. */
export async function signBody(channelSecret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  return btoa(String.fromCharCode(...mac));
}

export function createLineClient(env: Env, fetchImpl: typeof fetch = fetch): LineClient {
  const dryRun = env.LINE_DRY_RUN === "true";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
  };

  async function call(path: string, body: unknown, method = "POST"): Promise<Response | null> {
    if (dryRun) {
      console.log(`[LINE_DRY_RUN] ${method} ${path} ${JSON.stringify(body)}`);
      return null;
    }
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new LineApiError(res.status, await res.text());
    }
    return res;
  }

  return {
    async push(to: string, messages: LineMessage[]) {
      await call("/message/push", { to, messages });
    },
    async reply(replyToken: string, messages: LineMessage[]) {
      await call("/message/reply", { replyToken, messages });
    },
    async setupWebhook(endpoint: string): Promise<WebhookSetupResult> {
      if (dryRun) {
        console.log(`[LINE_DRY_RUN] setupWebhook ${endpoint}`);
        return { endpoint, active: true, test: { success: true } };
      }
      await call("/channel/webhook/endpoint", { endpoint }, "PUT");
      const info = await fetchImpl(`${API}/channel/webhook/endpoint`, { headers });
      if (!info.ok) throw new LineApiError(info.status, await info.text());
      const { active } = (await info.json()) as { endpoint: string; active: boolean };
      const test = (await (await call("/channel/webhook/test", { endpoint }))!.json()) as WebhookSetupResult["test"];
      return { endpoint, active, test };
    },
    async quota() {
      if (dryRun) return { limit: null, used: 0 };
      const [q, c] = await Promise.all([
        fetchImpl(`${API}/message/quota`, { headers }),
        fetchImpl(`${API}/message/quota/consumption`, { headers }),
      ]);
      if (!q.ok) throw new LineApiError(q.status, await q.text());
      if (!c.ok) throw new LineApiError(c.status, await c.text());
      const quota = (await q.json()) as { type: string; value?: number };
      const used = (await c.json()) as { totalUsage: number };
      return { limit: quota.type === "limited" ? (quota.value ?? null) : null, used: used.totalUsage };
    },
  };
}

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LINE API error ${status}: ${body}`);
  }
}
