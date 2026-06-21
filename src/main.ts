import "./styles.css";
import dataset from "./data/items.generated.json";
import { StlViewer } from "./client/stlViewer";
import type { ArenaItem, BattleGroup, BattleResponse, HoldChallenge, VoteResponse } from "./shared/types";

const SESSION_KEY = "capybara-arena-session";
const SEEN_PAIRS_KEY = "capybara-arena-seen-pairs";
const VOTE_HISTORY_KEY = "capybara-arena-vote-history";
const STREAK_KEY = "capybara-arena-streak";
const BEST_STREAK_KEY = "capybara-arena-best-streak";
const LAST_VOTE_MS_KEY = "capybara-arena-last-vote-ms";
const RAPID_VOTE_WINDOW_MS = 10000;
const RAPID_VOTE_LIMIT = 12;
const STREAK_RESET_MS = 10 * 60 * 1000;
const AUTO_NEXT_DELAY_MS = 360;
const PANEL_CLICK_MOVE_THRESHOLD_PX = 8;

interface CurrentBattle extends BattleResponse {
  localOnly?: boolean;
}

type VoteChoice = string | "draw";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");

app.innerHTML = `
  <div class="arena-app">
    <header class="top-bar" id="top" aria-label="Capybara Arena">
      <h1 class="brand-word">Capybara Arena</h1>
    </header>

    <main class="arena-shell" id="arena">
      <section class="battle-grid" aria-live="polite">
        <article class="model-panel" data-side="left" aria-label="Model A">
          <div class="panel-top">
            <span class="side-chip">A</span>
            <h3 id="left-title">Loading</h3>
          </div>
          <div class="viewer-frame" id="left-frame">
            <canvas id="left-canvas" aria-label="3D preview of model A"></canvas>
            <div class="viewer-status" id="left-status">Loading STL</div>
          </div>
          <button type="button" class="vote-action" id="vote-left" disabled>A is better</button>
        </article>

        <div class="draw-column" aria-label="Tie vote">
          <div class="round-pulse" id="round-pulse">VS</div>
          <button type="button" class="draw-action" id="vote-draw" aria-label="No clear winner" disabled>Tie</button>
        </div>

        <article class="model-panel" data-side="right" aria-label="Model B">
          <div class="panel-top">
            <h3 id="right-title">Loading</h3>
            <span class="side-chip">B</span>
          </div>
          <div class="viewer-frame" id="right-frame">
            <canvas id="right-canvas" aria-label="3D preview of model B"></canvas>
            <div class="viewer-status" id="right-status">Loading STL</div>
          </div>
          <button type="button" class="vote-action" id="vote-right" disabled>B is better</button>
        </article>
      </section>
    </main>

    <section class="hold-panel is-hidden" id="hold-panel" aria-label="Hold to verify">
      <div>
        <p class="kicker">Quick check</p>
        <h2 id="hold-title">Hold to verify</h2>
      </div>
      <button type="button" id="hold-button" class="hold-button">
        <span id="hold-fill"></span>
        <strong id="hold-label">Hold to verify</strong>
      </button>
    </section>

    <section class="feedback-panel is-hidden" id="feedback-panel" role="status" aria-live="polite" aria-atomic="true">
      <h2 id="feedback-title">Vote saved</h2>
      <p id="feedback-copy"></p>
    </section>
  </div>
`;

const dom = {
  arena: document.querySelector("#arena") as HTMLElement,
  leftPanel: document.querySelector('[data-side="left"]') as HTMLElement,
  rightPanel: document.querySelector('[data-side="right"]') as HTMLElement,
  leftFrame: document.querySelector("#left-frame") as HTMLElement,
  rightFrame: document.querySelector("#right-frame") as HTMLElement,
  leftCanvas: document.querySelector("#left-canvas") as HTMLCanvasElement,
  rightCanvas: document.querySelector("#right-canvas") as HTMLCanvasElement,
  leftTitle: document.querySelector("#left-title") as HTMLElement,
  rightTitle: document.querySelector("#right-title") as HTMLElement,
  leftStatus: document.querySelector("#left-status") as HTMLElement,
  rightStatus: document.querySelector("#right-status") as HTMLElement,
  voteLeft: document.querySelector("#vote-left") as HTMLButtonElement,
  voteRight: document.querySelector("#vote-right") as HTMLButtonElement,
  voteDraw: document.querySelector("#vote-draw") as HTMLButtonElement,
  holdPanel: document.querySelector("#hold-panel") as HTMLElement,
  holdButton: document.querySelector("#hold-button") as HTMLButtonElement,
  holdFill: document.querySelector("#hold-fill") as HTMLElement,
  holdLabel: document.querySelector("#hold-label") as HTMLElement,
  feedbackPanel: document.querySelector("#feedback-panel") as HTMLElement,
  feedbackTitle: document.querySelector("#feedback-title") as HTMLElement,
  feedbackCopy: document.querySelector("#feedback-copy") as HTMLElement,
  roundPulse: document.querySelector("#round-pulse") as HTMLElement,
};

