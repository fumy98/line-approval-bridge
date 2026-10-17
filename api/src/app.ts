import { verifySignature } from "./line";
import {
  MAX_AHEAD_MS,
  MAX_SCHEDULED,
  addScheduled,
  loadScheduled,
  parseSendAt,
  removeScheduled,
  scheduledToPublic,
} from "./schedule";
import { getLatest, loadRequest, newId, saveRequest, setLatest, statusOf, toPublic } from "./store";
import type { ApprovalRequest, Env, LineClient, LineMessage } from "./types";

export interface Deps {
  env: Env;
  line: LineClient;
  now?: () => number;
}

const MAX_TEXT = 5000; // LINE text message limit
const MAX_OPTIONS = 13; // LINE quick reply limit
const MAX_OPTION_LABEL = 20; // LINE quick reply label limit
const MIN_TIMEOUT = 60;
const MAX_TIMEOUT = 7 * 24 * 60 * 60;
const DEFAULT_TIMEOUT = 24 * 60 * 60;
const DEFAULT_OPTIONS = ["承認", "却下"];
const APPROVE_COLOR = "#06C755"; // LINE green

export function allowedUsers(env: Env): string[] {
  return (env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowed(env: Env, userId: string | undefined): boolean {
  return !!userId && allowedUsers(env).includes(userId);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const error = (status: number, message: string) => json({ error: message }, status);

/** Constant-time string comparison for the bearer token. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false;
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1].trim(), env.API_TOKEN);
}

function resolveTarget(env: Env, to: unknown): string | Response {
  if (to !== undefined) {
    if (typeof to !== "string" || !isAllowed(env, to)) {
      return error(400, "`to` must be one of ALLOWED_USER_IDS");
    }
    return to;
  }
  const fallback = env.DEFAULT_TO?.trim() || allowedUsers(env)[0];
  if (!fallback || !isAllowed(env, fallback)) {
    return error(500, "No recipient: set ALLOWED_USER_IDS (and optionally DEFAULT_TO)");
  }
  return fallback;
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return error(400, "Body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    return error(400, "Invalid JSON");
  }
}

function formatDeadline(env: Env, ms: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: env.DISPLAY_TZ || "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/**
 * Buttons live inside a Flex bubble so they render on LINE for PC/Mac as well as phones
 * (quick replies only appear on phones). Quick replies are kept as a phone-side shortcut.
 */
export function approvalMessage(env: Env, r: ApprovalRequest): LineMessage {
  const how = r.allowFreeText ? "ボタンで回答するか、文字で返信してください。" : "ボタンで回答してください。";
  const postback = (label: string, i: number) => ({
    type: "postback",
    label,
    data: `lab=1&id=${r.id}&o=${i}`,
    displayText: label,
  });
  return {
    type: "flex",
    // Shown in the chat list, notifications and the lock screen, so the question comes first.
    altText: `${r.question}（承認依頼 #${r.id}）`.slice(0, 400),
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: APPROVE_COLOR,
        paddingAll: "md",
        contents: [{ type: "text", text: "承認のお願い", weight: "bold", size: "sm", color: "#FFFFFF" }],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        contents: [
          { type: "text", text: r.question, wrap: true, weight: "bold", size: "lg" },
          {
            type: "text",
            text: `#${r.id}  期限 ${formatDeadline(env, r.expiresAt)}\n${how}`,
            wrap: true,
            size: "xs",
            color: "#888888",
          },
        ],
      },
      // Full-width buttons stacked vertically so long or many options stay readable.
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: r.options.map((label, i) => ({
          type: "button",
          style: i === 0 ? "primary" : "secondary",
          ...(i === 0 ? { color: APPROVE_COLOR } : {}),
          height: "md",
          action: postback(label, i),
        })),
      },
    },
    // Phone-side shortcut above the input box; also a fallback where Flex is not rendered.
    quickReply: {
      items: r.options.map((label, i) => ({ type: "action", action: postback(label, i) })),
    },
  };
}

const text = (t: string): LineMessage => ({ type: "text", text: t });

// ---------------------------------------------------------------- HTTP API

