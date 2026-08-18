export type ArenaFamily = "wall_planter" | "wall_hook" | "snowman";
export type BattleGroup = ArenaFamily | "mixed";

export interface ArenaItem {
  id: string;
  family: ArenaFamily;
  familyLabel: string;
  active: boolean;
  title: string;
  seedId: string;
  specificityLevel: number | null;
  repetition: number;
  experimentId: string;
  modelName: string;
  provider: string;
  latencyMs: number | null;
  validation: {
    valid?: boolean;
    confidence?: number;
    brief_reason?: string;
    issues?: string[];
  } | null;
  tags: string[];
  stlUrl: string;
  previewUrl: string;
  sourceHash: string;
}

/**
 * What a battle is allowed to tell the browser about a model. Everything else on
 * an ArenaItem — the validator's verdict and reasoning, the generating model and
 * provider, latency, seed, source hash — is the arena's own opinion of the thing
 * the voter is being asked to judge, so it stays on the server.
 */
export interface PublicArenaItem {
  id: string;
  family: ArenaFamily;
  familyLabel: string;
  title: string;
  stlUrl: string;
  previewUrl: string;
}

export interface DatasetPayload {
  datasetId: string;
  generatedAtUtc: string;
  itemCount: number;
  families: ArenaFamily[];
  items: ArenaItem[];
}

export interface HoldChallenge {
  challengeId: string;
  targetMs: number;
  issuedAt: number;
  token: string;
}

export interface HoldSubmission extends HoldChallenge {
  heldMs: number;
}

export interface BattleResponse {
  battleId: string;
  datasetId: string;
  family: BattleGroup;
  left: PublicArenaItem;
  right: PublicArenaItem;
  hold: HoldChallenge;
  stats: {
    itemCount: number;
    familyItemCount: number;
    dataMode: "live" | "local";
    historyAvailable: boolean;
  };
}

export interface VotePayload {
  battle_id: string;
  left_item_id: string;
  right_item_id: string;
  winner_item_id?: string | null;
  vote_result?: "winner" | "draw";
  started_at: string;
  models_loaded_at: string;
  voted_at: string;
  session_id: string;
  hold?: HoldSubmission | null;
}

export interface VoteResponse {
  saved: boolean;
  summaryUpdated: boolean;
  acceptedForScoring: boolean;
  agreementPercent: number;
  agreementLabel: string;
  crowd: {
    agreementPercent: number;
    agreesWithMajority: boolean;
    source: "direct" | "elo";
    confidence: "low" | "medium" | "high";
    sampleSize: number;
  };
  dataMode: "live" | "local";
  qualityFlags: string[];
}

export interface PublicStats {
  datasetId: string;
  itemCount: number;
  totalVotes: number;
  acceptedVotes: number;
  mixedVoteCount: number;
  mixedAcceptedVoteCount: number;
  families: Array<{
    family: ArenaFamily;
    label: string;
    itemCount: number;
    voteCount: number;
  }>;
  dataMode: "live" | "local";
}
