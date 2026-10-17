#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isMain } from "./entry.js";
import { BridgeClient, type ApprovalResult } from "./client.js";

const DEFAULT_WAIT = 600; // keep a single tool call well under typical MCP timeouts

function summarize(r: ApprovalResult): string {
  if (r.status === "answered" && r.answer) {
    return `answered: ${JSON.stringify(r.answer.value)} (${r.answer.kind}) [id=${r.id}]`;
  }
  if (r.status === "expired") return `expired without an answer [id=${r.id}]`;
  return `still pending — call get_reply with id=${r.id} to keep waiting`;
}

const result = (r: ApprovalResult) => ({
  content: [{ type: "text" as const, text: `${summarize(r)}\n${JSON.stringify(r)}` }],
  structuredContent: r as unknown as Record<string, unknown>,
});

export function createServer(client: BridgeClient): McpServer {
  const server = new McpServer({ name: "line-approval-bridge", version: "0.1.0" });

  server.registerTool(
    "notify",
    {
      title: "Send a LINE notification",
      description: "Push a one-way text message to the user's LINE. Does not wait for a reply.",
      inputSchema: { text: z.string().min(1).max(5000) },
    },
    async ({ text }) => {
      await client.notify(text);
      return { content: [{ type: "text", text: "sent" }] };
    },
  );

  server.registerTool(
    "ask_approval",
    {
      title: "Ask the user on LINE and wait",
      description:
        "Send a question to the user's LINE with buttons (default 承認/却下) and wait for the answer. " +
        "Returns status answered/expired/pending and the answer value. If still pending after " +
        "wait_seconds, call get_reply with the returned id to keep waiting. Branch on answer.value.",
      inputSchema: {
        question: z.string().min(1).max(4800),
        options: z.array(z.string().min(1).max(20)).min(1).max(13).optional()
          .describe("Button labels. Default [\"承認\",\"却下\"]"),
        allow_free_text: z.boolean().optional().describe("Accept typed replies too (default true)"),
        timeout: z.number().int().min(60).max(604800).optional()
          .describe("Seconds until the request expires on the server (default 86400)"),
        wait_seconds: z.number().int().min(0).max(3600).optional()
          .describe(`How long this call blocks waiting (default ${DEFAULT_WAIT}; 0 = return immediately)`),
      },
    },
    async ({ question, options, allow_free_text, timeout, wait_seconds }) => {
      const created = await client.ask({
        question,
        options,
        allowFreeText: allow_free_text,
        timeoutSeconds: timeout,
      });
      const wait = wait_seconds ?? DEFAULT_WAIT;
      const r = wait > 0 ? await client.waitFor(created.id, { waitSeconds: wait }) : created;
      return result(r);
    },
  );

  server.registerTool(
    "get_reply",
    {
      title: "Get / wait for a LINE reply",
      description: "Get the state of an approval request by id, optionally waiting until it is answered.",
      inputSchema: {
        id: z.string().regex(/^[0-9A-Za-z]{6}$/),
        wait_seconds: z.number().int().min(0).max(3600).optional()
          .describe(`How long to wait for an answer (default ${DEFAULT_WAIT}; 0 = check once)`),
      },
    },
    async ({ id, wait_seconds }) => {
      const wait = wait_seconds ?? DEFAULT_WAIT;
      const r = wait > 0 ? await client.waitFor(id, { waitSeconds: wait }) : await client.get(id);
      return result(r);
    },
  );

  return server;
}

const isEntry = isMain(import.meta.url);
if (isEntry) {
  const server = createServer(BridgeClient.fromEnv());
  await server.connect(new StdioServerTransport());
}
