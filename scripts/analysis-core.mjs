import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const TEST_SESSION_PREFIXES = ["production-check-", "production-browser-check-"];

const DEFAULT_ELO = 1200;
const DEFAULT_K = 28;
const ELO_DECAY_PRIOR_BATTLES = 10;
const ELO_MIN_VOTE_WEIGHT = 0.16;
const FAST_VOTE_MS = 1200;
const FAST_LOAD_MS = 300;
const FAST_AFTER_LOAD_MS = 900;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(value) {
  return Math.round(finiteNumber(value) * 1000) / 10;
}

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function voteTiming(vote) {
  const started = timestampMs(vote.started_at);
  const loaded = timestampMs(vote.models_loaded_at);
  const voted = timestampMs(vote.voted_at);
  return {
    elapsedMs: started !== null && voted !== null ? Math.max(0, voted - started) : finiteNumber(vote.elapsed_ms, null) ?? null,
    loadMs: started !== null && loaded !== null ? Math.max(0, loaded - started) : finiteNumber(vote.load_ms, null) ?? null,
    voteAfterLoadMs: loaded !== null && voted !== null ? Math.max(0, voted - loaded) : null,
  };
}

function hourKey(value) {
  const ms = timestampMs(value);
  return ms === null ? "unknown" : new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}

function dayKey(value) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "unknown";
}

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function expectedScore(playerElo, opponentElo) {
  return 1 / (1 + 10 ** ((opponentElo - playerElo) / 400));
}

