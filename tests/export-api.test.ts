import { afterEach, describe, expect, it } from "vitest";
import handler from "../api/export";

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

describe("export api auth", () => {
  afterEach(() => {
    delete process.env.ADMIN_EXPORT_TOKEN;
  });

  it("rejects missing admin token", async () => {
    process.env.ADMIN_EXPORT_TOKEN = "secret";
    const response = mockResponse();
    await handler({ method: "GET", headers: {}, query: {} } as never, response as never);
    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
  });
});
