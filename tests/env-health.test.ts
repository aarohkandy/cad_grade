import { afterEach, beforeEach, describe, expect, it } from "vitest";
import healthHandler from "../api/health";
import { missingProductionEnv, storageReadyForPublicTraffic } from "../src/server/env";
import { storageMode } from "../src/server/voteStore";

const ENV_KEYS = [
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "HOLD_VERIFY_SECRET",
  "IP_HASH_SALT",
  "LOCAL_VOTE_DIR",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_OIDC_TOKEN",
];

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

describe("production environment readiness", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not use local vote storage on Vercel", () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    process.env.LOCAL_VOTE_DIR = ".local-data/blob";

    expect(storageMode()).toBe("unconfigured");
    expect(storageReadyForPublicTraffic(storageMode())).toBe(false);
    expect(missingProductionEnv()).toContain("BLOB_READ_WRITE_TOKEN");
  });

  it("reports ready when Vercel production secrets are configured", () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    process.env.BLOB_READ_WRITE_TOKEN = "blob-secret";
    process.env.IP_HASH_SALT = "hash-secret";
    process.env.HOLD_VERIFY_SECRET = "hold-secret";

    expect(storageMode()).toBe("blob");
    expect(missingProductionEnv()).toEqual([]);
    expect(storageReadyForPublicTraffic(storageMode())).toBe(true);
  });

  it("exposes missing Vercel readiness through health", async () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";

    const response = mockResponse();
    await healthHandler({ method: "GET", headers: {}, query: {} } as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      ready: false,
      runtime: "vercel",
      storage: "not_configured",
      storageMode: "unconfigured",
    });
    expect((response.body as { missingEnv: string[] }).missingEnv).toContain("BLOB_READ_WRITE_TOKEN");
  });
});
