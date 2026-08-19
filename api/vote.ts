import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import {
  boundedPercent,
  directAgreementProbability,
  eloAgreementProbability,
  initialEloForItem,
  tieAgreementProbability,
} from "../src/server/elo.js";
import { isVercelRuntime, missingProductionEnv, productionVoteEnvReady } from "../src/server/env.js";
import { safeHash } from "../src/server/hash.js";
import { holdSecret, verifyHoldSubmission } from "../src/server/hold.js";
import { JsonBodyError, clientIp, methodAllowed, noStore, readJsonBody } from "../src/server/http.js";
import { dataset, itemById } from "../src/server/items.js";
import { pairGroup, pairKey } from "../src/server/pairs.js";
import { qualityDecision } from "../src/server/quality.js";
import {
  emptySummary,
  markSessionPair,
  readVoteSummary,
  sessionPairAlreadySeen,
  sessionPairPath,
  storageMode,
  updateVoteSummary,
  votePath,
  writeVoteRecord,
  type StoredPairStat,
  type StoredVoteRecord,
} from "../src/server/voteStore.js";
import type { ArenaItem, HoldSubmission } from "../src/shared/types";

const DIRECT_AGREEMENT_MIN_VOTES = 5;
const DIRECT_AGREEMENT_HIGH_CONFIDENCE_VOTES = 15;
// The longest string the arena issues is a battle_id: "battle_", two item ids, a uuid.
const MAX_FIELD_LENGTH = 300;

interface CheckedVotePayload {
  battle_id: string;
  left_item_id: string;
  right_item_id: string;
  winner_item_id: unknown;
  vote_result: unknown;
  started_at: string;
  models_loaded_at: string;
  voted_at: string;
  // Left as it arrived. qualityDecision has to tell a session id from a number pretending
  // to be one, and String(Date.now()) is thirteen characters — past the twelve-char bar.
  session_id: unknown;
  hold: HoldSubmission | null;
}

type PayloadCheck = { ok: true; payload: CheckedVotePayload; sessionId: string } | { ok: false; error: string };

function boundedText(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return null;
  const text = String(value);
  return text.length > MAX_FIELD_LENGTH ? null : text;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// A hold whose numbers are not numbers is not a hold: verifyHoldSubmission compares heldMs
// against the target, and `"abc" < 900` is false, so junk cleared the challenge. A scalar
// reads as no hold at all; only a shape claiming to be a submission gets the zeroed one.
function checkedHold(value: unknown): HoldSubmission | null {
  if (value === null || typeof value !== "object") return null;
  const malformed: HoldSubmission = { challengeId: "", targetMs: 0, issuedAt: 0, heldMs: 0, token: "" };
  const hold = value as Record<string, unknown>;
  const challengeId = boundedText(hold.challengeId);
  const token = boundedText(hold.token);
  const targetMs = finiteNumber(hold.targetMs);
  const issuedAt = finiteNumber(hold.issuedAt);
  const heldMs = finiteNumber(hold.heldMs);
  if (!challengeId || !token || targetMs === null || issuedAt === null || heldMs === null) return malformed;
  return { challengeId, targetMs, issuedAt, heldMs, token };
}

// VotePayload describes what the arena's own client sends, not what arrives. Over-long
// values are refused rather than truncated: a stored battle_id should be one the arena
// could have issued, and a truncated one is a fabricated one.
function checkVotePayload(body: unknown): PayloadCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_payload" };
  const raw = body as Record<string, unknown>;
  const battleId = boundedText(raw.battle_id);
  const leftItemId = boundedText(raw.left_item_id);
  const rightItemId = boundedText(raw.right_item_id);
  const startedAt = boundedText(raw.started_at);
  const modelsLoadedAt = boundedText(raw.models_loaded_at);
  const votedAt = boundedText(raw.voted_at);
  const sessionId = boundedText(raw.session_id);
  if (
    battleId === null ||
    leftItemId === null ||
    rightItemId === null ||
    startedAt === null ||
    modelsLoadedAt === null ||
    votedAt === null ||
    sessionId === null
  ) {
    return { ok: false, error: "invalid_payload" };
  }

  return {
    ok: true,
    sessionId,
    payload: {
      battle_id: battleId,
      left_item_id: leftItemId,
      right_item_id: rightItemId,
      winner_item_id: raw.winner_item_id,
      vote_result: raw.vote_result,
      started_at: startedAt,
      models_loaded_at: modelsLoadedAt,
      voted_at: votedAt,
      session_id: raw.session_id,
      hold: checkedHold(raw.hold),
    },
  };
}

