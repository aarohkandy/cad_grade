import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pruneHandler from "../api/prune-votes";

const blob = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

const OLD_VOTE_PATH = "votes/v1/2026-06-14/2026-06-14T19-30-00-000Z_1f0c9b2a.json";
const PRUNE_SECRET = "prune-secret-value";

function mockResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string | number | string[]>,
    setHeader(key: string, value: string | number | string[]) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response;
}

async function prune(paths: string[], headers: Record<string, string> = {}) {
  const response = mockResponse();
  await pruneHandler({ method: "POST", headers, body: { paths } } as never, response as never);
  return response;
}

describe("prune-votes api", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capybara-prune-"));
    process.env.LOCAL_VOTE_DIR = tempDir;
    delete process.env.PRUNE_SECRET;
    blob.del.mockClear();
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    delete process.env.PRUNE_SECRET;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("deletes nothing when no prune secret is configured", async () => {
    const response = await prune([OLD_VOTE_PATH], { "x-prune-secret": PRUNE_SECRET });
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: "prune_not_configured" });
    expect(blob.del).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret, whatever its length", async () => {
    process.env.PRUNE_SECRET = PRUNE_SECRET;

    const sameLength = await prune([OLD_VOTE_PATH], { "x-prune-secret": "prune-secret-valuf" });
    expect(sameLength.statusCode).toBe(401);
    expect(sameLength.body).toEqual({ error: "unauthorized" });

    const shorter = await prune([OLD_VOTE_PATH], { "x-prune-secret": "prune" });
    expect(shorter.statusCode).toBe(401);

    expect(blob.del).not.toHaveBeenCalled();
  });

  it("rejects a request with no secret header", async () => {
    process.env.PRUNE_SECRET = PRUNE_SECRET;
    const response = await prune([OLD_VOTE_PATH]);
    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
    expect(blob.del).not.toHaveBeenCalled();
  });

  it("accepts an authorized request and skips the blob client when nothing is prunable", async () => {
    process.env.PRUNE_SECRET = PRUNE_SECRET;
    const response = await prune([], { "x-prune-secret": PRUNE_SECRET });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ requestedCount: 0, candidateCount: 0, deletedCount: 0 });
    expect(blob.del).not.toHaveBeenCalled();
  });

  it("reports how many paths it ignored when a caller sends more than it accepts", async () => {
    process.env.PRUNE_SECRET = PRUNE_SECRET;
    const paths = Array.from(
      { length: 1200 },
      (_unused, index) => `votes/v1/2026-06-14/2026-06-14T19-30-00-000Z_${String(index).padStart(6, "0")}.json`,
    );

    const response = await prune(paths, { "x-prune-secret": PRUNE_SECRET });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ requestedCount: 1200, skippedCount: 200, deletedCount: 1000 });
  });

  it("still prunes old raw vote blobs for an authorized caller", async () => {
    process.env.PRUNE_SECRET = PRUNE_SECRET;
    const response = await prune([OLD_VOTE_PATH], { "x-prune-secret": PRUNE_SECRET });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ candidateCount: 1, deletedCount: 1, deleted: [OLD_VOTE_PATH] });
    expect(blob.del).toHaveBeenCalledWith([OLD_VOTE_PATH]);
  });
});
