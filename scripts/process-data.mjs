import { join } from "node:path";
import { backupVoteFiles, processData, readArgs } from "./analysis-core.mjs";

const args = readArgs(process.argv.slice(2));

const backupRoot = args.in || args.backup || join("exports", "live-backups");
const outRoot = args.out || join("exports", "analysis");
const datasetPath = args.dataset || join("public", "data", "items.json");

// Testing for the directory is not enough: the launchd installer creates
// exports/live-backups/logs, and an empty tree analyzes to zero votes and exits 0.
if (!(await backupVoteFiles(backupRoot)).length) {
  console.error(`No vote snapshots under ${backupRoot}. Run \`npm run backup:live\` first, or pass --in <dir>.`);
  process.exitCode = 1;
} else {
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
}
