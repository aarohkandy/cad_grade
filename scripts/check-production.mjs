function readArgs(argv) {
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

function deploymentUrl(value) {
  if (!value) return "";
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/\/+$/, "")}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function fail(message, detail) {
  console.error(`FAIL ${message}`);
  if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log(`OK   ${message}`);
}

const args = readArgs(process.argv.slice(2));
const baseUrl = deploymentUrl(args.url || process.env.CAPYBARA_ARENA_URL || process.env.VERCEL_URL);
const token = args.token || process.env.ADMIN_EXPORT_TOKEN;
const writeTestVote = args["write-test-vote"] === "true";

if (!baseUrl) {
  console.error("Usage: npm run check:production -- --url https://your-app.vercel.app [--token ADMIN_EXPORT_TOKEN] [--write-test-vote]");
  process.exit(1);
}

console.log(`Checking ${baseUrl}`);

const health = await fetchJson(`${baseUrl}/api/health`);
if (!health.response.ok) {
  fail(`/api/health returned ${health.response.status}`, health.body);
} else if (!health.body?.ready || health.body?.storageMode !== "blob" || health.body?.storage !== "ok") {
  fail("/api/health is not public-ready", health.body);
} else {
  pass(`/api/health ready with ${health.body.storageMode} storage`);
}

const battle = await fetchJson(`${baseUrl}/api/battle`);
if (!battle.response.ok) {
  fail(`/api/battle returned ${battle.response.status}`, battle.body);
} else if (!battle.body?.left?.id || !battle.body?.right?.id || battle.body.left.family !== battle.body.right.family) {
  fail("/api/battle returned an invalid battle", battle.body);
} else {
  pass(`/api/battle returned ${battle.body.left.id} vs ${battle.body.right.id}`);
}

const stats = await fetchJson(`${baseUrl}/api/stats`);
if (!stats.response.ok) {
  fail(`/api/stats returned ${stats.response.status}`, stats.body);
} else if (typeof stats.body?.totalVotes !== "number" || stats.body?.dataMode !== "live") {
  fail("/api/stats is not live-ready", stats.body);
} else {
  pass(`/api/stats live with ${stats.body.totalVotes} total votes`);
}

const unauthExport = await fetchJson(`${baseUrl}/api/export?format=json&limit=1`);
if (unauthExport.response.status !== 401) {
  fail("/api/export should reject missing admin token", {
    status: unauthExport.response.status,
    body: unauthExport.body,
  });
} else {
  pass("/api/export rejects missing admin token");
}

if (token) {
  const authedExport = await fetchJson(`${baseUrl}/api/export?format=json&limit=1`, {
    headers: { "x-admin-token": token },
  });
  if (!authedExport.response.ok || typeof authedExport.body?.voteCount !== "number") {
    fail("/api/export did not return admin data", {
      status: authedExport.response.status,
      body: authedExport.body,
    });
  } else {
    pass(`/api/export works with token; returned ${authedExport.body.voteCount} votes`);
  }
} else {
  console.warn("WARN Skipping authenticated export check; pass --token or ADMIN_EXPORT_TOKEN.");
}

if (writeTestVote) {
  if (!battle.response.ok || !battle.body?.left?.id || !battle.body?.right?.id) {
    fail("Cannot write test vote because battle check failed");
  } else {
    const now = Date.now();
    const vote = await fetchJson(`${baseUrl}/api/vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "user-agent": "capybara-production-check",
      },
      body: JSON.stringify({
        battle_id: battle.body.battleId,
        left_item_id: battle.body.left.id,
        right_item_id: battle.body.right.id,
        winner_item_id: battle.body.left.id,
        vote_result: "winner",
        started_at: new Date(now - 6500).toISOString(),
        models_loaded_at: new Date(now - 5000).toISOString(),
        voted_at: new Date(now).toISOString(),
        session_id: `production-check-${now}`,
      }),
    });
    if (!vote.response.ok || vote.body?.saved !== true) {
      fail("/api/vote test write failed", {
        status: vote.response.status,
        body: vote.body,
      });
    } else {
      pass("/api/vote accepted a test write; this added one real vote record");
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
pass("Production checks passed");