async function handleNotify(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const t = body.text;
  if (typeof t !== "string" || !t.trim()) return error(400, "`text` is required");
  if (t.length > MAX_TEXT) return error(400, `\`text\` must be <= ${MAX_TEXT} chars`);
  let sendAt: number | null = null;
  if (body.sendAt !== undefined && body.sendAt !== null) {
    sendAt = parseSendAt(body.sendAt);
    if (sendAt === null) {
      return error(400, "`sendAt` must be ISO 8601 with a time zone, e.g. 2026-10-18T07:00+09:00");
    }
  }
  const to = resolveTarget(deps.env, body.to);
  if (to instanceof Response) return to;
  const now = (deps.now ?? Date.now)();
  if (sendAt !== null && sendAt > now) {
    if (sendAt - now > MAX_AHEAD_MS) return error(400, "`sendAt` must be within 365 days");
    const s = await addScheduled(deps.env.KV, { text: t, to, sendAt, createdAt: now });
    if (s === "full") return error(409, `Too many scheduled notifications (max ${MAX_SCHEDULED})`);
    return json({ ok: true, scheduled: scheduledToPublic(s) }, 202);
  }
  // No sendAt, or a time already in the past: send now.
  await deps.line.push(to, [text(t)]);
  return json({ ok: true });
}

async function handleCreateRequest(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const now = (deps.now ?? Date.now)();

  const question = body.question;
  if (typeof question !== "string" || !question.trim()) return error(400, "`question` is required");
  if (question.length > MAX_TEXT - 200) return error(400, "`question` is too long");

  let options = DEFAULT_OPTIONS;
  if (body.options !== undefined) {
    if (
      !Array.isArray(body.options) ||
      body.options.length < 1 ||
      body.options.length > MAX_OPTIONS ||
      !body.options.every((o) => typeof o === "string" && o.trim() && o.length <= MAX_OPTION_LABEL)
    ) {
      return error(400, `\`options\` must be 1-${MAX_OPTIONS} strings of 1-${MAX_OPTION_LABEL} chars`);
    }
    options = (body.options as string[]).map((o) => o.trim());
    if (new Set(options).size !== options.length) return error(400, "`options` must be unique");
  }

  const allowFreeText = body.allowFreeText === undefined ? true : body.allowFreeText === true;

  let timeout = DEFAULT_TIMEOUT;
  if (body.timeoutSeconds !== undefined) {
    const n = Number(body.timeoutSeconds);
    if (!Number.isInteger(n) || n < MIN_TIMEOUT || n > MAX_TIMEOUT) {
      return error(400, `\`timeoutSeconds\` must be an integer ${MIN_TIMEOUT}-${MAX_TIMEOUT}`);
    }
    timeout = n;
  }

  const to = resolveTarget(deps.env, body.to);
  if (to instanceof Response) return to;

  const r: ApprovalRequest = {
    id: newId(),
    question: question.trim(),
    options,
    allowFreeText,
    to,
    createdAt: now,
    expiresAt: now + timeout * 1000,
    status: "pending",
  };
  await saveRequest(deps.env.KV, r, now);
  await setLatest(deps.env.KV, to, r.id);
  await deps.line.push(to, [approvalMessage(deps.env, r)]);
  return json(toPublic(r, now), 201);
}

async function handleGetRequest(id: string, deps: Deps): Promise<Response> {
  const r = await loadRequest(deps.env.KV, id);
  if (!r) return error(404, "Request not found");
  return json(toPublic(r, (deps.now ?? Date.now)()));
}

// ---------------------------------------------------------------- Webhook

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
  postback?: { data: string };
}

type Outcome =
  | { kind: "answered"; req: ApprovalRequest }
  | { kind: "already"; req: ApprovalRequest }
  | { kind: "expired"; req: ApprovalRequest }
  | { kind: "not_found" }
  | { kind: "no_pending" }
  | { kind: "need_option"; req: ApprovalRequest }
  | { kind: "ignored" };

async function answer(
  deps: Deps,
  r: ApprovalRequest | null,
  userId: string,
  value: string,
  kind: "option" | "text",
): Promise<Outcome> {
  const now = (deps.now ?? Date.now)();
  if (!r) return { kind: "not_found" };
  if (r.to !== userId) return { kind: "not_found" };
  const status = statusOf(r, now);
  if (status === "answered") return { kind: "already", req: r };
  if (status === "expired") return { kind: "expired", req: r };
  r.status = "answered";
  r.answer = { kind, value, userId, answeredAt: now };
  await saveRequest(deps.env.KV, r, now);
  return { kind: "answered", req: r };
}

async function handlePostback(deps: Deps, userId: string, data: string): Promise<Outcome> {
  const p = new URLSearchParams(data);
  if (p.get("lab") !== "1") return { kind: "ignored" };
  const r = await loadRequest(deps.env.KV, p.get("id") ?? "");
  const idx = Number(p.get("o"));
  if (!r) return { kind: "not_found" };
  const label = r.options[idx];
  if (label === undefined) return { kind: "not_found" };
  return answer(deps, r, userId, label, "option");
}