function stableUnit(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function initialEloForItem(item) {
  const confidence = Number(item.validation?.confidence);
  const attempt = Number(item.validation?.attempt_count);
  const issueCount = item.validation?.issues?.length || 0;
  const level = Number(item.specificityLevel);
  const latency = Number(item.latencyMs);
  const title = String(item.title || "").toLowerCase();
  const jitter = stableUnit(`${item.id}:${item.sourceHash}`);

  let elo = DEFAULT_ELO;
  elo += item.validation?.valid === false ? -90 : 10;
  if (Number.isFinite(confidence)) elo += (confidence - 0.85) * 36;
  elo -= issueCount * 8;
  if (Number.isFinite(attempt) && attempt > 0) elo += Math.max(-18, 8 - (attempt - 1) * 7);
  if (Number.isFinite(level)) elo += (level - 5) * 2.2;
  elo -= Math.min(6, Math.max(0, item.repetition || 0) * 1.5);
  if (Number.isFinite(latency)) elo += Math.max(-9, Math.min(7, (70_000 - latency) / 10_000));
  if (title.includes("full")) elo += 14;
  else if (title.includes("dimensions")) elo += 9;
  else if (title.includes("printable")) elo += 5;
  else if (title.includes("clear")) elo += 2;
  else if (title.includes("minimal")) elo -= 3;
  elo += (jitter - 0.5) * 18;

  return Math.round(elo * 1000) / 1000;
}

function updateElo(winnerElo, loserElo, weight = 1) {
  const expectedWinner = expectedScore(winnerElo, loserElo);
  const delta = DEFAULT_K * Math.max(0, Math.min(1, weight)) * (1 - expectedWinner);
  return {
    winner: Math.round((winnerElo + delta) * 1000) / 1000,
    loser: Math.round((loserElo - delta) * 1000) / 1000,
  };
}

function eloVoteWeight(left, right) {
  const leftBattles = Math.max(0, finiteNumber(left?.battles, 0));
  const rightBattles = Math.max(0, finiteNumber(right?.battles, 0));
  const averageBattles = (leftBattles + rightBattles) / 2;
  const raw = ELO_DECAY_PRIOR_BATTLES / (ELO_DECAY_PRIOR_BATTLES + averageBattles);
  return Math.max(ELO_MIN_VOTE_WEIGHT, Math.min(1, raw));
}

export function pairKey(leftId, rightId) {
  return [leftId, rightId].sort().join("__");
}

export function isTestVote(vote) {
  return TEST_SESSION_PREFIXES.some((prefix) => String(vote?.session_id || "").startsWith(prefix));
}

function isTrustedLocalVote(vote) {
  return vote?.storage?.mode === "local";
}

function currentQuality(vote) {
  const { elapsedMs, loadMs, voteAfterLoadMs } = voteTiming(vote);
  const tooFast = elapsedMs !== null && elapsedMs < FAST_VOTE_MS;
  const votedAfterLoadTooFast = voteAfterLoadMs !== null && voteAfterLoadMs < FAST_AFTER_LOAD_MS;
  const modelsLoadedTooFast =
    loadMs !== null &&
    loadMs < FAST_LOAD_MS &&
    (voteAfterLoadMs === null || votedAfterLoadTooFast);
  const weakSession = !vote.session_id || String(vote.session_id).length < 12;
  const duplicatePair = Boolean(vote.duplicate_pair);
  const holdSubmitted = vote.hold_duration_ms !== null && vote.hold_duration_ms !== undefined;
  const holdPassed = Boolean(vote.hold_passed);
  const holdRequired = tooFast || modelsLoadedTooFast || votedAfterLoadTooFast || weakSession;
  const flags = [];
  if (tooFast) flags.push("too_fast");
  if (modelsLoadedTooFast) flags.push("models_loaded_too_fast");
  if (votedAfterLoadTooFast) flags.push("vote_after_load_too_fast");
  if (holdRequired && !holdSubmitted) flags.push("hold_required");
  if (holdSubmitted && !holdPassed) flags.push("hold_failed");
  if (duplicatePair) flags.push("duplicate_pair");
  if (weakSession) flags.push("weak_session");
  const trustedLocal = isTrustedLocalVote(vote);
  return {
    flags,
    tooFast,
    duplicatePair,
    trustedLocal,
    acceptedForScoring:
      (trustedLocal || (!tooFast && !modelsLoadedTooFast && !votedAfterLoadTooFast) || holdPassed) &&
      !duplicatePair &&
      !weakSession &&
      !(holdSubmitted && !holdPassed),
  };
}

function isCleanVote(vote) {
  return currentQuality(vote).acceptedForScoring && !isTestVote(vote);
}

export function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => escape(row[header])).join(",")).join("\n")}\n`;
}

export async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function walkFiles(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) return walkFiles(fullPath);
      return [fullPath];
    }),
  );
  return nested.flat();
}

export async function loadVotesFromBackupRoot(root) {
  const dailyRoot = join(root, "daily");
  const dailyFiles = (await walkFiles(dailyRoot)).filter((path) => basename(path).match(/^votes-\d{4}-\d{2}-\d{2}\.jsonl$/));
  const sourceFiles = dailyFiles.length ? dailyFiles : (await walkFiles(root)).filter((path) => basename(path) === "votes.jsonl");
  const seen = new Set();
  const votes = [];
  for (const file of sourceFiles.sort()) {
    for (const vote of await readJsonl(file)) {
      const key = vote.id || vote.storage?.path || JSON.stringify(vote.raw_payload || vote);
      if (seen.has(key)) continue;
      seen.add(key);
      votes.push(vote);
    }
  }
  return votes.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

function activeItems(dataset) {
  return (dataset.items || []).filter((item) => item.active !== false);
}

function pairGroup(left, right) {
  return left.family === right.family ? left.family : "mixed";
}

function allDatasetPairs(dataset) {
  const pairs = [];
  const items = activeItems(dataset);
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      pairs.push({
        family: pairGroup(items[left], items[right]),
        item_a_id: items[left].id,
        item_a_family: items[left].family,
        item_b_id: items[right].id,
        item_b_family: items[right].family,
        pair_key: pairKey(items[left].id, items[right].id),
      });
    }
  }
  return pairs;
}

function initItemStats(dataset) {
  return new Map(
    activeItems(dataset).map((item) => [
      item.id,
      {
        item_id: item.id,
        family: item.family,
        title: item.title,
        seed_id: item.seedId,
        wins: 0,
        losses: 0,
        draws: 0,
        battles: 0,
        elo: initialEloForItem(item),
      },
    ]),
  );
}

function initPairStats(dataset) {
  return new Map(
    allDatasetPairs(dataset).map((pair) => [
      pair.pair_key,
      {
        ...pair,
        item_a_wins: 0,
        item_b_wins: 0,
        draws: 0,
        battles: 0,
      },
    ]),
  );
}

function rankingRows(votes, dataset, label) {
  const items = initItemStats(dataset);
  const pairs = initPairStats(dataset);

  for (const vote of [...votes].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))) {
    const left = items.get(vote.left_item_id);
    const right = items.get(vote.right_item_id);
    if (!left || !right) continue;
    const key = pairKey(left.item_id, right.item_id);
    const pair = pairs.get(key);

    if (vote.vote_result === "draw" || !vote.winner_item_id) {
      left.battles += 1;
      right.battles += 1;
      if (pair) pair.battles += 1;
      left.draws += 1;
      right.draws += 1;
      if (pair) pair.draws += 1;
      continue;
    }

    const winner = items.get(vote.winner_item_id);
    const loserId = vote.loser_item_id || (vote.winner_item_id === left.item_id ? right.item_id : left.item_id);
    const loser = items.get(loserId);
    if (!winner || !loser) continue;

    winner.wins += 1;
    loser.losses += 1;
    const elo = updateElo(winner.elo, loser.elo, eloVoteWeight(winner, loser));
    winner.elo = elo.winner;
    loser.elo = elo.loser;
    left.battles += 1;
    right.battles += 1;
    if (pair) pair.battles += 1;
    if (pair) {
      if (winner.item_id === pair.item_a_id) pair.item_a_wins += 1;
      if (winner.item_id === pair.item_b_id) pair.item_b_wins += 1;
    }
  }

  const rows = [...items.values()].map((row) => ({
    ranking_set: label,
    item_id: row.item_id,
    family: row.family,
    title: row.title,
    seed_id: row.seed_id,
    battles: row.battles,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    win_rate: row.battles ? row.wins / row.battles : 0,
    draw_rate: row.battles ? row.draws / row.battles : 0,
    elo: Math.round(row.elo * 1000) / 1000,
    data_status: row.battles < 5 ? "early" : row.battles < 20 ? "building" : "stronger",
  }));

  rows.sort((left, right) => right.elo - left.elo || right.battles - left.battles || left.item_id.localeCompare(right.item_id));
  rows.forEach((row, index) => {
    row.rank = index + 1;
    row.win_rate_pct = percent(row.win_rate);
    row.draw_rate_pct = percent(row.draw_rate);
  });

  return { itemRows: rows, pairRows: [...pairs.values()] };
}

function roundElo(value) {
  return Math.round(value * 1000) / 1000;
}

function eloSpread(items) {
  const values = [...items.values()].map((item) => item.elo);
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  return Math.round(Math.sqrt(variance) * 1000) / 1000;
}

function eloTimelineRows(votes, dataset) {
  const items = initItemStats(dataset);
  const historyRows = [];
  const convergenceRows = [];
  let voteIndex = 0;

  for (const vote of [...votes].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))) {
    const left = items.get(vote.left_item_id);
    const right = items.get(vote.right_item_id);
    if (!left || !right) continue;

    voteIndex += 1;
    const touched = [];
    const before = new Map([
      [left.item_id, left.elo],
      [right.item_id, right.elo],
    ]);

    if (vote.vote_result === "draw" || !vote.winner_item_id) {
      left.battles += 1;
      right.battles += 1;
      left.draws += 1;
      right.draws += 1;
      touched.push(left, right);
    } else {
      const winner = items.get(vote.winner_item_id);
      const loserId = vote.loser_item_id || (vote.winner_item_id === left.item_id ? right.item_id : left.item_id);
      const loser = items.get(loserId);
      if (!winner || !loser) continue;

      before.set(winner.item_id, winner.elo);
      before.set(loser.item_id, loser.elo);
      winner.wins += 1;
      loser.losses += 1;
      const elo = updateElo(winner.elo, loser.elo, eloVoteWeight(winner, loser));
      winner.elo = elo.winner;
      loser.elo = elo.loser;
      left.battles += 1;
      right.battles += 1;
      touched.push(winner, loser);
    }

    const uniqueTouched = [...new Map(touched.map((item) => [item.item_id, item])).values()];
    const deltas = uniqueTouched.map((item) => roundElo(item.elo - (before.get(item.item_id) ?? item.elo)));
    for (const item of uniqueTouched) {
      const previousElo = before.get(item.item_id) ?? item.elo;
      const itemResult =
        vote.vote_result === "draw" || !vote.winner_item_id ? "draw" : item.item_id === vote.winner_item_id ? "win" : "loss";
      historyRows.push({
        vote_index: voteIndex,
        created_at: vote.created_at,
        vote_id: vote.id,
        item_id: item.item_id,
        family: item.family,
        title: item.title,
        seed_id: item.seed_id,
        opponent_id: item.item_id === left.item_id ? right.item_id : left.item_id,
        item_result: itemResult,
        vote_result: vote.vote_result,
        previous_elo: roundElo(previousElo),
        elo: roundElo(item.elo),
        elo_delta: roundElo(item.elo - previousElo),
        battles: item.battles,
        wins: item.wins,
        losses: item.losses,
        draws: item.draws,
      });
    }

    const leader = [...items.values()].sort((leftItem, rightItem) => rightItem.elo - leftItem.elo || leftItem.item_id.localeCompare(rightItem.item_id))[0];
    convergenceRows.push({
      vote_index: voteIndex,
      created_at: vote.created_at,
      vote_id: vote.id,
      mean_abs_elo_delta: roundElo(deltas.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, deltas.length)),
      max_abs_elo_delta: roundElo(Math.max(0, ...deltas.map((value) => Math.abs(value)))),
      elo_spread: eloSpread(items),
      leader_item_id: leader.item_id,
      leader_title: leader.title,
      leader_elo: roundElo(leader.elo),
    });
  }

  return { historyRows, convergenceRows };
}

function groupCounts(votes, keyFn) {
  const counts = new Map();
  for (const vote of votes) {
    const key = keyFn(vote);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((left, right) => String(left.key).localeCompare(String(right.key)));
}

function buildSessionRows(votes) {
  const groups = new Map();
  for (const vote of votes) {
    const quality = currentQuality(vote);
    const session = String(vote.session_id || "missing-session");
    const row = groups.get(session) || {
      session_id: session,
      raw_votes: 0,
      clean_votes: 0,
      flagged_votes: 0,
      duplicate_votes: 0,
      too_fast_votes: 0,
      trusted_local_votes: 0,
      unique_pairs: new Set(),
      elapsed_values: [],
      first_vote_at: vote.created_at,
      last_vote_at: vote.created_at,
    };
    row.raw_votes += 1;
    row.clean_votes += quality.acceptedForScoring ? 1 : 0;
    row.flagged_votes += quality.flags.length ? 1 : 0;
    row.duplicate_votes += quality.duplicatePair ? 1 : 0;
    row.too_fast_votes += quality.tooFast ? 1 : 0;
    row.trusted_local_votes += quality.trustedLocal ? 1 : 0;
    row.unique_pairs.add(pairKey(vote.left_item_id, vote.right_item_id));
    if (Number.isFinite(vote.elapsed_ms)) row.elapsed_values.push(vote.elapsed_ms);
    if (String(vote.created_at) < String(row.first_vote_at)) row.first_vote_at = vote.created_at;
    if (String(vote.created_at) > String(row.last_vote_at)) row.last_vote_at = vote.created_at;
    groups.set(session, row);
  }

  return [...groups.values()]
    .map((row) => {
      const first = timestampMs(row.first_vote_at);
      const last = timestampMs(row.last_vote_at);
      return {
        session_id: row.session_id,
        raw_votes: row.raw_votes,
        clean_votes: row.clean_votes,
        flagged_votes: row.flagged_votes,
        duplicate_votes: row.duplicate_votes,
        too_fast_votes: row.too_fast_votes,
        trusted_local_votes: row.trusted_local_votes,
        unique_pairs: row.unique_pairs.size,
        median_elapsed_ms: median(row.elapsed_values),
        first_vote_at: row.first_vote_at,
        last_vote_at: row.last_vote_at,
        active_minutes: first !== null && last !== null ? Math.round(((last - first) / 60_000) * 100) / 100 : null,
      };
    })
    .sort((left, right) => right.raw_votes - left.raw_votes || left.session_id.localeCompare(right.session_id));
}

function pairRowsFromVotes(votes, dataset) {
  const { pairRows } = rankingRows(votes, dataset, "raw");
  const itemLookup = new Map(activeItems(dataset).map((item) => [item.id, item]));
  return pairRows
    .map((row) => ({
      pair_key: row.pair_key,
      family: row.family,
      item_a_id: row.item_a_id,
      item_a_title: itemLookup.get(row.item_a_id)?.title || row.item_a_id,
      item_b_id: row.item_b_id,
      item_b_title: itemLookup.get(row.item_b_id)?.title || row.item_b_id,
      battles: row.battles,
      item_a_wins: row.item_a_wins,
      item_b_wins: row.item_b_wins,
      draws: row.draws,
      one_sided_rate: row.battles ? Math.max(row.item_a_wins, row.item_b_wins) / row.battles : 0,
    }))
    .sort((left, right) => left.battles - right.battles || left.family.localeCompare(right.family) || left.pair_key.localeCompare(right.pair_key));
}

function coverageGapRows(dataset, rawRankings, pairRows) {
  const itemGaps = rawRankings
    .map((row) => ({
      gap_type: "item",
      family: row.family,
      target_id: row.item_id,
      label: row.title,
      current_votes: row.battles,
      priority_score: row.battles,
      recommendation: row.battles === 0 ? "No votes yet" : "Needs more exposure",
    }))
    .sort((left, right) => left.current_votes - right.current_votes || left.target_id.localeCompare(right.target_id));

  const pairGaps = pairRows
    .map((row) => ({
      gap_type: "pair",
      family: row.family,
      target_id: row.pair_key,
      label: `${row.item_a_title} vs ${row.item_b_title}`,
      current_votes: row.battles,
      priority_score: row.battles,
      recommendation: row.battles === 0 ? "Never compared" : "Could use repeat judgments",
    }))
    .sort((left, right) => left.current_votes - right.current_votes || left.target_id.localeCompare(right.target_id));

  return [...itemGaps.slice(0, activeItems(dataset).length), ...pairGaps.slice(0, 200)];
}

function anomalyRows({ sessions, pairRows, rawRankings, familyRows }) {
  const rows = [];
  for (const session of sessions) {
    const duplicateRatio = session.raw_votes ? session.duplicate_votes / session.raw_votes : 0;
    const tooFastRatio = session.raw_votes ? session.too_fast_votes / session.raw_votes : 0;
    const trustedLocalSession = session.raw_votes > 0 && session.trusted_local_votes === session.raw_votes;
    if (session.raw_votes >= 25) {
      rows.push({ anomaly_type: "high_volume_session", severity: "watch", subject_id: session.session_id, evidence: `${session.raw_votes} votes` });
    }
    if (!trustedLocalSession && (session.too_fast_votes >= 3 || (session.raw_votes >= 3 && tooFastRatio >= 0.5))) {
      rows.push({ anomaly_type: "too_fast_session", severity: "review", subject_id: session.session_id, evidence: `${session.too_fast_votes}/${session.raw_votes} too fast` });
    }
    if (session.duplicate_votes >= 3 || (session.raw_votes >= 5 && duplicateRatio >= 0.3)) {
      rows.push({ anomaly_type: "duplicate_heavy_session", severity: "review", subject_id: session.session_id, evidence: `${session.duplicate_votes}/${session.raw_votes} duplicate pairs` });
    }
    if (!trustedLocalSession && session.raw_votes >= 3 && session.median_elapsed_ms !== null && session.median_elapsed_ms < 1200) {
      rows.push({ anomaly_type: "low_median_vote_time", severity: "review", subject_id: session.session_id, evidence: `${Math.round(session.median_elapsed_ms)}ms median` });
    }
  }

  for (const pair of pairRows) {
    if (pair.battles >= 5 && pair.one_sided_rate >= 0.9) {
      rows.push({ anomaly_type: "one_sided_pair", severity: "watch", subject_id: pair.pair_key, evidence: `${pair.battles} battles, ${percent(pair.one_sided_rate)}% one-sided` });
    }
  }

  const averageFamilyVotes = familyRows.reduce((sum, row) => sum + row.raw_votes, 0) / Math.max(1, familyRows.length);
  for (const row of familyRows) {
    if (row.raw_votes < averageFamilyVotes * 0.35) {
      rows.push({ anomaly_type: "family_undercovered", severity: "watch", subject_id: row.family, evidence: `${row.raw_votes} votes vs avg ${Math.round(averageFamilyVotes)}` });
    }
  }

  for (const item of rawRankings.filter((row) => row.battles === 0).slice(0, 20)) {
    rows.push({ anomaly_type: "item_no_votes", severity: "gap", subject_id: item.item_id, evidence: `${item.title} has no votes` });
  }

  return rows.sort((left, right) => left.severity.localeCompare(right.severity) || left.anomaly_type.localeCompare(right.anomaly_type));
}

function familyRows(votes, dataset) {
  const items = new Map(activeItems(dataset).map((item) => [item.id, item]));
  const voteTouchesFamily = (vote, family) => {
    const left = items.get(vote.left_item_id);
    const right = items.get(vote.right_item_id);
    return left?.family === family || right?.family === family;
  };
  return (dataset.families || []).map((family) => {
    const familyVotes = votes.filter((vote) => voteTouchesFamily(vote, family));
    const cleanVotes = familyVotes.filter(isCleanVote);
    const itemCount = activeItems(dataset).filter((item) => item.family === family).length;
    return {
      family,
      item_count: itemCount,
      raw_votes: familyVotes.length,
      clean_votes: cleanVotes.length,
      vote_share_pct: votes.length ? percent(familyVotes.length / votes.length) : 0,
    };
  });
}

export function analyzeVotes({ votes, dataset, generatedAtUtc = new Date().toISOString() }) {
  const allVotes = [...votes].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  const testVotes = allVotes.filter(isTestVote);
  const reportVotes = allVotes.filter((vote) => !isTestVote(vote));
  const cleanVotes = reportVotes.filter(isCleanVote);
  const rawRanking = rankingRows(reportVotes, dataset, "raw");
  const cleanRanking = rankingRows(cleanVotes, dataset, "clean");
  const eloTimeline = eloTimelineRows(cleanVotes, dataset);
  const pairRows = pairRowsFromVotes(reportVotes, dataset);
  const sessions = buildSessionRows(reportVotes);
  const coverageGaps = coverageGapRows(dataset, rawRanking.itemRows, pairRows);
  const familySummaries = familyRows(reportVotes, dataset);
  const anomalies = anomalyRows({ sessions, pairRows, rawRankings: rawRanking.itemRows, familyRows: familySummaries });

  const itemsById = new Map(rawRanking.itemRows.map((row) => [row.item_id, row]));
  const cleanById = new Map(cleanRanking.itemRows.map((row) => [row.item_id, row]));
  const itemRows = activeItems(dataset).map((item) => {
    const raw = itemsById.get(item.id);
    const clean = cleanById.get(item.id);
    return {
      item_id: item.id,
      family: item.family,
      title: item.title,
      seed_id: item.seedId,
      raw_battles: raw?.battles || 0,
      clean_battles: clean?.battles || 0,
      raw_wins: raw?.wins || 0,
      clean_wins: clean?.wins || 0,
      raw_draws: raw?.draws || 0,
      clean_draws: clean?.draws || 0,
      raw_elo: raw?.elo ?? initialEloForItem(item),
      clean_elo: clean?.elo ?? initialEloForItem(item),
      data_status: clean?.data_status || raw?.data_status || "early",
    };
  });

  const votesPerHour = groupCounts(reportVotes, (vote) => hourKey(vote.created_at)).map((row) => ({ hour: row.key, votes: row.count }));
  const votesPerDay = groupCounts(reportVotes, (vote) => dayKey(vote.created_at)).map((row) => ({ day: row.key, votes: row.count }));
  const flaggedVotes = reportVotes.filter((vote) => currentQuality(vote).flags.length);

  return {
    generatedAtUtc,
    datasetId: dataset.datasetId,
    totals: {
      totalRawVotes: allVotes.length,
      reportRawVotes: reportVotes.length,
      cleanVotes: cleanVotes.length,
      acceptedVotes: reportVotes.filter((vote) => currentQuality(vote).acceptedForScoring).length,
      flaggedVotes: flaggedVotes.length,
      trustedLocalVotes: reportVotes.filter((vote) => currentQuality(vote).trustedLocal).length,
      excludedTestVotes: testVotes.length,
      activeSessions: sessions.length,
      activeItems: activeItems(dataset).length,
      possiblePairs: allDatasetPairs(dataset).length,
    },
    familyRows: familySummaries,
    votesPerHour,
    votesPerDay,
    itemRows,
    pairRows,
    sessionRows: sessions,
    coverageGaps,
    anomalyRows: anomalies,
    rankingsRaw: rawRanking.itemRows,
    rankingsClean: cleanRanking.itemRows,
    eloHistoryRows: eloTimeline.historyRows,
    eloConvergenceRows: eloTimeline.convergenceRows,
    excludedTestVoteIds: testVotes.map((vote) => vote.id),
  };
}

function summaryMarkdown(analysis) {
  const topClean = analysis.rankingsClean.slice(0, 5);
  const gaps = analysis.coverageGaps.slice(0, 10);
  const latestConvergence = analysis.eloConvergenceRows.at(-1);
  return [
    "# CadBattle Local Analysis",
    "",
    `Generated: ${analysis.generatedAtUtc}`,
    `Dataset: ${analysis.datasetId}`,
    "",
    "## Quantity",
    "",
    `- Raw backed-up votes: ${analysis.totals.totalRawVotes}`,
    `- Report votes excluding test sessions: ${analysis.totals.reportRawVotes}`,
    `- Clean votes: ${analysis.totals.cleanVotes}`,
    `- Trusted local votes: ${analysis.totals.trustedLocalVotes}`,
    `- Active sessions: ${analysis.totals.activeSessions}`,
    `- Excluded test votes: ${analysis.totals.excludedTestVotes}`,
    "",
    "## Early Clean Leaders",
    "",
    ...(topClean.length ? topClean.map((row) => `- #${row.rank} ${row.title} (${row.family}): Elo ${row.elo}, ${row.battles} clean battles`) : ["- Not enough clean votes yet."]),
    "",
    "## Elo Convergence",
    "",
    latestConvergence
      ? `- Latest mean absolute Elo move: ${latestConvergence.mean_abs_elo_delta}`
      : "- Not enough clean votes yet.",
    latestConvergence
      ? `- Current Elo spread: ${latestConvergence.elo_spread}`
      : "",
    "",
    "## Biggest Coverage Gaps",
    "",
    ...(gaps.length ? gaps.map((row) => `- ${row.gap_type}: ${row.label} (${row.current_votes} votes)`) : ["- No coverage gaps found."]),
    "",
  ].join("\n");
}

