import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { agreementPercent, updateElo } from "../src/server/elo";
import { safeHash } from "../src/server/hash";
import { verifyHoldSubmission } from "../src/server/hold";
import { clientIp, methodAllowed, noStore, readJsonBody } from "../src/server/http";
import { itemById } from "../src/server/items";
import { pairKey } from "../src/server/pairs";
import { qualityDecision } from "../src/server/quality";
import { getSupabase } from "../src/server/supabase";
import type { ArenaItem, VotePayload } from "../src/shared/types";

interface DbItemStat {
  item_id: string;
  family: string;
  elo: number;
  wins: number;
  losses: number;
  battle_count: number;
  updated_at?: string;
}

interface DbPairStat {
  pair_key: string;
  family: string;
  item_a_id: string;
  item_b_id: string;
  item_a_wins: number;
  item_b_wins: number;
  battle_count: number;
  updated_at?: string;
}

function defaultItemStat(item: ArenaItem): DbItemStat {
  return {
    item_id: item.id,
    family: item.family,
    elo: 1200,
    wins: 0,
    losses: 0,
    battle_count: 0,
  };
}

async function sessionAlreadyVotedPair(
  supabase: SupabaseClient,
  sessionId: string,
  family: string,
  leftId: string,
  rightId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  const key = pairKey(leftId, rightId);
  const { data, error } = await supabase
    .from("votes")
    .select("left_item_id,right_item_id")
    .eq("session_id", sessionId)
    .eq("family", family)
    .limit(2000);
  if (error) throw error;
  return ((data || []) as Array<{ left_item_id: string; right_item_id: string }>).some(
    (vote) => pairKey(vote.left_item_id, vote.right_item_id) === key,
  );
}

async function ensureItemStats(
  supabase: SupabaseClient,
  winner: ArenaItem,
  loser: ArenaItem,
): Promise<Map<string, DbItemStat>> {
  const ids = [winner.id, loser.id];
  const { data, error } = await supabase.from("item_stats").select("*").in("item_id", ids);
  if (error) throw error;
  const stats = new Map<string, DbItemStat>();
  for (const row of (data || []) as DbItemStat[]) stats.set(row.item_id, row);
  const missing = [winner, loser].filter((item) => !stats.has(item.id));
  if (missing.length) {
    const rows = missing.map(defaultItemStat);
    const { error: upsertError } = await supabase.from("item_stats").upsert(rows, { onConflict: "item_id" });
    if (upsertError) throw upsertError;
    for (const row of rows) stats.set(row.item_id, row);
  }
  return stats;
}

async function pairStat(supabase: SupabaseClient, family: string, leftId: string, rightId: string): Promise<DbPairStat> {
  const key = pairKey(leftId, rightId);
  const sorted = [leftId, rightId].sort();
  const { data, error } = await supabase.from("pair_stats").select("*").eq("pair_key", key).maybeSingle();
  if (error) throw error;
  return (
    (data as DbPairStat | null) || {
      pair_key: key,
      family,
      item_a_id: sorted[0],
      item_b_id: sorted[1],
      item_a_wins: 0,
      item_b_wins: 0,
      battle_count: 0,
    }
  );
}

function winnerWins(pair: DbPairStat, winnerId: string): number {
  return winnerId === pair.item_a_id ? pair.item_a_wins : pair.item_b_wins;
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
    const loser = winner.id === left.id ? right : left;
    const family = left.family;
    const hold = verifyHoldSubmission(payload.hold);
    const supabase = getSupabase();

    if (!supabase) {
      res.status(200).json({
        saved: false,
        acceptedForScoring: false,
        agreementPercent: 50,
        agreementLabel: "Demo mode: set Supabase env vars to save votes.",
        dataMode: "demo",
        qualityFlags: ["supabase_not_configured"],
      });
      return;
    }

    const duplicatePair = await sessionAlreadyVotedPair(
      supabase,
      payload.session_id,
      family,
      left.id,
      right.id,
    );
    const quality = qualityDecision({
      payload,
      holdPassed: hold.valid,
      duplicatePair,
    });
    const qualityFlags = [...new Set([...hold.flags, ...quality.qualityFlags])];
    const ipHash = safeHash(clientIp(req));
    const userAgentHash = safeHash(String(req.headers["user-agent"] || "unknown"));

    const { error: insertError } = await supabase.from("votes").insert({
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
    });
    if (insertError) throw insertError;

    const stats = await ensureItemStats(supabase, winner, loser);
    const beforeWinner = stats.get(winner.id) || defaultItemStat(winner);
    const beforeLoser = stats.get(loser.id) || defaultItemStat(loser);
    let currentPair = await pairStat(supabase, family, left.id, right.id);
    let winnerElo = beforeWinner.elo;
    let loserElo = beforeLoser.elo;

    if (quality.acceptedForScoring) {
      const updated = updateElo(beforeWinner, beforeLoser);
      winnerElo = updated.winnerElo;
      loserElo = updated.loserElo;
      const now = new Date().toISOString();
      const updatedWinner: DbItemStat = {
        ...beforeWinner,
        elo: winnerElo,
        wins: beforeWinner.wins + 1,
        battle_count: beforeWinner.battle_count + 1,
        updated_at: now,
      };
      const updatedLoser: DbItemStat = {
        ...beforeLoser,
        elo: loserElo,
        losses: beforeLoser.losses + 1,
        battle_count: beforeLoser.battle_count + 1,
        updated_at: now,
      };
      const { error: itemError } = await supabase
        .from("item_stats")
        .upsert([updatedWinner, updatedLoser], { onConflict: "item_id" });
      if (itemError) throw itemError;

      currentPair = {
        ...currentPair,
        item_a_wins: currentPair.item_a_wins + (winner.id === currentPair.item_a_id ? 1 : 0),
        item_b_wins: currentPair.item_b_wins + (winner.id === currentPair.item_b_id ? 1 : 0),
        battle_count: currentPair.battle_count + 1,
        updated_at: now,
      };
      const { error: pairError } = await supabase
        .from("pair_stats")
        .upsert(currentPair, { onConflict: "pair_key" });
      if (pairError) throw pairError;
    }

    const percent = agreementPercent({
      winnerWins: winnerWins(currentPair, winner.id),
      battleCount: currentPair.battle_count,
      winnerElo,
      loserElo,
    });

    res.status(200).json({
      saved: true,
      acceptedForScoring: quality.acceptedForScoring,
      agreementPercent: percent,
      agreementLabel: `${percent}% of the arena is with you on this one.`,
      dataMode: "live",
      qualityFlags,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "vote_failed";
    res.status(500).json({ error: "vote_failed", message });
  }
}
