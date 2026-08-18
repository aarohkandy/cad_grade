import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import battleHandler from "../api/battle";
import { SUMMARY_PATH } from "../src/server/voteStore";

const GRADER_ONLY_FIELDS = [
  "validation",
  "experimentId",
  "modelName",
  "provider",
  "latencyMs",
  "sourceHash",
  "seedId",
  "specificityLevel",
] as const;

interface BattleBody {
  battleId: string;
  left: Record<string, unknown>;
  right: Record<string, unknown>;
  stats: { historyAvailable: boolean; dataMode: string };
}

function mockResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string | number | string[]>,
    setHeader(key: string, value: string | number | string[]) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response;
}

async function requestBattle() {
  const response = mockResponse();
  await battleHandler({ method: "GET", headers: {}, query: {} } as never, response as never);
  expect(response.statusCode).toBe(200);
  return response.body as BattleBody;
}

describe("battle api", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capybara-battle-"));
    process.env.LOCAL_VOTE_DIR = tempDir;
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    vi.restoreAllMocks();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("ships only what the browser needs to render and vote", async () => {
    const battle = await requestBattle();

    for (const side of [battle.left, battle.right]) {
      for (const field of GRADER_ONLY_FIELDS) {
        expect(side).not.toHaveProperty(field);
      }
      expect(side).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        familyLabel: expect.any(String),
        stlUrl: expect.any(String),
        previewUrl: expect.any(String),
      });
    }

    // The validator's prose is the most damaging field to leak: it tells the
    // voter which model the arena thinks is correct before they pick one.
    expect(JSON.stringify(battle)).not.toContain("brief_reason");
  });

  it("reports history as available when the summary reads cleanly", async () => {
    const battle = await requestBattle();
    expect(battle.stats.historyAvailable).toBe(true);
  });

  it("still serves a battle when the vote summary cannot be read, and says so", async () => {
    const summaryFile = join(tempDir, SUMMARY_PATH);
    await mkdir(dirname(summaryFile), { recursive: true });
    await writeFile(summaryFile, "{ not json", "utf8");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const battle = await requestBattle();

    expect(battle.battleId).toEqual(expect.any(String));
    expect(battle.left.id).not.toBe(battle.right.id);
    expect(battle.stats.historyAvailable).toBe(false);
    expect(logged).toHaveBeenCalled();
  });
});
