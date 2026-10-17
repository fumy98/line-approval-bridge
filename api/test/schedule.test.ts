import { describe, expect, it } from "vitest";
import { MAX_SCHEDULED, runDue } from "../src/schedule";
import { USER, setup } from "./helpers";

const MIN = 60_000;
// setup() clock starts at 2026-10-17T00:00:00Z.
const in2min = "2026-10-17T09:02+09:00";

describe("scheduled notify", () => {
  it("stores a future sendAt (202) and sends it when the cron reaches that minute", async () => {
    const t = setup();
    const res = await t.api("POST", "/api/notify", { text: "朝の通知", sendAt: in2min });
    expect(res.status).toBe(202);
    const { scheduled } = await res.json();
    expect(scheduled).toMatchObject({ text: "朝の通知", sendAt: "2026-10-17T00:02:00.000Z" });
    expect(t.line.pushes).toHaveLength(0);

    t.advance(1 * MIN);
    expect(await runDue(t.kv, t.line, t.deps.now!())).toEqual({ sent: 0, failed: 0 });
    expect(t.line.pushes).toHaveLength(0);

    t.advance(1 * MIN);
    expect(await runDue(t.kv, t.line, t.deps.now!())).toEqual({ sent: 1, failed: 0 });
    expect(t.line.pushes).toEqual([{ to: USER, messages: [{ type: "text", text: "朝の通知" }] }]);

    // Removed after sending: never sent twice.
    t.advance(1 * MIN);
    await runDue(t.kv, t.line, t.deps.now!());
    expect(t.line.pushes).toHaveLength(1);
    expect((await (await t.api("GET", "/api/scheduled")).json()).scheduled).toEqual([]);
  });

  it("uses a single KV key (no list) and does not write on idle ticks", async () => {
    const t = setup();
    await t.api("POST", "/api/notify", { text: "a", sendAt: in2min });
    await t.api("POST", "/api/notify", { text: "b", sendAt: "2026-10-17T00:05:00Z" });
    expect([...t.kv.data.keys()]).toEqual(["sched:index"]);
    const before = t.kv.data.get("sched:index");
    await runDue(t.kv, t.line, t.deps.now!());
    expect(t.kv.data.get("sched:index")).toBe(before);
  });

  it("sends immediately when sendAt is not in the future", async () => {
    const t = setup();
    const res = await t.api("POST", "/api/notify", { text: "now", sendAt: "2026-10-16T00:00:00Z" });
    expect(res.status).toBe(200);
    expect(t.line.pushes).toHaveLength(1);
  });

  it("validates sendAt", async () => {
    const t = setup();
    for (const sendAt of ["2026-10-18T07:00", "tomorrow", 123, "2026-13-01T00:00Z"]) {
      expect((await t.api("POST", "/api/notify", { text: "x", sendAt })).status).toBe(400);
    }
    expect((await t.api("POST", "/api/notify", { text: "x", sendAt: "2028-01-01T00:00Z" })).status).toBe(400);
    expect(t.line.pushes).toHaveLength(0);
  });

  it("lists in send order and cancels by id", async () => {
    const t = setup();
    const late = await (await t.api("POST", "/api/notify", { text: "late", sendAt: "2026-10-17T03:00Z" })).json();
    await t.api("POST", "/api/notify", { text: "early", sendAt: "2026-10-17T01:00Z" });
    const list = (await (await t.api("GET", "/api/scheduled")).json()).scheduled;
    expect(list.map((s: { text: string }) => s.text)).toEqual(["early", "late"]);

    expect((await t.api("DELETE", `/api/scheduled/${late.scheduled.id}`)).status).toBe(200);
    expect((await t.api("DELETE", `/api/scheduled/${late.scheduled.id}`)).status).toBe(404);
    t.advance(5 * 60 * MIN);
    await runDue(t.kv, t.line, t.deps.now!());
    expect(t.line.pushes.map((p) => (p.messages[0] as { text: string }).text)).toEqual(["early"]);
  });

  it("requires auth for the schedule endpoints", async () => {
    const t = setup();
    expect((await t.api("GET", "/api/scheduled", undefined, "wrong")).status).toBe(401);
    expect((await t.api("DELETE", "/api/scheduled/ABCDEF", undefined, "wrong")).status).toBe(401);
  });

  it(`rejects more than ${MAX_SCHEDULED} pending notifications`, async () => {
    const t = setup();
    for (let i = 0; i < MAX_SCHEDULED; i++) {
      expect((await t.api("POST", "/api/notify", { text: `n${i}`, sendAt: in2min })).status).toBe(202);
    }
    expect((await t.api("POST", "/api/notify", { text: "over", sendAt: in2min })).status).toBe(409);
  });

  it("retries a failed push on the next tick", async () => {
    const t = setup();
    await t.api("POST", "/api/notify", { text: "retry me", sendAt: in2min });
    t.advance(2 * MIN);
    const push = t.line.push.bind(t.line);
    t.line.push = async () => {
      throw new Error("LINE down");
    };
    expect(await runDue(t.kv, t.line, t.deps.now!())).toEqual({ sent: 0, failed: 1 });
    t.line.push = push;
    t.advance(MIN);
    expect(await runDue(t.kv, t.line, t.deps.now!())).toEqual({ sent: 1, failed: 0 });
    expect(t.line.pushes).toHaveLength(1);
  });
});
