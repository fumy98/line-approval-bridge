#!/usr/bin/env node
// Sends a signed LINE webhook to a local `npm run dev` server, as if you replied on LINE.
//
//   npm run simulate -- text "承認"            # plain text reply
//   npm run simulate -- text "#ABC123 却下"    # reply to a specific request
//   npm run simulate -- tap ABC123 0           # tap button #0 of request ABC123
//   npm run simulate -- text "hi" --user Uxxx  # as another (non-allowlisted) user
//
// Reads LINE_CHANNEL_SECRET and ALLOWED_USER_IDS from api/.dev.vars.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const vars = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../api/.dev.vars", import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const args = process.argv.slice(2);
const userFlag = args.indexOf("--user");
const userId = userFlag >= 0 ? args.splice(userFlag, 2)[1] : vars.ALLOWED_USER_IDS.split(",")[0].trim();
const url = process.env.BRIDGE_URL ?? "http://localhost:8787";
const [kind, ...rest] = args;

let event;
if (kind === "text") {
  event = { type: "message", message: { type: "text", id: "1", text: rest.join(" ") } };
} else if (kind === "tap") {
  event = { type: "postback", postback: { data: `lab=1&id=${rest[0]}&o=${rest[1] ?? 0}` } };
} else {
  console.error('usage: simulate-webhook.mjs text "<message>" | tap <ID> <optionIndex> [--user Uxxx]');
  process.exit(1);
}

const body = JSON.stringify({
  destination: "Ulocal",
  events: [{ ...event, replyToken: "local-reply-token", timestamp: Date.now(), source: { type: "user", userId } }],
});
const signature = createHmac("sha256", vars.LINE_CHANNEL_SECRET).update(body).digest("base64");
const res = await fetch(`${url}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Line-Signature": signature },
  body,
});
console.log(res.status, await res.text());
