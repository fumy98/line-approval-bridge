import { describe, expect, it } from "vitest";
import { USER, postbackEvent, setup, textEvent } from "./helpers";

describe("API auth", () => {
  it("requires the bearer token", async () => {
    const t = setup();
    expect((await t.api("POST", "/api/notify", { text: "x" }, "wrong")).status).toBe(401);
    const res = await t.api("POST", "/api/notify", { text: "x" }, "");
    expect(res.status).toBe(401);
    expect(t.line.pushes).toHaveLength(0);
  });

  it("is closed when API_TOKEN is not configured", async () => {
    const t = setup({ API_TOKEN: "" });
    expect((await t.api("POST", "/api/notify", { text: "x" }, "")).status).toBe(401);
  });

  it("serves /health without auth", async () => {
    const t = setup();
    const res = await t.api("GET", "/health", undefined, "");
    expect(res.status).toBe(200);
  });
});

describe("setup/webhook", () => {
  it("registers <origin>/webhook on the LINE channel (auth required)", async () => {
    const t = setup();
    expect((await t.api("POST", "/api/setup/webhook", undefined, "wrong")).status).toBe(401);
    const res = await t.api("POST", "/api/setup/webhook");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ endpoint: "https://bridge.test/webhook", test: { success: true } });
    expect(t.line.webhookEndpoints).toEqual(["https://bridge.test/webhook"]);
  });
});

describe("notify", () => {
  it("pushes a text message to the default user", async () => {
    const t = setup();
    const res = await t.api("POST", "/api/notify", { text: "動画を作成しました" });
    expect(res.status).toBe(200);
    expect(t.line.pushes).toEqual([{ to: USER, messages: [{ type: "text", text: "動画を作成しました" }] }]);
  });

  it("validates input", async () => {
    const t = setup();
    expect((await t.api("POST", "/api/notify", {})).status).toBe(400);
    expect((await t.api("POST", "/api/notify", { text: "x".repeat(5001) })).status).toBe(400);
  });
});

describe("approval request lifecycle", () => {
  async function create(t: ReturnType<typeof setup>, body: Record<string, unknown> = {}) {
    const res = await t.api("POST", "/api/requests", { question: "公開してよいですか？", ...body });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ id: string; status: string; options: string[] }>;
  }

  it("creates a pending request and pushes quick reply buttons", async () => {
    const t = setup();
    const r = await create(t);
    expect(r.id).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(r.status).toBe("pending");
    expect(r.options).toEqual(["承認", "却下"]);
    const msg = t.line.pushes[0].messages[0] as {
      text: string;
      quickReply: { items: { action: { label: string; data: string } }[] };
    };
    expect(msg.text).toContain(`#${r.id}`);
    expect(msg.quickReply.items.map((i) => i.action.label)).toEqual(["承認", "却下"]);
    expect(msg.quickReply.items[0].action.data).toBe(`lab=1&id=${r.id}&o=0`);
  });

  it("pending -> answered via postback button", async () => {
    const t = setup();
    const r = await create(t);
    await t.webhook([postbackEvent(`lab=1&id=${r.id}&o=0`)]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.status).toBe("answered");
    expect(got.answer).toMatchObject({ kind: "option", value: "承認" });
    expect(t.line.lastReplyText()).toContain("受け付けました");
  });

  it("only the first answer counts", async () => {
    const t = setup();
    const r = await create(t);
    await t.webhook([postbackEvent(`lab=1&id=${r.id}&o=1`)]);
    await t.webhook([postbackEvent(`lab=1&id=${r.id}&o=0`)]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.answer.value).toBe("却下");
    expect(t.line.lastReplyText()).toContain("回答済み");
  });

  it("a plain text reply equal to an option answers the latest request", async () => {
    const t = setup();
    const r = await create(t);
    await t.webhook([textEvent("却下")]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.answer).toMatchObject({ kind: "option", value: "却下" });
  });

  it("free text answers the latest request when allowed", async () => {
    const t = setup();
    const r = await create(t);
    await t.webhook([textEvent("3番目のトピックを差し替えて")]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.answer).toMatchObject({ kind: "text", value: "3番目のトピックを差し替えて" });
  });

  it("#ID prefix targets an older request", async () => {
    const t = setup();
    const older = await create(t, { question: "A?" });
    const newer = await create(t, { question: "B?" });
    await t.webhook([textEvent(`#${older.id.toLowerCase()} 承認`)]);
    const a = await (await t.api("GET", `/api/requests/${older.id}`)).json();
    const b = await (await t.api("GET", `/api/requests/${newer.id}`)).json();
    expect(a.answer.value).toBe("承認");
    expect(b.status).toBe("pending");
  });

  it("free text is refused when allowFreeText=false", async () => {
    const t = setup();
    const r = await create(t, { allowFreeText: false });
    await t.webhook([textEvent("たぶんOK")]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.status).toBe("pending");
    expect(t.line.lastReplyText()).toContain("ボタンから選んでください");
  });

  it("custom options are offered and accepted", async () => {
    const t = setup();
    const r = await create(t, { options: ["A案", "B案", "C案"] });
    await t.webhook([postbackEvent(`lab=1&id=${r.id}&o=2`)]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.answer.value).toBe("C案");
  });

  it("pending -> expired after the timeout; late answers are refused", async () => {
    const t = setup();
    const r = await create(t, { timeoutSeconds: 60 });
    t.advance(61_000);
    let got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.status).toBe("expired");
    await t.webhook([postbackEvent(`lab=1&id=${r.id}&o=0`)]);
    got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.status).toBe("expired");
    expect(got.answer).toBeNull();
    expect(t.line.lastReplyText()).toContain("期限切れ");
  });

  it("text with nothing pending gets a friendly reply", async () => {
    const t = setup();
    await t.webhook([textEvent("こんにちは")]);
    expect(t.line.lastReplyText()).toContain("回答待ちの依頼はありません");
  });

  it("ignores postbacks with unknown ids or indexes", async () => {
    const t = setup();
    const r = await create(t);
    await t.webhook([postbackEvent(`lab=1&id=${r.id}&o=9`), postbackEvent("lab=1&id=ZZZZZZ&o=0")]);
    const got = await (await t.api("GET", `/api/requests/${r.id}`)).json();
    expect(got.status).toBe("pending");
  });

  it("returns 404 for unknown ids", async () => {
    const t = setup();
    expect((await t.api("GET", "/api/requests/ABCDEF")).status).toBe(404);
  });

  it("validates options and timeout", async () => {
    const t = setup();
    const bad = [
      { question: "" },
      { question: "q", options: [] },
      { question: "q", options: ["x".repeat(21)] },
      { question: "q", options: ["a", "a"] },
      { question: "q", options: Array.from({ length: 14 }, (_, i) => `o${i}`) },
      { question: "q", timeoutSeconds: 10 },
      { question: "q", timeoutSeconds: 1.5 },
    ];
    for (const body of bad) {
      expect((await t.api("POST", "/api/requests", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(t.line.pushes).toHaveLength(0);
  });

  it("reports LINE API failures as 502", async () => {
    const t = setup();
    t.line.push = async () => {
      throw new Error("LINE API error 429: quota");
    };
    const res = await t.api("POST", "/api/notify", { text: "x" });
    expect(res.status).toBe(502);
  });
});
