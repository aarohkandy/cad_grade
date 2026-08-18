import { describe, expect, it } from "vitest";
import { createHoldChallenge, verifyHoldSubmission } from "../src/server/hold";
import type { HoldSubmission } from "../src/shared/types";

const SECRET = "hold-test-secret";
const ISSUED_AT = Date.UTC(2026, 5, 14, 12, 0, 0);
const SOON_AFTER = ISSUED_AT + 2_000;
const MAX_AGE_MS = 10 * 60 * 1000;

// A mid-range target (1275ms) keeps both duration boundaries clear of the 500ms floor.
function held(overrides: Partial<HoldSubmission> = {}): HoldSubmission {
  const challenge = createHoldChallenge(SECRET, ISSUED_AT, () => 0.5);
  return { ...challenge, heldMs: challenge.targetMs, ...overrides };
}

/** api/vote.ts hands req.body straight to the verifier, so tests need to send what the type forbids. */
function fromWire(submission: Record<string, unknown>): HoldSubmission {
  return submission as unknown as HoldSubmission;
}

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

  it("rejects a challenge signed with a different secret", () => {
    const forged = createHoldChallenge("some-other-secret", ISSUED_AT, () => 0.5);
    expect(verifyHoldSubmission({ ...forged, heldMs: forged.targetMs }, SECRET, SOON_AFTER)).toEqual({
      valid: false,
      flags: ["bad_hold_token"],
    });
  });

  it("catches a tampered target or issue time, since the signature covers both", () => {
    const submission = held();
    // Lowering the target only loosens the duration check, so the signature is the only objector.
    expect(verifyHoldSubmission({ ...submission, targetMs: submission.targetMs - 50 }, SECRET, SOON_AFTER)).toEqual({
      valid: false,
      flags: ["bad_hold_token"],
    });
    expect(verifyHoldSubmission({ ...submission, issuedAt: ISSUED_AT + 1 }, SECRET, SOON_AFTER)).toEqual({
      valid: false,
      flags: ["bad_hold_token"],
    });
  });

  it("expires a submission past the ten-minute window", () => {
    const submission = held();
    expect(verifyHoldSubmission(submission, SECRET, ISSUED_AT + MAX_AGE_MS)).toEqual({ valid: true, flags: [] });
    expect(verifyHoldSubmission(submission, SECRET, ISSUED_AT + MAX_AGE_MS + 1)).toEqual({
      valid: false,
      flags: ["hold_expired"],
    });
  });

  it("expires a submission dated more than thirty seconds ahead of the server", () => {
    const submission = held();
    expect(verifyHoldSubmission(submission, SECRET, ISSUED_AT - 30_000)).toEqual({ valid: true, flags: [] });
    expect(verifyHoldSubmission(submission, SECRET, ISSUED_AT - 30_001)).toEqual({
      valid: false,
      flags: ["hold_expired"],
    });
  });

  it("rejects anything that is not exactly the signature hex", () => {
    const submission = held();
    const tokens = {
      not_hex: "not-a-hex-token",
      odd_length: submission.token.slice(0, -1),
      truncated: submission.token.slice(0, 32),
      // Hex decoding stops early, so this one still decodes to the real signature.
      trailing_character: `${submission.token}f`,
    };
    for (const [shape, token] of Object.entries(tokens)) {
      expect({ shape, ...verifyHoldSubmission({ ...submission, token }, SECRET, SOON_AFTER) }).toEqual({
        shape,
        valid: false,
        flags: ["bad_hold_token"],
      });
    }
  });

  it("refuses a submission missing a piece of the challenge", () => {
    const submission = held();
    for (const missing of [{ token: "" }, { challengeId: "" }, { targetMs: 0 }, { issuedAt: 0 }]) {
      expect(verifyHoldSubmission({ ...submission, ...missing }, SECRET, SOON_AFTER)).toEqual({
        valid: false,
        flags: ["bad_hold_payload"],
      });
    }
  });

  it("refuses a submission with no usable held duration", () => {
    const submission = held();
    for (const heldMs of [undefined, null, "a while", {}, Number.NaN]) {
      expect(verifyHoldSubmission(fromWire({ ...submission, heldMs }), SECRET, SOON_AFTER)).toMatchObject({
        valid: false,
      });
    }
    // Only the shapes that are not a number at all are payload errors; null is 0ms, which is short.
    expect(verifyHoldSubmission(fromWire({ ...submission, heldMs: undefined }), SECRET, SOON_AFTER).flags).toEqual([
      "bad_hold_payload",
    ]);
    expect(verifyHoldSubmission(fromWire({ ...submission, heldMs: null }), SECRET, SOON_AFTER).flags).toEqual([
      "hold_too_short",
    ]);
  });

  it("holds the 180ms tolerance to the millisecond", () => {
    const submission = held();
    const floor = submission.targetMs - 180;
    expect(verifyHoldSubmission({ ...submission, heldMs: floor }, SECRET, SOON_AFTER)).toEqual({
      valid: true,
      flags: [],
    });
    expect(verifyHoldSubmission({ ...submission, heldMs: floor - 1 }, SECRET, SOON_AFTER)).toEqual({
      valid: false,
      flags: ["hold_too_short"],
    });
  });

  it("rejects a hold longer than twenty seconds", () => {
    const submission = held();
    expect(verifyHoldSubmission({ ...submission, heldMs: 20_000 }, SECRET, SOON_AFTER)).toEqual({
      valid: true,
      flags: [],
    });
    expect(verifyHoldSubmission({ ...submission, heldMs: 20_001 }, SECRET, SOON_AFTER)).toEqual({
      valid: false,
      flags: ["hold_too_long"],
    });
  });

  it("reports every reason a submission failed, not just the first", () => {
    const submission = held({ heldMs: 10 });
    expect(verifyHoldSubmission(submission, "wrong-secret", ISSUED_AT + MAX_AGE_MS + 1)).toEqual({
      valid: false,
      flags: ["hold_expired", "bad_hold_token", "hold_too_short"],
    });
  });

  it("reports a missing submission instead of throwing", () => {
    expect(verifyHoldSubmission(null, SECRET, SOON_AFTER)).toEqual({ valid: false, flags: ["missing_hold"] });
    expect(verifyHoldSubmission(undefined, SECRET, SOON_AFTER)).toEqual({ valid: false, flags: ["missing_hold"] });
  });
});
