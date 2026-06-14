import { join } from "node:path";
import { processData, readArgs } from "./analysis-core.mjs";

const args = readArgs(process.argv.slice(2));

const backupRoot = args.in || args.backup || join("exports", "live-backups");
const outRoot = args.out || join("exports", "analysis");
const datasetPath = args.dataset || join("public", "data", "items.json");

try {
  const result = await processData({
    backupRoot,
    outRoot,
    datasetPath,
  });
  const totals = result.analysis.totals;
  console.log(`analysis=${result.latestDir}`);
  console.log(`run=${result.runDir}`);
  console.log(`raw_votes=${totals.totalRawVotes}`);
  console.log(`report_votes=${totals.reportRawVotes}`);
  console.log(`clean_votes=${totals.cleanVotes}`);
  console.log(`excluded_test_votes=${totals.excludedTestVotes}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
