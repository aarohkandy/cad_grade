import type { VotePayload } from "../shared/types";

const FAST_VOTE_MS = 1200;
const FAST_LOAD_MS = 300;
const FAST_AFTER_LOAD_MS = 900;

type QualityPayload = Pick<VotePayload, "started_at" | "models_loaded_at" | "voted_at" | "session_id">;

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function voteTiming(payload: QualityPayload): { elapsedMs: number | null; loadMs: number | null } {
  const started = timestampMs(payload.started_at);
  const loaded = timestampMs(payload.models_loaded_at);
  const voted = timestampMs(payload.voted_at);
  return {
    elapsedMs: started !== null && voted !== null ? Math.max(0, voted - started) : null,
    loadMs: started !== null && loaded !== null ? Math.max(0, loaded - started) : null,
  };
}

/**
 * Classifies a vote's timing and session signals into quality flags and decides
 * whether it counts toward scoring. Too-fast votes are rejected unless the user
 * cleared the hold challenge; duplicate-pair and weak-session votes never count.
 */
export function qualityDecision(input: {
  payload: QualityPayload;
  holdSubmitted: boolean;
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
  const loaded = timestampMs(input.payload.models_loaded_at);
  const voted = timestampMs(input.payload.voted_at);
  const voteAfterLoadMs = loaded !== null && voted !== null ? Math.max(0, voted - loaded) : null;
  const qualityFlags: string[] = [];
  const tooFast = elapsedMs !== null && elapsedMs < FAST_VOTE_MS;
  const modelsLoadedTooFast =
    loadMs !== null && loadMs < FAST_LOAD_MS && (voteAfterLoadMs === null || voteAfterLoadMs < FAST_AFTER_LOAD_MS);
  const votedAfterLoadTooFast = voteAfterLoadMs !== null && voteAfterLoadMs < FAST_AFTER_LOAD_MS;
  const weakSession = !input.payload.session_id || input.payload.session_id.length < 12;
  const holdRequired = tooFast || modelsLoadedTooFast || votedAfterLoadTooFast || weakSession;
  if (tooFast) qualityFlags.push("too_fast");
  if (modelsLoadedTooFast) qualityFlags.push("models_loaded_too_fast");
  if (votedAfterLoadTooFast) qualityFlags.push("vote_after_load_too_fast");
  if (holdRequired && !input.holdSubmitted) qualityFlags.push("hold_required");
  if (input.holdSubmitted && !input.holdPassed) qualityFlags.push("hold_failed");
  if (input.duplicatePair) qualityFlags.push("duplicate_pair");
  if (weakSession) qualityFlags.push("weak_session");
  return {
    elapsedMs,
    loadMs,
    tooFast,
    qualityFlags,
    acceptedForScoring:
      ((!tooFast && !modelsLoadedTooFast && !votedAfterLoadTooFast) || input.holdPassed) &&
      !input.duplicatePair &&
      !weakSession &&
      !(input.holdSubmitted && !input.holdPassed),
  };
}

export function acceptedForCurrentScoring(
  vote: QualityPayload & {
    duplicate_pair?: boolean | null;
    hold_duration_ms?: number | null;
    hold_passed?: boolean | null;
  },
): boolean {
  return qualityDecision({
    payload: vote,
    holdSubmitted: vote.hold_duration_ms !== null && vote.hold_duration_ms !== undefined,
    holdPassed: Boolean(vote.hold_passed),
    duplicatePair: Boolean(vote.duplicate_pair),
  }).acceptedForScoring;
}
