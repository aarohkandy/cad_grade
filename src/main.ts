import "./styles.css";
import dataset from "./data/items.generated.json";
import { StlViewer } from "./client/stlViewer";
import type { ArenaFamily, ArenaItem, BattleResponse, HoldChallenge, PublicStats, VoteResponse } from "./shared/types";

const SESSION_KEY = "capybara-arena-session";
const SEEN_PAIRS_KEY = "capybara-arena-seen-pairs";

interface CurrentBattle extends BattleResponse {
  localOnly?: boolean;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");

app.innerHTML = `
  <header class="hero" id="top">
    <nav class="top-bar" aria-label="Primary">
      <a class="brand-lockup" href="#top" aria-label="Capybara Arena home">
        <span class="brand-word">CAPYBARA ARENA</span>
      </a>
      <div class="nav-actions">
        <button class="nav-action primary-action" id="start-now" type="button">Start now</button>
      </div>
    </nav>
    <main class="hero-center">
      <h1>cad arena</h1>
    </main>
  </header>

  <main class="arena-shell" id="arena">
    <section class="arena-head" aria-label="Arena controls">
      <div>
        <p class="kicker">Public CAD grading</p>
        <h2>Pick the better generated model.</h2>
      </div>
      <div class="arena-controls">
        <button type="button" class="ghost-action" id="next-battle">Skip</button>
      </div>
    </section>

    <section class="stat-row" aria-label="Public stats">
      <div><span>Total votes</span><strong id="total-votes">0</strong></div>
      <div><span>Models</span><strong id="item-count">${dataset.itemCount}</strong></div>
      <div><span>Storage</span><strong id="data-mode">local</strong></div>
    </section>

    <section class="battle-grid" aria-live="polite">
      <article class="model-panel" data-side="left">
        <div class="panel-top">
          <div>
            <p>Model A</p>
            <h3 id="left-title">Loading</h3>
          </div>
          <span id="left-badge">3D</span>
        </div>
        <div class="viewer-frame">
          <canvas id="left-canvas"></canvas>
          <div class="viewer-status" id="left-status">Loading STL</div>
        </div>
        <button type="button" class="vote-action" id="vote-left" disabled>Choose A</button>
        <div class="reveal" id="left-reveal"></div>
      </article>

      <article class="model-panel" data-side="right">
        <div class="panel-top">
          <div>
            <p>Model B</p>
            <h3 id="right-title">Loading</h3>
          </div>
          <span id="right-badge">3D</span>
        </div>
        <div class="viewer-frame">
          <canvas id="right-canvas"></canvas>
          <div class="viewer-status" id="right-status">Loading STL</div>
        </div>
        <button type="button" class="vote-action" id="vote-right" disabled>Choose B</button>
        <div class="reveal" id="right-reveal"></div>
      </article>
    </section>

    <section class="hold-panel is-hidden" id="hold-panel" aria-label="Hold to verify">
      <div>
        <p class="kicker">Hold to verify</p>
        <h2 id="hold-title">Lock in your vote</h2>
      </div>
      <button type="button" id="hold-button" class="hold-button">
        <span id="hold-fill"></span>
        <strong id="hold-label">Hold</strong>
      </button>
    </section>

    <section class="feedback-panel is-hidden" id="feedback-panel">
      <p class="kicker">Arena pulse</p>
      <h2 id="feedback-title">Vote saved</h2>
      <p id="feedback-copy"></p>
      <button type="button" class="primary-action next-action" id="continue-battle">Next battle</button>
    </section>
  </main>
`;

const dom = {
  arena: document.querySelector("#arena") as HTMLElement,
  startNow: document.querySelector("#start-now") as HTMLButtonElement,
  nextBattle: document.querySelector("#next-battle") as HTMLButtonElement,
  continueBattle: document.querySelector("#continue-battle") as HTMLButtonElement,
  totalVotes: document.querySelector("#total-votes") as HTMLElement,
  dataMode: document.querySelector("#data-mode") as HTMLElement,
  leftCanvas: document.querySelector("#left-canvas") as HTMLCanvasElement,
  rightCanvas: document.querySelector("#right-canvas") as HTMLCanvasElement,
  leftTitle: document.querySelector("#left-title") as HTMLElement,
  rightTitle: document.querySelector("#right-title") as HTMLElement,
  leftStatus: document.querySelector("#left-status") as HTMLElement,
  rightStatus: document.querySelector("#right-status") as HTMLElement,
  leftBadge: document.querySelector("#left-badge") as HTMLElement,
  rightBadge: document.querySelector("#right-badge") as HTMLElement,
  voteLeft: document.querySelector("#vote-left") as HTMLButtonElement,
  voteRight: document.querySelector("#vote-right") as HTMLButtonElement,
  leftReveal: document.querySelector("#left-reveal") as HTMLElement,
  rightReveal: document.querySelector("#right-reveal") as HTMLElement,
  holdPanel: document.querySelector("#hold-panel") as HTMLElement,
  holdButton: document.querySelector("#hold-button") as HTMLButtonElement,
  holdFill: document.querySelector("#hold-fill") as HTMLElement,
  holdLabel: document.querySelector("#hold-label") as HTMLElement,
  feedbackPanel: document.querySelector("#feedback-panel") as HTMLElement,
  feedbackTitle: document.querySelector("#feedback-title") as HTMLElement,
  feedbackCopy: document.querySelector("#feedback-copy") as HTMLElement,
};

let currentBattle: CurrentBattle | null = null;
let selectedWinnerId: string | null = null;
let battleStartedAt = "";
let modelsLoadedAt = "";
let leftViewer: StlViewer | null = null;
let rightViewer: StlViewer | null = null;
let holdStartedAt = 0;
let holdFrame = 0;

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
  const family =
    ([...dataset.families] as ArenaFamily[])
      .map((candidateFamily) => {
        const familyItems = (dataset.items as ArenaItem[]).filter((item) => item.family === candidateFamily);
        const pairs = allLocalPairs(familyItems);
        const availablePairs = pairs.filter(([left, right]) => !priorPairs.has(pairKeyClient(left.id, right.id)));
        const averageBattles =
          familyItems.reduce((sum, item) => sum + (seenItemBattles.get(item.id) || 0), 0) /
          Math.max(1, familyItems.length);
        return {
          family: candidateFamily,
          score: (availablePairs.length ? 0 : 10_000) + averageBattles * 100 + Math.random(),
        };
      })
      .sort((left, right) => left.score - right.score)[0]?.family || "wall_planter";
  const items = (dataset.items as ArenaItem[]).filter((item) => item.family === family);
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

async function loadStats(): Promise<void> {
  try {
    const stats = await getJson<PublicStats>("/api/stats");
    dom.totalVotes.textContent = String(stats.totalVotes);
    dom.dataMode.textContent = stats.dataMode;
  } catch {
    dom.totalVotes.textContent = "0";
    dom.dataMode.textContent = "local";
  }
}

function clearFeedback(): void {
  dom.feedbackPanel.classList.add("is-hidden");
  dom.holdPanel.classList.add("is-hidden");
  dom.leftReveal.textContent = "";
  dom.rightReveal.textContent = "";
  selectedWinnerId = null;
}

function revealPrompt(target: HTMLElement, item: ArenaItem): void {
  target.innerHTML = `
    <strong>${item.familyLabel} prompt ${item.specificityLevel ?? "?"}/10</strong>
    <span>${item.prompt}</span>
  `;
}

async function loadBattle(): Promise<void> {
  clearFeedback();
  battleStartedAt = new Date().toISOString();
  modelsLoadedAt = "";
  dom.voteLeft.disabled = true;
  dom.voteRight.disabled = true;
  dom.leftStatus.textContent = "Loading STL";
  dom.rightStatus.textContent = "Loading STL";
  dom.leftStatus.classList.remove("is-hidden");
  dom.rightStatus.classList.remove("is-hidden");
  dom.leftTitle.textContent = "Loading";
  dom.rightTitle.textContent = "Loading";

  try {
    const params = new URLSearchParams({
      session_id: sessionId(),
      seen_pairs: [...seenPairs()].slice(-500).join(","),
    });
    currentBattle = await getJson<CurrentBattle>(`/api/battle?${params}`);
  } catch {
    currentBattle = localBattle();
  }

  dom.leftTitle.textContent = currentBattle.left.familyLabel;
  dom.rightTitle.textContent = currentBattle.right.familyLabel;
  dom.leftBadge.textContent = currentBattle.left.seedId.replace(/^[a-z]+_/, "").replaceAll("_", " ");
  dom.rightBadge.textContent = currentBattle.right.seedId.replace(/^[a-z]+_/, "").replaceAll("_", " ");

  leftViewer?.dispose();
  rightViewer?.dispose();
  leftViewer = new StlViewer(dom.leftCanvas);
  rightViewer = new StlViewer(dom.rightCanvas);

  try {
    await Promise.all([
      leftViewer.load(currentBattle.left.stlUrl, currentBattle.left.title),
      rightViewer.load(currentBattle.right.stlUrl, currentBattle.right.title),
    ]);
    modelsLoadedAt = new Date().toISOString();
    dom.leftStatus.classList.add("is-hidden");
    dom.rightStatus.classList.add("is-hidden");
    dom.voteLeft.disabled = false;
    dom.voteRight.disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load STL";
    dom.leftStatus.textContent = message;
    dom.rightStatus.textContent = message;
  }
}

function startHold(winnerId: string): void {
  if (!currentBattle) return;
  selectedWinnerId = winnerId;
  dom.holdPanel.classList.remove("is-hidden");
  dom.holdLabel.textContent = `Hold ${Math.round(currentBattle.hold.targetMs / 100) / 10}s`;
  dom.holdFill.style.transform = "scaleX(0)";
  dom.holdButton.focus();
  dom.holdPanel.scrollIntoView({ block: "center", behavior: "smooth" });
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
  if (!currentBattle || !selectedWinnerId) return;
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

async function finishHold(heldMs: number): Promise<void> {
  if (!currentBattle || !selectedWinnerId) return;
  cancelAnimationFrame(holdFrame);
  dom.holdButton.classList.remove("holding");
  dom.holdButton.disabled = true;
  dom.holdLabel.textContent = "Saving";
  const response = currentBattle.localOnly
    ? ({
        saved: true,
        acceptedForScoring: false,
        agreementPercent: Math.round(52 + Math.random() * 36),
        agreementLabel: "Vote held locally. Deploy with Blob connected to collect public votes.",
        dataMode: "local",
        qualityFlags: ["local_preview"],
      } satisfies VoteResponse)
    : await postJson<VoteResponse>("/api/vote", {
        battle_id: currentBattle.battleId,
        left_item_id: currentBattle.left.id,
        right_item_id: currentBattle.right.id,
        winner_item_id: selectedWinnerId,
        started_at: battleStartedAt,
        models_loaded_at: modelsLoadedAt || new Date().toISOString(),
        voted_at: new Date().toISOString(),
        session_id: sessionId(),
        hold: {
          ...currentBattle.hold,
          heldMs: Math.round(heldMs),
        },
      });

  rememberPair(currentBattle.left.id, currentBattle.right.id);
  dom.holdButton.disabled = false;
  dom.holdPanel.classList.add("is-hidden");
  dom.feedbackPanel.classList.remove("is-hidden");
  dom.feedbackTitle.textContent = response.acceptedForScoring ? "Vote saved" : "Vote saved with flags";
  dom.feedbackCopy.textContent = response.agreementLabel;
  revealPrompt(dom.leftReveal, currentBattle.left);
  revealPrompt(dom.rightReveal, currentBattle.right);
  await loadStats();
}

function showVoteError(error: unknown): void {
  dom.holdButton.disabled = false;
  dom.holdLabel.textContent = "Try again";
  dom.feedbackPanel.classList.remove("is-hidden");
  dom.feedbackTitle.textContent = "Vote did not save";
  dom.feedbackCopy.textContent = error instanceof Error ? error.message : "Something went wrong.";
}

dom.startNow.addEventListener("click", () => {
  dom.arena.scrollIntoView({ behavior: "smooth" });
});

dom.nextBattle.addEventListener("click", () => {
  loadBattle().catch(showVoteError);
});

dom.continueBattle.addEventListener("click", () => {
  loadBattle().catch(showVoteError);
});

dom.voteLeft.addEventListener("click", () => {
  if (currentBattle) startHold(currentBattle.left.id);
});

dom.voteRight.addEventListener("click", () => {
  if (currentBattle) startHold(currentBattle.right.id);
});

dom.holdButton.addEventListener("pointerdown", beginHold);
dom.holdButton.addEventListener("pointerup", cancelHold);
dom.holdButton.addEventListener("pointercancel", cancelHold);
dom.holdButton.addEventListener("pointerleave", cancelHold);

loadStats().catch(() => undefined);
loadBattle().catch(showVoteError);
