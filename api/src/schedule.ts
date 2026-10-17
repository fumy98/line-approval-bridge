import { newId } from "./store";
import type { KVStore, LineClient } from "./types";

/**
 * Scheduled notifications live in ONE KV key so the per-minute cron only needs a single `get`
 * (KV `list` is limited to 1,000 calls/day on the free plan; a minutely cron makes 1,440).
 */
const INDEX_KEY = "sched:index";

export const MAX_SCHEDULED = 100;
export const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** A failed push is retried on the next cron tick, up to this many attempts in total. */
const MAX_ATTEMPTS = 5;

export interface ScheduledNotification {
  id: string;
  text: string;
  to: string;
  sendAt: number;
  createdAt: number;
  attempts?: number;
}

/** ISO 8601 with an explicit offset (Z or ±hh:mm), so "07:00" never silently means UTC. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseSendAt(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export async function loadScheduled(kv: KVStore): Promise<ScheduledNotification[]> {
  const raw = await kv.get(INDEX_KEY);
  return raw ? (JSON.parse(raw) as ScheduledNotification[]) : [];
}

async function saveScheduled(kv: KVStore, items: ScheduledNotification[]): Promise<void> {
  items.sort((a, b) => a.sendAt - b.sendAt);
  await kv.put(INDEX_KEY, JSON.stringify(items));
}

export async function addScheduled(
  kv: KVStore,
  item: Omit<ScheduledNotification, "id">,
): Promise<ScheduledNotification | "full"> {
  const items = await loadScheduled(kv);
  if (items.length >= MAX_SCHEDULED) return "full";
  const s: ScheduledNotification = { id: newId(), ...item };
  items.push(s);
  await saveScheduled(kv, items);
  return s;
}

export async function removeScheduled(kv: KVStore, id: string): Promise<boolean> {
  const items = await loadScheduled(kv);
  const rest = items.filter((s) => s.id !== id.toUpperCase());
  if (rest.length === items.length) return false;
  await saveScheduled(kv, rest);
  return true;
}

export const scheduledToPublic = (s: ScheduledNotification) => ({
  id: s.id,
  text: s.text,
  sendAt: new Date(s.sendAt).toISOString(),
  createdAt: new Date(s.createdAt).toISOString(),
});

/** Called by the Cron Trigger: pushes every due notification and drops it from the index. */
export async function runDue(
  kv: KVStore,
  line: LineClient,
  now: number,
): Promise<{ sent: number; failed: number }> {
  const items = await loadScheduled(kv);
  const due = items.filter((s) => s.sendAt <= now);
  if (due.length === 0) return { sent: 0, failed: 0 }; // no write on idle ticks

  const keep = items.filter((s) => s.sendAt > now);
  let sent = 0;
  let failed = 0;
  for (const s of due) {
    try {
      await line.push(s.to, [{ type: "text", text: s.text }]);
      sent++;
    } catch (e) {
      failed++;
      const attempts = (s.attempts ?? 0) + 1;
      console.log(`scheduled push ${s.id} failed (attempt ${attempts}): ${e}`);
      if (attempts < MAX_ATTEMPTS) keep.push({ ...s, attempts });
    }
  }
  // Re-read so a notification scheduled while we were pushing is not lost.
  const latest = await loadScheduled(kv);
  const dueIds = new Set(due.map((s) => s.id));
  const keepIds = new Set(keep.map((s) => s.id));
  for (const s of latest) if (!dueIds.has(s.id) && !keepIds.has(s.id)) keep.push(s);
  // Drop entries cancelled while we were pushing.
  const latestIds = new Set(latest.map((s) => s.id));
  await saveScheduled(kv, keep.filter((s) => latestIds.has(s.id)));
  return { sent, failed };
}