let currentBattle: CurrentBattle | null = null;
let selectedChoice: VoteChoice | null = null;
let battleStartedAt = "";
let modelsLoadedAt = "";
let leftViewer: StlViewer | null = null;
let rightViewer: StlViewer | null = null;
let holdStartedAt = 0;
let holdFrame = 0;
let autoNextTimer = 0;
let voteInFlight = false;
let panelPointerIntent: {
  side: "left" | "right";
  pointerId: number;
  startX: number;
  startY: number;
} | null = null;

function sessionId(): string {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const value = window.crypto.randomUUID();
  window.localStorage.setItem(SESSION_KEY, value);
  return value;
}

function pairKeyClient(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join("__");
}

function pairGroupClient(left: ArenaItem, right: ArenaItem): BattleGroup {
  return left.family === right.family ? left.family : "mixed";
}

function seenPairs(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_PAIRS_KEY) || "[]") as string[];
    return new Set(parsed.filter((value) => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function rememberPair(leftId: string, rightId: string): void {
  const pairs = seenPairs();
  pairs.add(pairKeyClient(leftId, rightId));
  window.localStorage.setItem(SEEN_PAIRS_KEY, JSON.stringify([...pairs].slice(-700)));
}

function recentVoteTimes(now = Date.now()): number[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VOTE_HISTORY_KEY) || "[]") as number[];
    return parsed.filter((value) => Number.isFinite(value) && now - value < RAPID_VOTE_WINDOW_MS);
  } catch {
    return [];
  }
}

function rememberVoteTime(now = Date.now()): void {
  window.localStorage.setItem(VOTE_HISTORY_KEY, JSON.stringify([...recentVoteTimes(now), now].slice(-20)));
}

function storedNumber(key: string): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function recordStreak(now = Date.now()): number {
  const lastVoteMs = storedNumber(LAST_VOTE_MS_KEY);
  const previous = storedNumber(STREAK_KEY);
  const next = lastVoteMs && now - lastVoteMs <= STREAK_RESET_MS ? previous + 1 : 1;
  const best = Math.max(storedNumber(BEST_STREAK_KEY), next);
  window.localStorage.setItem(STREAK_KEY, String(next));
  window.localStorage.setItem(BEST_STREAK_KEY, String(best));
  window.localStorage.setItem(LAST_VOTE_MS_KEY, String(now));
  return next;
}

function feedbackLine(isDraw: boolean, streak: number): string {
  if (isDraw) return streak > 1 ? `tie saved - streak x${streak}` : "tie saved";
  const lines = ["clean pick", "locked in", "next matchup queued", "arena heard you", "judgment saved"];
  const line = lines[streak % lines.length];
  return streak > 1 ? `${line} - streak x${streak}` : line;
}

function allLocalPairs(items: ArenaItem[]): Array<[ArenaItem, ArenaItem]> {
  const pairs: Array<[ArenaItem, ArenaItem]> = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      pairs.push([items[leftIndex], items[rightIndex]]);
    }
  }
  return pairs;
}

function localSeenItemBattles(priorPairs: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of priorPairs) {
    const [leftId, rightId] = key.split("__");
    if (!leftId || !rightId) continue;
    counts.set(leftId, (counts.get(leftId) || 0) + 1);
    counts.set(rightId, (counts.get(rightId) || 0) + 1);
  }
  return counts;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(data.message || data.error || `${url} returned ${response.status}`);
  return data;
}

