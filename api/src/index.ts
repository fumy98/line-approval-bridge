import { handle } from "./app";
import { createLineClient } from "./line";
import { runDue } from "./schedule";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, { env, line: createLineClient(env) });
  },

  /** Cron Trigger (every minute, see wrangler.toml): sends scheduled notifications that are due. */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runDue(env.KV, createLineClient(env), controller.scheduledTime).then(({ sent, failed }) => {
        if (sent || failed) console.log(`scheduled: sent=${sent} failed=${failed}`);
      }),
    );
  },
};
