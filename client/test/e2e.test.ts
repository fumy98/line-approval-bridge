// Runs the real client, CLI and MCP server against the real Worker handler
// (in-memory KV + fake LINE), simulating the user's reply via a signed webhook.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../api/src/app";
import { signBody } from "../../api/src/line";
import { FakeLine, MemoryKV, SECRET, TOKEN, USER } from "../../api/test/helpers";
import { main } from "../src/cli";
import { BridgeClient } from "../src/client";
import { createServer } from "../src/mcp";

function bridge() {
  const line = new FakeLine();
  const deps = {
    env: {
      KV: new MemoryKV(),
      LINE_CHANNEL_SECRET: SECRET,
      LINE_CHANNEL_ACCESS_TOKEN: "x",
      API_TOKEN: TOKEN,
      ALLOWED_USER_IDS: USER,
    },
    line,
  };
  const fetchImpl = ((input: string, init?: RequestInit) =>
    handle(new Request(input, init), deps)) as unknown as typeof fetch;

  /** Simulates the user tapping a button on LINE. */
  async function tap(id: string, optionIndex: number) {
    const raw = JSON.stringify({
      events: [
        {
          type: "postback",
          replyToken: "r",
          source: { type: "user", userId: USER },
          postback: { data: `lab=1&id=${id}&o=${optionIndex}` },
        },
      ],
    });
    await handle(
      new Request("https://bridge.test/webhook", {
        method: "POST",
        headers: { "X-Line-Signature": await signBody(SECRET, raw) },
        body: raw,
      }),
      deps,
    );
  }

  const lastPushedId = () => {
    const msg = line.pushes.at(-1)!.messages[0] as { altText: string };
    return msg.altText.match(/#([0-9A-Z]{6})/)![1];
  };

  // The user answers on the 2nd poll.
  let polls = 0;
  const sleep = async () => {
    polls++;
    if (polls === 1) await tap(lastPushedId(), 0);
  };

  const client = new BridgeClient({ baseUrl: "https://bridge.test", token: TOKEN, fetch: fetchImpl, sleep });
  return { client, line, tap, lastPushedId };
}

afterEach(() => vi.restoreAllMocks());

describe("client library", () => {
  it("askAndWait returns the user's answer", async () => {
    const { client } = bridge();
    const r = await client.askAndWait({ question: "OK?" }, { waitSeconds: 60, intervalMs: 1 });
    expect(r.status).toBe("answered");
    expect(r.answer?.value).toBe("承認");
  });

  it("waitFor returns pending when the local wait elapses", async () => {
    const { client } = bridge();
    const created = await client.ask({ question: "OK?" });
    const r = await client.waitFor(created.id, { waitSeconds: 0 });
    expect(r.status).toBe("pending");
  });

  it("surfaces server errors with status", async () => {
    const bad = new BridgeClient({
      baseUrl: "https://bridge.test",
      token: "wrong",
      fetch: bridge().client["fetchImpl" as never],
    });
    await expect(bad.notify("x")).rejects.toMatchObject({ status: 401 });
  });

  it("requires url and token", () => {
    expect(() => BridgeClient.fromEnv({})).toThrow(/LINE_APPROVAL_URL/);
    expect(() => BridgeClient.fromEnv({ LINE_APPROVAL_URL: "https://x" })).toThrow(/LINE_APPROVAL_TOKEN/);
  });
});

describe("CLI", () => {
  it("setup-webhook registers the endpoint", async () => {
    const { client, line } = bridge();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["setup-webhook"], client)).toBe(0);
    expect(line.webhookEndpoints).toEqual(["https://bridge.test/webhook"]);
  });

  it("ask --print value prints the answer and exits 0", async () => {
    const { client } = bridge();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await main(["ask", "公開しますか？", "--wait", "60", "--print", "value"], client);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith("承認\n");
  });

  it("exits 3 when still pending after --wait", async () => {
    const { client } = bridge();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Wait 0 seconds -> no sleep -> no tap.
    const code = await main(["ask", "OK?", "--wait", "0"], client);
    expect(code).toBe(3);
  });

  it("notify pushes the text", async () => {
    const { client, line } = bridge();
    expect(await main(["notify", "完了しました"], client)).toBe(0);
    expect(line.pushes[0].messages[0]).toEqual({ type: "text", text: "完了しました" });
  });
});

describe("MCP server", () => {
  async function connect(client: BridgeClient) {
    const server = createServer(client);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return mcp;
  }

  it("lists notify / ask_approval / get_reply", async () => {
    const mcp = await connect(bridge().client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ask_approval", "get_reply", "notify"]);
  });

  it("ask_approval waits and returns the answer", async () => {
    const mcp = await connect(bridge().client);
    const res = await mcp.callTool({ name: "ask_approval", arguments: { question: "OK?", wait_seconds: 60 } });
    expect(res.structuredContent).toMatchObject({ status: "answered", answer: { value: "承認" } });
  });

  it("ask_approval with wait_seconds=0 returns pending; get_reply picks up the answer", async () => {
    const { client, tap } = bridge();
    const mcp = await connect(client);
    const res = await mcp.callTool({ name: "ask_approval", arguments: { question: "OK?", options: ["A", "B"], wait_seconds: 0 } });
    const { id, status } = res.structuredContent as { id: string; status: string };
    expect(status).toBe("pending");
    await tap(id, 1);
    const got = await mcp.callTool({ name: "get_reply", arguments: { id, wait_seconds: 0 } });
    expect(got.structuredContent).toMatchObject({ status: "answered", answer: { value: "B" } });
  });
});
