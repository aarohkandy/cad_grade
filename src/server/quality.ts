import type { VotePayload } from "../shared/types";

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function voteTiming(payload: VotePayload): { elapsedMs: number | null; loadMs: number | null } {
  const started = timestampMs(payload.started_at);
  const loaded = timestampMs(payload.models_loaded_at);
  const voted = timestampMs(payload.voted_at);
  return {
    elapsedMs: started !== null && voted !== null ? Math.max(0, voted - started) : null,
    loadMs: started !== null && loaded !== null ? Math.max(0, loaded - started) : null,
  };
}

export function qualityDecision(input: {
  payload: VotePayload;
  holdPassed: boolean;
  duplicatePair: boolean;
}): {
  elapsedMs: number | null;
  loadMs: number | null;
  tooFast: boolean;
  qualityFlags: string[];
  acceptedForScoring: boolean;
} {
  const { elapsedMs, loadMs } = voteTiming(input.payload);
  const qualityFlags: string[] = [];
  const tooFast = elapsedMs !== null && elapsedMs < 2500;
  if (tooFast) qualityFlags.push("too_fast");
  if (loadMs !== null && loadMs < 350) qualityFlags.push("models_loaded_too_fast");
  if (!input.holdPassed) qualityFlags.push("hold_failed");
  if (input.duplicatePair) qualityFlags.push("duplicate_pair");
  if (!input.payload.session_id || input.payload.session_id.length < 12) qualityFlags.push("weak_session");
  return {
    elapsedMs,
    loadMs,
    tooFast,
    qualityFlags,
    acceptedForScoring:
      input.holdPassed &&
      !input.duplicatePair &&
      !tooFast &&
      !qualityFlags.includes("weak_session"),
  };
}