function localBattle(): CurrentBattle {
  const priorPairs = seenPairs();
  const seenItemBattles = localSeenItemBattles(priorPairs);
  const items = (dataset.items as ArenaItem[]).filter((item) => item.active !== false);
  const pairs = allLocalPairs(items);
  const candidates = pairs.filter(([left, right]) => !priorPairs.has(pairKeyClient(left.id, right.id)));
  const scoredPairs = (candidates.length ? candidates : pairs)
    .map((pair) => {
      const [left, right] = pair;
      const leftBattles = seenItemBattles.get(left.id) || 0;
      const rightBattles = seenItemBattles.get(right.id) || 0;
      return {
        pair,
        score: Math.max(leftBattles, rightBattles) * 24 + Math.min(leftBattles, rightBattles) * 12 + Math.random(),
      };
    })
    .sort((left, right) => left.score - right.score);
  const selected = scoredPairs[0]?.pair || pairs[0];
  if (!selected) throw new Error("At least two local items are required");
  const [left, right] = Math.random() > 0.5 ? selected : [selected[1], selected[0]];
  const family = pairGroupClient(left, right);
  const hold: HoldChallenge = {
    challengeId: "local",
    targetMs: 900,
    issuedAt: Date.now(),
    token: "local",
  };
  return {
    battleId: `local-${Date.now()}`,
    datasetId: dataset.datasetId,
    family,
    left,
    right,
    hold,
    localOnly: true,
    stats: {
      itemCount: dataset.itemCount,
      familyItemCount: items.length,
      dataMode: "local",
    },
  };
}

function markArenaLive(): void {
  dom.roundPulse.textContent = "VS";
}

function canUseLocalFallback(): boolean {
  return ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
}

function shouldVerifyVote(): boolean {
  const now = Date.now();
  return recentVoteTimes(now).length >= RAPID_VOTE_LIMIT;
}

function clearFeedback(): void {
  window.clearTimeout(autoNextTimer);
  autoNextTimer = 0;
  dom.feedbackPanel.classList.add("is-hidden");
  dom.holdPanel.classList.add("is-hidden");
  selectedChoice = null;
}

function setVoteControls(enabled: boolean): void {
  dom.voteLeft.disabled = !enabled;
  dom.voteRight.disabled = !enabled;
  dom.voteDraw.disabled = !enabled;
  dom.leftPanel.classList.toggle("is-ready", enabled);
  dom.rightPanel.classList.toggle("is-ready", enabled);
  dom.leftPanel.setAttribute("aria-disabled", String(!enabled));
  dom.rightPanel.setAttribute("aria-disabled", String(!enabled));
}

async function loadBattle(): Promise<void> {
  clearFeedback();
  voteInFlight = false;
  modelsLoadedAt = "";
  const hasVisibleBattle = Boolean(currentBattle && leftViewer && rightViewer);
  const nextBattleStartedAt = new Date().toISOString();
  dom.roundPulse.textContent = "loading";
  dom.arena.classList.add("is-loading-next");
  setVoteControls(false);
  dom.leftPanel.classList.remove("is-voting");
  dom.rightPanel.classList.remove("is-voting");
  dom.leftStatus.textContent = "Loading STL";
  dom.rightStatus.textContent = "Loading STL";
  dom.leftFrame.classList.add("is-loading");
  dom.rightFrame.classList.add("is-loading");
  dom.leftStatus.classList.toggle("is-hidden", hasVisibleBattle);
  dom.rightStatus.classList.toggle("is-hidden", hasVisibleBattle);
  if (!hasVisibleBattle) {
    dom.leftTitle.textContent = "Loading";
    dom.rightTitle.textContent = "Loading";
  }

  let nextBattle: CurrentBattle;
  try {
    const params = new URLSearchParams({
      session_id: sessionId(),
      seen_pairs: [...seenPairs()].slice(-500).join(","),
    });
    nextBattle = await getJson<CurrentBattle>(`/api/battle?${params}`);
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    nextBattle = localBattle();
  }

  leftViewer ||= new StlViewer(dom.leftCanvas);
  rightViewer ||= new StlViewer(dom.rightCanvas);

  try {
    await Promise.all([
      leftViewer.load(nextBattle.left.stlUrl, nextBattle.left.title),
      rightViewer.load(nextBattle.right.stlUrl, nextBattle.right.title),
    ]);
    currentBattle = nextBattle;
    battleStartedAt = nextBattleStartedAt;
    modelsLoadedAt = new Date().toISOString();
    dom.leftTitle.textContent = currentBattle.left.familyLabel;
    dom.rightTitle.textContent = currentBattle.right.familyLabel;
    dom.leftFrame.classList.remove("is-loading");
    dom.rightFrame.classList.remove("is-loading");
    dom.leftStatus.classList.add("is-hidden");
    dom.rightStatus.classList.add("is-hidden");
    setVoteControls(true);
    dom.arena.classList.remove("is-loading-next");
    markArenaLive();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load STL";
    dom.leftStatus.textContent = message;
    dom.rightStatus.textContent = message;
    dom.leftStatus.classList.remove("is-hidden");
    dom.rightStatus.classList.remove("is-hidden");
    dom.leftFrame.classList.remove("is-loading");
    dom.rightFrame.classList.remove("is-loading");
    dom.arena.classList.remove("is-loading-next");
    dom.roundPulse.textContent = "retry";
  }
}