function itemElo(item: ArenaItem, value?: number | null): number {
  const elo = Number(value);
  return Number.isFinite(elo) ? elo : initialEloForItem(item);
}

function directWinCount(pair: StoredPairStat, winner: ArenaItem | null, isDraw: boolean): number {
  if (isDraw || !winner) return pair.draw_count || 0;
  return winner.id === pair.item_a_id ? pair.item_a_wins : pair.item_b_wins;
}

function eloPriorProbability(input: {
  isDraw: boolean;
  leftElo: number;
  rightElo: number;
  winnerElo: number | null;
  loserElo: number | null;
}): number {
  if (input.isDraw || input.winnerElo === null || input.loserElo === null) {
    return tieAgreementProbability(input.leftElo, input.rightElo);
  }
  return eloAgreementProbability(input.winnerElo, input.loserElo);
}

function crowdConfidence(source: "direct" | "elo", sampleSize: number): "low" | "medium" | "high" {
  if (source === "elo") return "low";
  return sampleSize >= DIRECT_AGREEMENT_HIGH_CONFIDENCE_VOTES ? "high" : "medium";
}

function crowdEstimate(input: {
  pair: StoredPairStat | undefined;
  left: ArenaItem;
  right: ArenaItem;
  winner: ArenaItem | null;
  loser: ArenaItem | null;
  isDraw: boolean;
  leftElo?: number | null;
  rightElo?: number | null;
  winnerElo?: number | null;
  loserElo?: number | null;
}) {
  const sampleSize = input.pair?.battle_count || 0;
  const hasDirectSignal = sampleSize >= DIRECT_AGREEMENT_MIN_VOTES;
  const leftElo = itemElo(input.left, input.leftElo);
  const rightElo = itemElo(input.right, input.rightElo);
  const winnerElo = input.winner ? itemElo(input.winner, input.winnerElo) : null;
  const loserElo = input.loser ? itemElo(input.loser, input.loserElo) : null;
  const priorProbability = eloPriorProbability({
    isDraw: input.isDraw,
    leftElo,
    rightElo,
    winnerElo,
    loserElo,
  });
  const source = hasDirectSignal ? "direct" : "elo";
  const agreementProbability =
    hasDirectSignal && input.pair
      ? directAgreementProbability({
          directWins: directWinCount(input.pair, input.winner, input.isDraw),
          sampleSize,
          priorProbability,
        })
      : priorProbability;
  const agreementPercent = boundedPercent(agreementProbability);

  return {
    agreementPercent,
    agreesWithMajority: agreementProbability > 0.5,
    source,
    confidence: crowdConfidence(source, sampleSize),
    sampleSize,
  } as const;
}

