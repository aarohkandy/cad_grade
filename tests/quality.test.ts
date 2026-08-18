import { describe, expect, it } from "vitest";
import { createHoldChallenge } from "../src/server/hold";
import { qualityDecision } from "../src/server/quality";
import type { VotePayload } from "../src/shared/types";

function payload(overrides: Partial<VotePayload> = {}): VotePayload {
  return {
    battle_id: "battle",
    left_item_id: "left",
    right_item_id: "right",
    winner_item_id: "left",
    started_at: "2026-06-12T12:00:00.000Z",
    models_loaded_at: "2026-06-12T12:00:01.000Z",
    voted_at: "2026-06-12T12:00:05.000Z",
    session_id: "session-1234567890",
    ...overrides,
  };
}

function sessionQuality(session: unknown) {
  return qualityDecision({
    payload: { ...payload(), session_id: session },
    holdSubmitted: false,
    holdPassed: false,
    duplicatePair: false,
  });
}

describe("vote quality", () => {
  it("accepts normal human-paced votes without a hold challenge", () => {
    const quality = qualityDecision({
      payload: payload(),
      holdSubmitted: false,
      holdPassed: false,
      duplicatePair: false,
    });

    expect(quality.acceptedForScoring).toBe(true);
    expect(quality.qualityFlags).not.toContain("hold_required");
    expect(quality.qualityFlags).not.toContain("hold_failed");
  });

  it("requires hold verification for very fast votes", () => {
    const quality = qualityDecision({
      payload: payload({ voted_at: "2026-06-12T12:00:00.800Z" }),
      holdSubmitted: false,
      holdPassed: false,
      duplicatePair: false,
    });

    expect(quality.acceptedForScoring).toBe(false);
    expect(quality.qualityFlags).toContain("too_fast");
    expect(quality.qualityFlags).toContain("hold_required");
  });

  it("accepts cached model loads when the vote itself is human-paced", () => {
    const quality = qualityDecision({
      payload: payload({
        models_loaded_at: "2026-06-12T12:00:00.050Z",
        voted_at: "2026-06-12T12:00:02.000Z",
      }),
      holdSubmitted: false,
      holdPassed: false,
      duplicatePair: false,
    });

    expect(quality.acceptedForScoring).toBe(true);
    expect(quality.qualityFlags).not.toContain("models_loaded_too_fast");
    expect(quality.qualityFlags).not.toContain("hold_required");
  });

  it("still rejects an instant vote after a cached model load", () => {
    const quality = qualityDecision({
      payload: payload({
        models_loaded_at: "2026-06-12T12:00:00.050Z",
        voted_at: "2026-06-12T12:00:00.500Z",
      }),
      holdSubmitted: false,
      holdPassed: false,
      duplicatePair: false,
    });

    expect(quality.acceptedForScoring).toBe(false);
    expect(quality.qualityFlags).toContain("models_loaded_too_fast");
    expect(quality.qualityFlags).toContain("vote_after_load_too_fast");
  });

  // A number has no .length, so `session_id.length < 12` was `undefined < 12` — false —
  // and a scraper counting upwards cleared the only anti-abuse check in the arena.
  it("treats a numeric session id as weak", () => {
    for (const session of [12345, 1755500000000]) {
      const quality = sessionQuality(session);

      expect(quality.qualityFlags).toContain("weak_session");
      expect(quality.qualityFlags).toContain("hold_required");
      expect(quality.acceptedForScoring).toBe(false);
    }
  });

  it("treats an object session id as weak", () => {
    const quality = sessionQuality({ id: "session-1234567890" });

    expect(quality.qualityFlags).toContain("weak_session");
    expect(quality.acceptedForScoring).toBe(false);
  });

  it("treats a missing or empty session id as weak", () => {
    for (const session of ["", undefined]) {
      const quality = sessionQuality(session);

      expect(quality.qualityFlags).toContain("weak_session");
      expect(quality.acceptedForScoring).toBe(false);
    }
  });

  it("can accept a fast vote after a valid hold check", () => {
    const hold = createHoldChallenge("secret", 0, () => 0);
    const quality = qualityDecision({
      payload: payload({
        voted_at: "2026-06-12T12:00:00.800Z",
        hold: { ...hold, heldMs: hold.targetMs },
      }),
      holdSubmitted: true,
      holdPassed: true,
      duplicatePair: false,
    });

    expect(quality.acceptedForScoring).toBe(true);
    expect(quality.qualityFlags).toContain("too_fast");
    expect(quality.qualityFlags).not.toContain("hold_required");
    expect(quality.qualityFlags).not.toContain("hold_failed");
  });
});