function startHold(choice: VoteChoice): void {
  if (!currentBattle) return;
  selectedChoice = choice;
  dom.holdPanel.classList.remove("is-hidden");
  dom.holdLabel.textContent = "Hold to verify";
  dom.holdFill.style.transform = "scaleX(0)";
  dom.holdButton.focus();
}

function updateHoldProgress(): void {
  if (!currentBattle || !holdStartedAt) return;
  const elapsed = performance.now() - holdStartedAt;
  const progress = Math.min(1, elapsed / currentBattle.hold.targetMs);
  dom.holdFill.style.transform = `scaleX(${progress})`;
  if (progress >= 1) {
    finishHold(elapsed).catch(showVoteError);
    return;
  }
  holdFrame = requestAnimationFrame(updateHoldProgress);
}

function beginHold(): void {
  if (!currentBattle || !selectedChoice) return;
  holdStartedAt = performance.now();
  dom.holdButton.classList.add("holding");
  cancelAnimationFrame(holdFrame);
  holdFrame = requestAnimationFrame(updateHoldProgress);
}

function cancelHold(): void {
  holdStartedAt = 0;
  dom.holdButton.classList.remove("holding");
  cancelAnimationFrame(holdFrame);
  if (!currentBattle) return;
  const elapsed = Number(dom.holdFill.style.transform.match(/scaleX\(([^)]+)\)/)?.[1] || 0);
  if (elapsed < 1) dom.holdFill.style.transform = "scaleX(0)";
}

async function submitVote(choice: VoteChoice, heldMs: number | null): Promise<void> {
  if (!currentBattle || voteInFlight) return;
  voteInFlight = true;
  const isDraw = choice === "draw";
  const winnerId = isDraw ? null : choice;
  const hold = heldMs === null ? null : { ...currentBattle.hold, heldMs: Math.round(heldMs) };
  setVoteControls(false);
  dom.leftPanel.classList.toggle("is-voting", choice === currentBattle.left.id);
  dom.rightPanel.classList.toggle("is-voting", choice === currentBattle.right.id);
  dom.holdButton.disabled = true;
  if (hold) dom.holdLabel.textContent = "Saving";
  const votedAt = new Date().toISOString();
  const left = currentBattle.left;
  const right = currentBattle.right;
  cancelAnimationFrame(holdFrame);
  dom.holdButton.classList.remove("holding");
  const response = currentBattle.localOnly
    ? ({
        saved: true,
        acceptedForScoring: false,
        agreementPercent: Math.round(52 + Math.random() * 36),
        agreementLabel: isDraw ? "Tie saved." : "Vote saved.",
        dataMode: "local",
        qualityFlags: ["local_preview"],
      } satisfies VoteResponse)
    : await postJson<VoteResponse>("/api/vote", {
        battle_id: currentBattle.battleId,
        left_item_id: left.id,
        right_item_id: right.id,
        winner_item_id: winnerId,
        vote_result: isDraw ? "draw" : "winner",
        started_at: battleStartedAt,
        models_loaded_at: modelsLoadedAt || new Date().toISOString(),
        voted_at: votedAt,
        session_id: sessionId(),
        hold,
      });

  const now = Date.now();
  rememberVoteTime(now);
  const streak = recordStreak(now);
  rememberPair(left.id, right.id);
  dom.holdButton.disabled = false;
  dom.holdPanel.classList.add("is-hidden");
  dom.feedbackPanel.classList.remove("is-hidden");
  dom.feedbackPanel.classList.toggle("is-draw", isDraw);
  dom.feedbackTitle.textContent = isDraw ? "Draw saved" : "+1 saved";
  dom.feedbackCopy.textContent = feedbackLine(isDraw, streak);
  dom.roundPulse.textContent = "next";
  window.clearTimeout(autoNextTimer);
  autoNextTimer = window.setTimeout(() => {
    loadBattle().catch(showVoteError);
  }, AUTO_NEXT_DELAY_MS);
}

