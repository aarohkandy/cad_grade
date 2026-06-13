import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import { agreementPercent } from "../src/server/elo";
import { safeHash } from "../src/server/hash";
import { verifyHoldSubmission } from "../src/server/hold";
import { clientIp, methodAllowed, noStore, readJsonBody } from "../src/server/http";
import { dataset, itemById } from "../src/server/items";
import { pairKey } from "../src/server/pairs";
import { qualityDecision } from "../src/server/quality";
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
} from "../src/server/voteStore";
import type { ArenaItem, VotePayload } from "../src/shared/types";

function winnerWins(pair: StoredPairStat | undefined, winnerId: string): number {
  if (!pair) return 0;
  return winnerId === pair.item_a_id ? pair.item_a_wins : pair.item_b_wins;
}

function publicAgreement(input: {
  pair: StoredPairStat | undefined;
  winner: ArenaItem;
  loser: ArenaItem;
  winnerElo?: number | null;
  loserElo?: number | null;
}): number {
  return agreementPercent({
    winnerWins: winnerWins(input.pair, input.winner.id),
    battleCount: input.pair?.battle_count || 0,
    winnerElo: input.winnerElo,
    loserElo: input.loserElo,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["POST"])) return;

  try {
    const payload = readJsonBody<VotePayload>(req);
    const left = itemById(payload.left_item_id);
    const right = itemById(payload.right_item_id);
    const winner = itemById(payload.winner_item_id);
    if (!left || !right || !winner || (winner.id !== left.id && winner.id !== right.id)) {
      res.status(400).json({ error: "invalid_items" });
      return;
    }
    if (left.family !== right.family || winner.family !== left.family) {
      res.status(400).json({ error: "cross_family_vote" });
      return;
    }

    const mode = storageMode();
    if (mode === "unconfigured") {
      res.status(503).json({ error: "vote_storage_not_configured" });
      return;
    }

    const loser = winner.id === left.id ? right : left;
    const family = left.family;
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
      winner_item_id: winner.id,
      loser_item_id: loser.id,
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
        winner_item_id: winner.id,
        loser_item_id: loser.id,
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
    try {
      summary = await updateVoteSummary(dataset.datasetId, dataset.families, record, winner, loser);
    } catch (error) {
      console.error(error);
    }

    const pair = summary.pairStats[pairKey(left.id, right.id)];
    const percent = publicAgreement({
      pair,
      winner,
      loser,
      winnerElo: summary.itemStats[winner.id]?.elo,
      loserElo: summary.itemStats[loser.id]?.elo,
    });

    res.status(200).json({
      saved: true,
      acceptedForScoring: quality.acceptedForScoring,
      agreementPercent: percent,
      agreementLabel: `${percent}% of the arena is with you on this one.`,
      dataMode: mode === "blob" ? "live" : "local",
      qualityFlags,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "vote_failed";
    res.status(500).json({ error: "vote_failed", message });
  }
}