function crowdAgreementLabel(input: ReturnType<typeof crowdEstimate>, isDraw: boolean): string {
  const action = isDraw ? "call it a tie" : "pick the same model";
  const source =
    input.confidence === "high" ? "crowd read" : input.source === "direct" ? "early crowd read" : "rating estimate";
  return `${input.agreementPercent}% would ${action} (${source}).`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["POST"])) return;

  try {
    const checked = checkVotePayload(readJsonBody<unknown>(req));
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const payload = checked.payload;
    const left = itemById(payload.left_item_id);
    const right = itemById(payload.right_item_id);
    const isDraw = payload.vote_result === "draw" || payload.winner_item_id === null;
    const winner: ArenaItem | null = isDraw ? null : itemById(String(payload.winner_item_id || "")) || null;
    if (!left || !right || (!isDraw && (!winner || (winner.id !== left.id && winner.id !== right.id)))) {
      res.status(400).json({ error: "invalid_items" });
      return;
    }
    const mode = storageMode();
    if (mode === "unconfigured") {
      res.status(503).json({ error: "vote_storage_not_configured" });
      return;
    }
    if (isVercelRuntime() && !productionVoteEnvReady()) {
      res.status(503).json({
        error: "production_env_not_configured",
        missingEnv: missingProductionEnv(),
      });
      return;
    }

    const loser = winner ? (winner.id === left.id ? right : left) : null;
    const family = pairGroup(left, right);
    const holdSubmitted = Boolean(payload.hold);
    const hold = holdSubmitted
      ? verifyHoldSubmission(payload.hold, holdSecret(), Date.now(), payload.battle_id)
      : { valid: false, flags: [] };
    const sessionHash = safeHash(checked.sessionId || "missing-session");
    const markerPath = sessionPairPath(sessionHash, family, left.id, right.id);
    const duplicatePair = await sessionPairAlreadySeen(markerPath);
    const quality = qualityDecision({
      payload,
      holdSubmitted,
      holdPassed: hold.valid,
      duplicatePair,
    });
    const qualityFlags = [...new Set([...hold.flags, ...quality.qualityFlags])];
    const ipHash = safeHash(clientIp(req));
    const userAgentHash = safeHash(String(req.headers["user-agent"] || "unknown"));
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const path = votePath(createdAt, id);

    const record: StoredVoteRecord = {
      id,
      created_at: createdAt,
      dataset_id: dataset.datasetId,
      battle_id: payload.battle_id,
      family,
      left_item_id: left.id,
      right_item_id: right.id,
      winner_item_id: winner?.id || null,
      loser_item_id: loser?.id || null,
      vote_result: isDraw ? "draw" : "winner",
      session_id: checked.sessionId,
      started_at: payload.started_at,
      models_loaded_at: payload.models_loaded_at,
      voted_at: payload.voted_at,
      elapsed_ms: quality.elapsedMs,
      load_ms: quality.loadMs,
      hold_duration_ms: payload.hold?.heldMs ?? null,
      hold_target_ms: payload.hold?.targetMs ?? null,
      hold_passed: hold.valid,
      duplicate_pair: duplicatePair,
      too_fast: quality.tooFast,
      accepted_for_scoring: quality.acceptedForScoring,
      quality_flags: qualityFlags,
      ip_hash: ipHash,
      user_agent_hash: userAgentHash,
      raw_payload: {
        battle_id: payload.battle_id,
        left_item_id: left.id,
        right_item_id: right.id,
        winner_item_id: winner?.id || null,
        loser_item_id: loser?.id || null,
        vote_result: isDraw ? "draw" : "winner",
      },
      storage: {
        mode,
        path,
      },
    };

    await writeVoteRecord(record);

    // Nothing below here may 500: the blob is already written, and telling the voter it
    // failed makes them vote again, which stores the same preference twice.
    let summaryUpdated = true;
    if (!duplicatePair) {
      try {
        await markSessionPair(markerPath, {
          created_at: createdAt,
          session_hash: sessionHash,
          family,
          pair_key: pairKey(left.id, right.id),
          vote_id: id,
        });
      } catch (error) {
        console.error("vote: session pair marker failed after writing vote", record.id, error);
      }
    }

    let summary = emptySummary(dataset.datasetId, dataset.families);
    try {
      summary = await readVoteSummary(dataset.datasetId, dataset.families);
    } catch (error) {
      console.error("vote: summary read failed after writing vote", record.id, error);
      summaryUpdated = false;
    }
    const priorPair = summary.pairStats[pairKey(left.id, right.id)];
    const priorCrowd = crowdEstimate({
      pair: priorPair,
      left,
      right,
      winner,
      loser,
      isDraw,
      leftElo: summary.itemStats[left.id]?.elo,
      rightElo: summary.itemStats[right.id]?.elo,
      winnerElo: winner ? summary.itemStats[winner.id]?.elo : null,
      loserElo: loser ? summary.itemStats[loser.id]?.elo : null,
    });
    try {
      await updateVoteSummary(dataset.datasetId, dataset.families, record, left, right, winner, loser);
    } catch (error) {
      console.error("vote: summary update failed after writing vote", record.id, error);
      summaryUpdated = false;
    }

    res.status(200).json({
      saved: true,
      summaryUpdated,
      acceptedForScoring: quality.acceptedForScoring,
      agreementPercent: priorCrowd.agreementPercent,
      agreementLabel: crowdAgreementLabel(priorCrowd, isDraw),
      crowd: priorCrowd,
      dataMode: mode === "blob" ? "live" : "local",
      qualityFlags,
    });
  } catch (error) {
    if (error instanceof JsonBodyError) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    console.error("vote: request failed", error);
    res.status(500).json({ error: "vote_failed" });
  }
}