function htmlTable(rows, columns, limit = 12) {
  const limited = rows.slice(0, limit);
  if (!limited.length) return "<p class=\"empty\">No rows yet.</p>";
  return `<table><thead><tr>${columns.map((col) => `<th>${col.label}</th>`).join("")}</tr></thead><tbody>${limited
    .map((row) => `<tr>${columns.map((col) => `<td>${row[col.key] ?? ""}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function renderHtml(analysis) {
  const totals = analysis.totals;
  const maxHourVotes = Math.max(1, ...analysis.votesPerHour.map((row) => row.votes));
  const hourBars = analysis.votesPerHour
    .slice(-24)
    .map((row) => `<div class="bar-row"><span>${row.hour.slice(5, 16).replace("T", " ")}</span><strong style="width:${Math.max(4, (row.votes / maxHourVotes) * 100)}%">${row.votes}</strong></div>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CadBattle Local Analysis</title>
  <style>
    :root { color-scheme: light; --ink:#14251e; --muted:#61776b; --line:#d7e7d8; --lime:#dff38e; --mint:#a5e3c0; --deep:#0b3028; --paper:#fbfff2; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: linear-gradient(180deg,#dff8ed,#effbd1 46%,#f8fff2); }
    header { padding:34px 28px 18px; background:#0d3a33; color:white; }
    main { width:min(1180px, calc(100% - 28px)); margin:0 auto; padding:24px 0 48px; display:grid; gap:18px; }
    h1, h2, p { margin:0; }
    h1 { font-size:clamp(30px,5vw,58px); letter-spacing:0; }
    .sub { color:#cfeedd; margin-top:8px; }
    .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .card { background:rgba(255,255,255,.82); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 18px 50px rgba(18,63,50,.12); }
    .metric span { display:block; color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; }
    .metric strong { display:block; margin-top:8px; font-size:32px; font-family:Cascadia Mono, Consolas, monospace; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { padding:10px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:#466457; font-size:12px; text-transform:uppercase; }
    .section { display:grid; gap:10px; }
    .bar-row { display:grid; grid-template-columns:120px 1fr; align-items:center; gap:10px; margin:7px 0; font-size:13px; color:var(--muted); }
    .bar-row strong { display:block; min-width:28px; padding:5px 8px; border-radius:5px; background:linear-gradient(90deg,var(--lime),var(--mint)); color:#12261d; font-family:Cascadia Mono, Consolas, monospace; }
    .downloads { display:flex; gap:8px; flex-wrap:wrap; }
    .downloads a { color:#10251d; background:var(--lime); padding:8px 10px; border-radius:6px; font-weight:800; text-decoration:none; }
    .empty { color:var(--muted); }
    @media (max-width: 820px) { .grid { grid-template-columns:1fr 1fr; } header { padding:26px 18px 14px; } }
    @media (max-width: 520px) { .grid { grid-template-columns:1fr; } table { font-size:12px; } }
  </style>
</head>
<body>
  <header>
    <h1>CadBattle Local Analysis</h1>
    <p class="sub">Quantity-first readout generated ${analysis.generatedAtUtc}. Test votes are preserved in raw backups but excluded here.</p>
  </header>
  <main>
    <section class="grid">
      <div class="card metric"><span>Backed-up votes</span><strong>${totals.totalRawVotes}</strong></div>
      <div class="card metric"><span>Report votes</span><strong>${totals.reportRawVotes}</strong></div>
      <div class="card metric"><span>Clean votes</span><strong>${totals.cleanVotes}</strong></div>
      <div class="card metric"><span>Active sessions</span><strong>${totals.activeSessions}</strong></div>
    </section>
    <section class="card section"><h2>Vote Momentum</h2>${hourBars || "<p class=\"empty\">No hourly votes yet.</p>"}</section>
    <section class="card section"><h2>Clean Early Rankings</h2>${htmlTable(analysis.rankingsClean, [
      { key: "rank", label: "Rank" }, { key: "title", label: "Model" }, { key: "family", label: "Family" },
      { key: "elo", label: "Elo" }, { key: "battles", label: "Battles" }, { key: "win_rate_pct", label: "Win %" }, { key: "data_status", label: "Status" },
    ])}</section>
    <section class="card section"><h2>Coverage Gaps</h2>${htmlTable(analysis.coverageGaps, [
      { key: "gap_type", label: "Type" }, { key: "label", label: "Target" }, { key: "family", label: "Family" },
      { key: "current_votes", label: "Votes" }, { key: "recommendation", label: "Recommendation" },
    ], 18)}</section>
    <section class="card section"><h2>Anomalies To Watch</h2>${htmlTable(analysis.anomalyRows, [
      { key: "severity", label: "Severity" }, { key: "anomaly_type", label: "Type" }, { key: "subject_id", label: "Subject" }, { key: "evidence", label: "Evidence" },
    ], 18)}</section>
    <section class="card section"><h2>Family Split</h2>${htmlTable(analysis.familyRows, [
      { key: "family", label: "Family" }, { key: "item_count", label: "Items" }, { key: "raw_votes", label: "Raw votes" }, { key: "clean_votes", label: "Clean votes" }, { key: "vote_share_pct", label: "Vote share %" },
    ])}</section>
    <section class="card section"><h2>Downloads</h2><div class="downloads">
      ${["summary.md", "analysis.json", "items.csv", "pairs.csv", "sessions.csv", "coverage_gaps.csv", "anomalies.csv", "rankings_raw.csv", "rankings_clean.csv", "elo_history.csv", "elo_convergence.csv"].map((file) => `<a href="${file}">${file}</a>`).join("")}
    </div></section>
  </main>
</body>
</html>`;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeAnalysisOutputs(analysis, outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const files = {
    "analysis.json": JSON.stringify(analysis, null, 2),
    "summary.md": summaryMarkdown(analysis),
    "items.csv": toCsv(analysis.itemRows),
    "pairs.csv": toCsv(analysis.pairRows),
    "sessions.csv": toCsv(analysis.sessionRows),
    "coverage_gaps.csv": toCsv(analysis.coverageGaps),
    "anomalies.csv": toCsv(analysis.anomalyRows),
    "rankings_raw.csv": toCsv(analysis.rankingsRaw),
    "rankings_clean.csv": toCsv(analysis.rankingsClean),
    "elo_history.csv": toCsv(analysis.eloHistoryRows),
    "elo_convergence.csv": toCsv(analysis.eloConvergenceRows),
    "index.html": renderHtml(analysis),
  };
  for (const [file, contents] of Object.entries(files)) {
    await writeFile(join(outDir, file), contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
  }
}

export async function copyAnalysisRunToLatest(runDir, latestDir) {
  await rm(latestDir, { recursive: true, force: true });
  await mkdir(dirname(latestDir), { recursive: true });
  await mkdir(latestDir, { recursive: true });
  const files = await readdir(runDir, { withFileTypes: true });
  await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        await writeFile(join(latestDir, entry.name), await readFile(join(runDir, entry.name)));
      }),
  );
}

export async function processData({ backupRoot = join("exports", "live-backups"), outRoot = join("exports", "analysis"), datasetPath = join("public", "data", "items.json"), now = new Date() } = {}) {
  const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
  const votes = await loadVotesFromBackupRoot(backupRoot);
  const analysis = analyzeVotes({ votes, dataset, generatedAtUtc: now.toISOString() });
  const runDir = resolve(outRoot, "runs", timestampSlug(now));
  const latestDir = resolve(outRoot, "latest");
  await writeAnalysisOutputs(analysis, runDir);
  await copyAnalysisRunToLatest(runDir, latestDir);
  await writeJson(join(runDir, "manifest.json"), {
    generatedAtUtc: analysis.generatedAtUtc,
    backupRoot,
    outRoot,
    datasetPath,
    latestDir,
    voteCount: analysis.totals.totalRawVotes,
  });
  await writeJson(join(latestDir, "manifest.json"), {
    generatedAtUtc: analysis.generatedAtUtc,
    backupRoot,
    outRoot,
    datasetPath,
    runDir,
    voteCount: analysis.totals.totalRawVotes,
  });
  return { analysis, runDir, latestDir };
}
