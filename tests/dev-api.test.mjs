import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localApiMiddleware } from "../vite.config";

// The dev server is the only thing that runs this middleware, so the tests drive it the
// way a browser does: a real socket, real headers, real fetch.
const FELL_THROUGH = "not an api route";

describe("dev API middleware", () => {
  let server;
  let origin = "";
  let tempDir = "";
  let passedOn = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capybara-dev-api-"));
    process.env.LOCAL_VOTE_DIR = tempDir;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.BLOB_READ_WRITE_TOKEN;

    passedOn = null;
    const middleware = localApiMiddleware();
    server = createServer((req, res) => {
      middleware(req, res, () => {
        passedOn = { query: req.query, body: req.body };
        res.statusCode = 404;
        res.end(FELL_THROUGH);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    // fetch keeps its sockets alive, and close() waits for every one of them.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.LOCAL_VOTE_DIR;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("answers a body that is not JSON with the handler's 400, not the middleware's 500", async () => {
    const response = await fetch(`${origin}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  });

  it("hands a parsed body to the handler", async () => {
    const response = await fetch(`${origin}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_items" });
  });

  it("serves a battle", async () => {
    const response = await fetch(`${origin}/api/battle`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.battleId).toBe("string");
    expect(body.left.id).not.toBe(body.right.id);
    expect(body.hold).toMatchObject({
      challengeId: expect.any(String),
      token: expect.any(String),
      targetMs: expect.any(Number),
    });
  });

  it("refuses a method the route does not take and names the one it does", async () => {
    const response = await fetch(`${origin}/api/battle`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });

  it("passes the export's CSV headers through", async () => {
    const response = await fetch(`${origin}/api/export?format=csv&table=item_stats`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="item_stats.csv"');
  });

  // queryObject collects a repeated key into an array and firstQueryValue reads element
  // zero, so the first ?limit= is the one that counts. Collapsing the repeat to the last
  // value would let a junk limit through behind a good one.
  it("gives the handler the first of a repeated query parameter", async () => {
    const junkFirst = await fetch(`${origin}/api/export?limit=notanumber&limit=5`);
    expect(junkFirst.status).toBe(400);
    expect(await junkFirst.json()).toEqual({ error: "invalid_limit" });

    const junkSecond = await fetch(`${origin}/api/export?limit=5&limit=notanumber`);
    expect(junkSecond.status).toBe(200);
  });

  it("leaves a path it does not serve alone", async () => {
    const response = await fetch(`${origin}/api/nope`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(FELL_THROUGH);
    expect(passedOn).toEqual({ query: undefined, body: undefined });
  });
});
