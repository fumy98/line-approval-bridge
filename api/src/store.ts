import type { ApprovalRequest, KVStore, RequestStatus } from "./types";

/** Keep finished requests around for a week so late polls still get the answer. */
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

const reqKey = (id: string) => `req:${id}`;
const latestKey = (userId: string) => `latest:${userId}`;

export async function saveRequest(kv: KVStore, req: ApprovalRequest, now: number): Promise<void> {
  const ttl = Math.max(60, Math.ceil((req.expiresAt - now) / 1000) + RETENTION_SECONDS);
  await kv.put(reqKey(req.id), JSON.stringify(req), { expirationTtl: ttl });
}

export async function loadRequest(kv: KVStore, id: string): Promise<ApprovalRequest | null> {
  const raw = await kv.get(reqKey(id.toUpperCase()));
  return raw ? (JSON.parse(raw) as ApprovalRequest) : null;
}

/** Remembers the newest request sent to a user, so a plain text reply can be matched to it. */
export async function setLatest(kv: KVStore, userId: string, id: string): Promise<void> {
  await kv.put(latestKey(userId), id, { expirationTtl: RETENTION_SECONDS });
}

export async function getLatest(kv: KVStore, userId: string): Promise<string | null> {
  return kv.get(latestKey(userId));
}

export function statusOf(req: ApprovalRequest, now: number): RequestStatus {
  if (req.status === "answered") return "answered";
  return now >= req.expiresAt ? "expired" : "pending";
}

/** Public shape returned by GET /api/requests/:id. */
export function toPublic(req: ApprovalRequest, now: number) {
  return {
    id: req.id,
    status: statusOf(req, now),
    question: req.question,
    options: req.options,
    allowFreeText: req.allowFreeText,
    createdAt: new Date(req.createdAt).toISOString(),
    expiresAt: new Date(req.expiresAt).toISOString(),
    answer: req.answer
      ? {
          kind: req.answer.kind,
          value: req.answer.value,
          answeredAt: new Date(req.answer.answeredAt).toISOString(),
        }
      : null,
  };
}

// No 0/O/1/I/L to keep IDs easy to type on a phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newId(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}
