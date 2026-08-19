import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { defineConfig, type Connect, type Plugin } from "vite";

type ApiHandler = (
  req: IncomingMessage & { body?: unknown; query?: Record<string, string | string[]> },
  res: ServerResponse,
) => Promise<void>;

const apiModules: Record<string, () => Promise<{ default: ApiHandler }>> = {
  "/api/battle": () => import("./api/battle") as Promise<{ default: ApiHandler }>,
  "/api/export": () => import("./api/export") as Promise<{ default: ApiHandler }>,
  "/api/health": () => import("./api/health") as Promise<{ default: ApiHandler }>,
  "/api/prune-votes": () => import("./api/prune-votes") as Promise<{ default: ApiHandler }>,
  "/api/stats": () => import("./api/stats") as Promise<{ default: ApiHandler }>,
  "/api/vote": () => import("./api/vote") as Promise<{ default: ApiHandler }>,
};

function queryObject(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const current = query[key];
    if (Array.isArray(current)) {
      current.push(value);
    } else if (typeof current === "string") {
      query[key] = [current, value];
    } else {
      query[key] = value;
    }
  }
  return query;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return undefined;
  const body = Buffer.concat(chunks).toString("utf8");
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("application/json")) return body;
  try {
    return JSON.parse(body);
  } catch {
    // Hand the raw string on so readJsonBody raises JsonBodyError and the handler answers
    // 400, the way it does on Vercel. Parsing here made a bad body a 500 under `npm run dev`.
    return body;
  }
}

function vercelResponse(res: ServerResponse): ServerResponse {
  const response = res as ServerResponse & {
    status: (code: number) => ServerResponse;
    json: (payload: unknown) => ServerResponse;
    send: (payload: unknown) => ServerResponse;
  };

  response.status = (code: number) => {
    res.statusCode = code;
    return response;
  };
  response.json = (payload: unknown) => {
    if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
    return response;
  };
  response.send = (payload: unknown) => {
    if (payload === undefined || payload === null) {
      res.end("");
    } else if (Buffer.isBuffer(payload) || typeof payload === "string") {
      res.end(payload);
    } else {
      response.json(payload);
    }
    return response;
  };

  return response;
}

// Exported so tests/dev-api.test.mjs can mount it on a plain node:http server. Everything
// under `npm run dev` and `npm run preview` reaches the API through here.
export function localApiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const loadHandler = apiModules[url.pathname];
    if (!loadHandler) {
      next();
      return;
    }

    try {
      const { default: handler } = await loadHandler();
      const apiReq = req as IncomingMessage & { body?: unknown; query?: Record<string, string | string[]> };
      apiReq.query = queryObject(url.searchParams);
      apiReq.body = await readBody(req);
      await handler(apiReq, vercelResponse(res));
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      res.end(
        JSON.stringify({
          error: "local_api_failed",
          message: error instanceof Error ? error.message : "unknown_error",
        }),
      );
    }
  };
}

function localApiPlugin(): Plugin {
  return {
    name: "capybara-local-api",
    configureServer(server) {
      server.middlewares.use(localApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(localApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [localApiPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
          return undefined;
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
    // The 10,000-vote analysis case trips the 5s default on a loaded two-core CI runner.
    testTimeout: 20000,
  },
});