async function finishHold(heldMs: number): Promise<void> {
  if (!selectedChoice) return;
  await submitVote(selectedChoice, heldMs);
}

async function chooseVote(choice: VoteChoice): Promise<void> {
  if (!currentBattle) return;
  selectedChoice = choice;
  if (shouldVerifyVote()) {
    startHold(choice);
    return;
  }
  await submitVote(choice, null);
}

function showVoteError(error: unknown): void {
  voteInFlight = false;
  dom.holdButton.disabled = false;
  setVoteControls(Boolean(currentBattle));
  dom.leftPanel.classList.remove("is-voting");
  dom.rightPanel.classList.remove("is-voting");
  dom.holdLabel.textContent = "Try again";
  dom.feedbackPanel.classList.remove("is-hidden");
  dom.feedbackTitle.textContent = "Try again";
  dom.feedbackCopy.textContent = "The arena did not catch that vote. Tap a model again.";
  dom.roundPulse.textContent = "try again";
}

dom.voteLeft.addEventListener("click", () => {
  if (currentBattle) chooseVote(currentBattle.left.id).catch(showVoteError);
});

dom.voteRight.addEventListener("click", () => {
  if (currentBattle) chooseVote(currentBattle.right.id).catch(showVoteError);
});

dom.voteDraw.addEventListener("click", () => {
  if (currentBattle) chooseVote("draw").catch(showVoteError);
});

function choosePanel(side: "left" | "right"): void {
  if (!currentBattle || voteInFlight) return;
  if (side === "left" && dom.voteLeft.disabled) return;
  if (side === "right" && dom.voteRight.disabled) return;
  const itemId = side === "left" ? currentBattle.left.id : currentBattle.right.id;
  chooseVote(itemId).catch(showVoteError);
}

function targetIsVoteControl(event: Event): boolean {
  return event.target instanceof Element && Boolean(event.target.closest("button"));
}

function beginPanelPointer(side: "left" | "right", event: PointerEvent): void {
  if (targetIsVoteControl(event) || !currentBattle || voteInFlight) return;
  panelPointerIntent = {
    side,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
  };
}

function finishPanelPointer(side: "left" | "right", event: PointerEvent): void {
  const intent = panelPointerIntent;
  panelPointerIntent = null;
  if (!intent || intent.side !== side || intent.pointerId !== event.pointerId || targetIsVoteControl(event)) return;
  const distance = Math.hypot(event.clientX - intent.startX, event.clientY - intent.startY);
  if (distance <= PANEL_CLICK_MOVE_THRESHOLD_PX) choosePanel(side);
}

dom.leftPanel.addEventListener("pointerdown", (event) => beginPanelPointer("left", event));
dom.rightPanel.addEventListener("pointerdown", (event) => beginPanelPointer("right", event));
dom.leftPanel.addEventListener("pointerup", (event) => finishPanelPointer("left", event));
dom.rightPanel.addEventListener("pointerup", (event) => finishPanelPointer("right", event));
dom.leftPanel.addEventListener("pointercancel", () => {
  panelPointerIntent = null;
});
dom.rightPanel.addEventListener("pointercancel", () => {
  panelPointerIntent = null;
});

dom.holdButton.addEventListener("pointerdown", beginHold);
dom.holdButton.addEventListener("pointerup", cancelHold);
dom.holdButton.addEventListener("pointercancel", cancelHold);
dom.holdButton.addEventListener("pointerleave", cancelHold);

markArenaLive();
loadBattle().catch(showVoteError);
