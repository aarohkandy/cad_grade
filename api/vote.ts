import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import { expectedScore, initialEloForItem } from "../src/server/elo.js";
import { isVercelRuntime, missingProductionEnv, productionVoteEnvReady } from "../src/server/env.js";
import { safeHash } from "../src/server/hash.js";
import { verifyHoldSubmission } from "../src/server/hold.js";
import { clientIp, methodAllowed, noStore, readJsonBody } from "../src/server/http.js";
import { dataset, itemById } from "../src/server/items.js";
import { pairGroup, pairKey } from "../src/server/pairs.js";
import { qualityDecision } from "../src/server/quality.js";
import {
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
import type { ArenaItem, VotePayload } from "../src/shared/types";

const DIRECT_AGREEMENT_MIN_VOTES = 5;
const DIRECT_AGREEMENT_PRIOR_VOTES = 8;

function winnerWins(pair: StoredPairStat | undefined, winnerId: string): number {
  if (!pair) return 0;
  return winnerId === pair.item_a_id ? pair.item_a_wins : pair.item_b_wins;
}

function boundedPercent(probability: number): number {
  const bounded = Math.max(0.04, Math.min(0.96, probability));
  const percent = Math.round(bounded * 100);
  if (percent === 50) return bounded >= 0.5 ? 51 : 49;
  return percent;
}

function eloAgreementProbability(winnerElo: number, loserElo: number): number {
  return expectedScore(winnerElo, loserElo);
}

function itemElo(item: ArenaItem, value?: number | null): number {
  const elo = Number(value);
  return Number.isFinite(elo) ? elo : initialEloForItem(item);
}

function tieAgreementProbability(leftElo: number, rightElo: number): number {
  const gap = Math.abs(leftElo - rightElo);
  return 0.08 + 0.34 * Math.exp(-gap / 120);
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

function directAgreementPercent(input: {
  pair: StoredPairStat;
  sampleSize: number;
  winner: ArenaItem | null;
  isDraw: boolean;
  priorProbability: number;
}): number {
  const directWins = input.isDraw || !input.winner ? input.pair.draw_count || 0 : winnerWins(input.pair, input.winner.id);
  const smoothedProbability =
    (directWins + input.priorProbability * DIRECT_AGREEMENT_PRIOR_VOTES) /
    (input.sampleSize + DIRECT_AGREEMENT_PRIOR_VOTES);
  return boundedPercent(smoothedProbability);
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
  const agreementPercent =
    hasDirectSignal && input.pair
      ? directAgreementPercent({
          pair: input.pair,
          sampleSize,
          winner: input.winner,
          isDraw: input.isDraw,
          priorProbability,
        })
      : boundedPercent(priorProbability);

  return {
    agreementPercent,
    agreesWithMajority: agreementPercent > 50,
    source: hasDirectSignal ? "direct" : "elo",
    sampleSize,
  } as const;
}

function crowdAgreementLabel(input: ReturnType<typeof crowdEstimate>, isDraw: boolean): string {
  const action = isDraw ? "call it a tie" : "pick the same model";
  const source = input.source === "direct"
    ? `from ${input.sampleSize} prior ${input.sampleSize === 1 ? "vote" : "votes"}`
    : "rating estimate";
  return `${input.agreementPercent}% would ${action} (${source}).`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["POST"])) return;

  try {
    const payload = readJsonBody<VotePayload>(req);
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
    const hold = holdSubmitted ? verifyHoldSubmission(payload.hold) : { valid: false, flags: [] };
    const sessionHash = safeHash(payload.session_id || "missing-session");
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
      session_id: payload.session_id,
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
    if (!duplicatePair) {
      await markSessionPair(markerPath, {
        created_at: createdAt,
        session_hash: sessionHash,
        family,
        pair_key: pairKey(left.id, right.id),
        vote_id: id,
      });
    }

    let summary = await readVoteSummary(dataset.datasetId, dataset.families);
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
      summary = await updateVoteSummary(dataset.datasetId, dataset.families, record, left, right, winner, loser);
    } catch (error) {
      console.error(error);
    }

    res.status(200).json({
      saved: true,
      acceptedForScoring: quality.acceptedForScoring,
      agreementPercent: priorCrowd.agreementPercent,
      agreementLabel: crowdAgreementLabel(priorCrowd, isDraw),
      crowd: priorCrowd,
      dataMode: mode === "blob" ? "live" : "local",
      qualityFlags,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "vote_failed";
    res.status(500).json({ error: "vote_failed", message });
  }
}