async function handleText(deps: Deps, userId: string, raw: string): Promise<Outcome> {
  const m = raw.trim().match(/^#([0-9A-Za-z]{6})\s*([\s\S]*)$/);
  let r: ApprovalRequest | null;
  let body: string;
  if (m) {
    r = await loadRequest(deps.env.KV, m[1]);
    body = m[2].trim();
    if (!r) return { kind: "not_found" };
  } else {
    const latest = await getLatest(deps.env.KV, userId);
    r = latest ? await loadRequest(deps.env.KV, latest) : null;
    body = raw.trim();
    if (!r || statusOf(r, (deps.now ?? Date.now)()) !== "pending") return { kind: "no_pending" };
  }
  if (r.options.includes(body)) return answer(deps, r, userId, body, "option");
  if (!r.allowFreeText || !body) {
    return statusOf(r, (deps.now ?? Date.now)()) === "pending"
      ? { kind: "need_option", req: r }
      : answer(deps, r, userId, body, "text"); // reuse already/expired messages
  }
  return answer(deps, r, userId, body, "text");
}

function outcomeMessage(o: Outcome): string | null {
  switch (o.kind) {
    case "answered":
      return `受け付けました: 「${o.req.answer!.value}」 (#${o.req.id})`;
    case "already":
      return `#${o.req.id} は回答済みです（「${o.req.answer!.value}」）。`;
    case "expired":
      return `#${o.req.id} は期限切れです。`;
    case "not_found":
      return "該当する依頼が見つかりません。";
    case "no_pending":
      return "現在、回答待ちの依頼はありません。";
    case "need_option":
      return `#${o.req.id} はボタンから選んでください: ${o.req.options.join(" / ")}`;
    case "ignored":
      return null;
  }
}

async function handleWebhook(req: Request, deps: Deps): Promise<Response> {
  const raw = await req.text();
  const ok = await verifySignature(
    deps.env.LINE_CHANNEL_SECRET,
    raw,
    req.headers.get("X-Line-Signature"),
  );
  if (!ok) return error(401, "Invalid signature");

  let events: LineEvent[];
  try {
    events = (JSON.parse(raw) as { events?: LineEvent[] }).events ?? [];
  } catch {
    return error(400, "Invalid JSON");
  }

  for (const ev of events) {
    const userId = ev.source?.userId;
    if (!isAllowed(deps.env, userId)) {
      console.log(`ignored event from non-allowlisted user: ${userId ?? "(none)"}`);
      continue;
    }
    let outcome: Outcome = { kind: "ignored" };
    if (ev.type === "postback" && ev.postback) {
      outcome = await handlePostback(deps, userId!, ev.postback.data);
    } else if (ev.type === "message" && ev.message?.type === "text" && ev.message.text) {
      outcome = await handleText(deps, userId!, ev.message.text);
    }
    const msg = outcomeMessage(outcome);
    if (msg && ev.replyToken) {
      // Reply messages are free and do not count toward the monthly push quota.
      try {
        await deps.line.reply(ev.replyToken, [text(msg)]);
      } catch (e) {
        console.log(`reply failed: ${e}`);
      }
    }
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- Router

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health" && req.method === "GET") return json({ ok: true });
  if (path === "/webhook" && req.method === "POST") return handleWebhook(req, deps);

  if (path.startsWith("/api/")) {
    if (!authorized(req, deps.env)) return error(401, "Unauthorized");
    try {
      if (path === "/api/notify" && req.method === "POST") return await handleNotify(req, deps);
      if (path === "/api/requests" && req.method === "POST") return await handleCreateRequest(req, deps);
      const m = path.match(/^\/api\/requests\/([0-9A-Za-z]{6})$/);
      if (m && req.method === "GET") return await handleGetRequest(m[1], deps);
      if (path === "/api/scheduled" && req.method === "GET") {
        const items = await loadScheduled(deps.env.KV);
        return json({ scheduled: items.map(scheduledToPublic) });
      }
      const sm = path.match(/^\/api\/scheduled\/([0-9A-Za-z]{6})$/);
      if (sm && req.method === "DELETE") {
        return (await removeScheduled(deps.env.KV, sm[1]))
          ? json({ ok: true })
          : error(404, "Scheduled notification not found");
      }
      if (path === "/api/quota" && req.method === "GET") return json(await deps.line.quota());
      if (path === "/api/setup/webhook" && req.method === "POST") {
        return json(await deps.line.setupWebhook(`${url.origin}/webhook`));
      }
    } catch (e) {
      console.log(`api error: ${e}`);
      return error(502, e instanceof Error ? e.message : String(e));
    }
  }
  return error(404, "Not found");
}
