/** Minimal KV interface. Cloudflare's KVNamespace satisfies it; tests use an in-memory Map. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  KV: KVStore;
  /** LINE channel secret (used to verify X-Line-Signature). */
  LINE_CHANNEL_SECRET: string;
  /** LINE long-lived channel access token (used to push / reply). */
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** Bearer token required by the HTTP API. */
  API_TOKEN: string;
  /** Comma-separated LINE userIds allowed to receive messages and answer. */
  ALLOWED_USER_IDS: string;
  /** Default push target. Falls back to the first allowlisted userId. */
  DEFAULT_TO?: string;
  /** "true" logs LINE API calls instead of sending them (local dev). */
  LINE_DRY_RUN?: string;
  /** IANA time zone used to display deadlines. Default Asia/Tokyo. */
  DISPLAY_TZ?: string;
}

export type RequestStatus = "pending" | "answered" | "expired";

export interface Answer {
  /** "option" = one of the offered choices, "text" = free text. */
  kind: "option" | "text";
  value: string;
  userId: string;
  answeredAt: number;
}

export interface ApprovalRequest {
  id: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  to: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "answered";
  answer?: Answer;
}

export type LineMessage = Record<string, unknown>;

export interface LineClient {
  push(to: string, messages: LineMessage[]): Promise<void>;
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
  quota(): Promise<{ limit: number | null; used: number }>;
}
