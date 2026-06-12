import { describe, expect, it } from "vitest";
import { createHoldChallenge, verifyHoldSubmission } from "../src/server/hold";

describe("hold verification", () => {
  it("accepts a signed hold challenge", () => {
    const challenge = createHoldChallenge("secret", 1_000, () => 0);
    const result = verifyHoldSubmission({ ...challenge, heldMs: challenge.targetMs }, "secret", 2_000);
    expect(result.valid).toBe(true);
    expect(result.flags).toEqual([]);
  });

  it("rejects short holds", () => {
    const challenge = createHoldChallenge("secret", 1_000, () => 1);
    const result = verifyHoldSubmission({ ...challenge, heldMs: 100 }, "secret", 2_000);
    expect(result.valid).toBe(false);
    expect(result.flags).toContain("hold_too_short");
  });
});
