import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { HoldChallenge, HoldSubmission } from "../shared/types";

// A token is signed but never spent, and nothing ties it to a session or a battle, so one
// cleared challenge replays across every vote sent inside this window. Binding it needs a
// nonce issued by api/battle.ts and consumed by api/vote.ts; until then this is the limit.
const MAX_AGE_MS = 10 * 60 * 1000;
const MIN_TARGET_MS = 850;
const MAX_TARGET_MS = 1700;

function sign(secret: string, challengeId: string, targetMs: number, issuedAt: number): string {
  return createHmac("sha256", secret).update(`${challengeId}|${targetMs}|${issuedAt}`).digest("hex");
}

export function holdSecret(): string {
  return process.env.HOLD_VERIFY_SECRET || "local-dev-hold-secret";
}

/**
 * Issues a signed "hold to verify" challenge: a randomised target duration plus
 * an HMAC token binding the challenge id, target, and issue time. The token lets
 * the server verify a later submission without storing any challenge state.
 */
export function createHoldChallenge(secret = holdSecret(), now = Date.now(), random = Math.random): HoldChallenge {
  const targetMs = Math.round(MIN_TARGET_MS + random() * (MAX_TARGET_MS - MIN_TARGET_MS));
  const challengeId = randomUUID();
  return {
    challengeId,
    targetMs,
    issuedAt: now,
    token: sign(secret, challengeId, targetMs, now),
  };
}

/**
 * Validates a hold submission against its signed challenge: constant-time token
 * check, freshness window, and confirmation that the user held for close to (and
 * not absurdly longer than) the target. Returns the failure flags, if any.
 */
export function verifyHoldSubmission(
  submission: HoldSubmission | null | undefined,
  secret = holdSecret(),
  now = Date.now(),
): { valid: boolean; flags: string[] } {
  const flags: string[] = [];
  if (!submission) return { valid: false, flags: ["missing_hold"] };
  // heldMs arrives as caller JSON, and NaN is neither too short nor too long — without this
  // an absent duration passes both checks and clears the hold on a replayed token alone.
  const heldMs = Number(submission.heldMs);
  if (
    !submission.challengeId ||
    !submission.token ||
    !submission.issuedAt ||
    !submission.targetMs ||
    !Number.isFinite(heldMs)
  ) {
    return { valid: false, flags: ["bad_hold_payload"] };
  }
  if (now - submission.issuedAt > MAX_AGE_MS || submission.issuedAt - now > 30_000) {
    flags.push("hold_expired");
  }
  const expected = sign(secret, submission.challengeId, submission.targetMs, submission.issuedAt);
  const token = String(submission.token);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(token, "hex");
  // Hex decoding stops at the first bad character, so the length check is what keeps
  // "<signature>x" from decoding to the signature and passing.
  const tokenValid =
    token.length === expected.length &&
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer);
  if (!tokenValid) flags.push("bad_hold_token");
  if (heldMs < Math.max(500, submission.targetMs - 180)) flags.push("hold_too_short");
  if (heldMs > 20_000) flags.push("hold_too_long");
  return { valid: flags.length === 0, flags };
}
