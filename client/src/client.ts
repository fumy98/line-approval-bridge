export type RequestStatus = "pending" | "answered" | "expired";

export interface ApprovalResult {
  id: string;
  status: RequestStatus;
  question: string;
  options: string[];
  allowFreeText: boolean;
  createdAt: string;
  expiresAt: string;
  answer: { kind: "option" | "text"; value: string; answeredAt: string } | null;
}

export interface AskOptions {
  question: string;
  /** Button labels. Default: ["承認", "却下"]. Max 13, each <= 20 chars. */
  options?: string[];
  /** Accept a typed reply in addition to buttons. Default true. */
  allowFreeText?: boolean;
  /** Seconds until the request expires on the server. Default 86400. */
  timeoutSeconds?: number;
  /** LINE userId (must be allowlisted on the server). Default: server's DEFAULT_TO. */
  to?: string;
}

export interface WaitOptions {
  /** Give up waiting locally after this many seconds (the request stays open). */
  waitSeconds?: number;
  /** Poll interval in ms. Default 5000. */
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface ClientConfig {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BridgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: ClientConfig) {
    if (!config.baseUrl) throw new Error("LINE_APPROVAL_URL is not set");
    if (!config.token) throw new Error("LINE_APPROVAL_TOKEN is not set");
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? fetch;
    this.sleep = config.sleep ?? defaultSleep;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BridgeClient {
    return new BridgeClient({
      baseUrl: env.LINE_APPROVAL_URL ?? "",
      token: env.LINE_APPROVAL_TOKEN ?? "",
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? text.slice(0, 200);
      throw new BridgeError(res.status, `HTTP ${res.status}: ${msg}`);
    }
    return data as T;
  }

  notify(text: string, to?: string): Promise<{ ok: true }> {
    return this.request("POST", "/api/notify", { text, to });
  }

  /** Sends a question with buttons and returns immediately with the request id. */
  ask(opts: AskOptions): Promise<ApprovalResult> {
    return this.request("POST", "/api/requests", opts);
  }

  get(id: string): Promise<ApprovalResult> {
    return this.request("GET", `/api/requests/${encodeURIComponent(id)}`);
  }

  quota(): Promise<{ limit: number | null; used: number }> {
    return this.request("GET", "/api/quota");
  }

  /** Registers this Worker's /webhook URL on the LINE channel and runs LINE's webhook test. */
  setupWebhook(): Promise<{
    endpoint: string;
    active: boolean;
    test: { success: boolean; statusCode?: number; reason?: string; detail?: string };
  }> {
    return this.request("POST", "/api/setup/webhook");
  }

  /**
   * Polls until the request is answered or expired, or until waitSeconds elapse.
   * Returns the last seen state (status may still be "pending" on local timeout).
   */
  async waitFor(id: string, opts: WaitOptions = {}): Promise<ApprovalResult> {
    const interval = opts.intervalMs ?? 5000;
    const deadline = opts.waitSeconds === undefined ? Infinity : Date.now() + opts.waitSeconds * 1000;
    for (;;) {
      const r = await this.get(id);
      if (r.status !== "pending") return r;
      if (opts.signal?.aborted) return r;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return r;
      await this.sleep(Math.min(interval, remaining));
    }
  }

  /** ask() + waitFor() in one call. */
  async askAndWait(opts: AskOptions, wait: WaitOptions = {}): Promise<ApprovalResult> {
    const created = await this.ask(opts);
    const waitSeconds = wait.waitSeconds ?? opts.timeoutSeconds ?? 86400;
    return this.waitFor(created.id, { ...wait, waitSeconds });
  }
}
