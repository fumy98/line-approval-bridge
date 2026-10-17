import { handle } from "./app";
import { createLineClient } from "./line";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, { env, line: createLineClient(env) });
  },
};
