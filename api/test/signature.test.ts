import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/line";
import { SECRET, setup, textEvent } from "./helpers";

describe("verifySignature", () => {
  const body = JSON.stringify({ events: [] });

  it("accepts a correct signature", async () => {
    expect(await verifySignature(SECRET, body, await signBody(SECRET, body))).toBe(true);
  });

  it("matches a known HMAC-SHA256 vector", async () => {
    // printf '%s' '{"events":[]}' | openssl dgst -sha256 -hmac test-channel-secret -binary | base64
    const expected = "sKRrt+MTE71nWWZPaYrvYSdH9JGlgckmBidZxDuPgPc=";
    expect(await signBody(SECRET, body)).toBe(expected);
    expect(await verifySignature(SECRET, body, expected)).toBe(true);
  });

  it("rejects a signature made with another secret", async () => {
    expect(await verifySignature(SECRET, body, await signBody("other", body))).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = await signBody(SECRET, body);
    expect(await verifySignature(SECRET, body + " ", sig)).toBe(false);
  });

  it("rejects missing or malformed signatures", async () => {
    expect(await verifySignature(SECRET, body, null)).toBe(false);
    expect(await verifySignature(SECRET, body, "")).toBe(false);
    expect(await verifySignature(SECRET, body, "not base64!!")).toBe(false);
    expect(await verifySignature(SECRET, body, "AAAA")).toBe(false);
    expect(await verifySignature("", body, await signBody(SECRET, body))).toBe(false);
  });
});

describe("POST /webhook signature handling", () => {
  it("returns 401 and does nothing on a bad signature", async () => {
    const t = setup();
    const res = await t.webhook([textEvent("承認")], { signature: "AAAA" });
    expect(res.status).toBe(401);
    expect(t.line.replies).toHaveLength(0);
  });

  it("returns 200 for LINE's empty verification request", async () => {
    const t = setup();
    const res = await t.webhook([]);
    expect(res.status).toBe(200);
  });
});
