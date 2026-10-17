import { describe, expect, it } from "vitest";
import { allowedUsers, isAllowed } from "../src/app";
import { STRANGER, USER, postbackEvent, setup, textEvent } from "./helpers";

describe("allowlist", () => {
  it("parses comma-separated ids and trims spaces", () => {
    const env = { ALLOWED_USER_IDS: ` ${USER} , U2 ,,` } as never;
    expect(allowedUsers(env)).toEqual([USER, "U2"]);
    expect(isAllowed(env, USER)).toBe(true);
    expect(isAllowed(env, "U3")).toBe(false);
    expect(isAllowed(env, undefined)).toBe(false);
  });

  it("ignores messages from non-allowlisted users (no reply, no answer)", async () => {
    const t = setup();
    const created = await (await t.api("POST", "/api/requests", { question: "OK?" })).json();
    await t.webhook([
      textEvent("承認", STRANGER),
      postbackEvent(`lab=1&id=${created.id}&o=0`, STRANGER),
    ]);
    expect(t.line.replies).toHaveLength(0);
    const got = await (await t.api("GET", `/api/requests/${created.id}`)).json();
    expect(got.status).toBe("pending");
  });

  it("ignores events without a userId (e.g. group without consent)", async () => {
    const t = setup();
    await t.webhook([{ type: "message", replyToken: "r", source: { type: "group" }, message: { type: "text", text: "承認" } }]);
    expect(t.line.replies).toHaveLength(0);
  });

  it("rejects pushing to a `to` that is not allowlisted", async () => {
    const t = setup();
    const res = await t.api("POST", "/api/notify", { text: "hi", to: STRANGER });
    expect(res.status).toBe(400);
    expect(t.line.pushes).toHaveLength(0);
  });

  it("refuses to push when no allowlist is configured", async () => {
    const t = setup({ ALLOWED_USER_IDS: "" });
    const res = await t.api("POST", "/api/notify", { text: "hi" });
    expect(res.status).toBe(500);
    expect(t.line.pushes).toHaveLength(0);
  });
});
