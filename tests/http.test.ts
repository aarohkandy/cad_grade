import { describe, expect, it } from "vitest";
import { bearerOrHeaderToken } from "../src/server/http";

describe("admin token extraction", () => {
  it("reads x-admin-token first", () => {
    const token = bearerOrHeaderToken({
      headers: { "x-admin-token": "abc", authorization: "Bearer nope" },
    } as never);
    expect(token).toBe("abc");
  });

  it("reads bearer token", () => {
    const token = bearerOrHeaderToken({
      headers: { authorization: "Bearer secret" },
    } as never);
    expect(token).toBe("secret");
  });
});
