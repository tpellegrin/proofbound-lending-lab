/**
 * Repeatable demonstration: drives the compiled CLI (dist/cli.js) as separate
 * processes against a brand-new database, then writes an HTML dashboard.
 *
 * Usage: node dist/demo.js [--out <new-directory>]
 * Without --out, a fresh directory is created under demo-output/.
 * An existing directory is never reused.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const CLI = path.join(import.meta.dirname, "cli.js");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function createWorkspace(out: string | undefined): string {
  if (out === undefined) {
    const parent = path.join(REPO_ROOT, "demo-output");
    fs.mkdirSync(parent, { recursive: true });
    return fs.mkdtempSync(path.join(parent, "run-"));
  }
  const target = path.resolve(out);
  if (fs.existsSync(target)) {
    throw new Error(`${target} already exists; the demo needs a directory that does not exist yet`);
  }
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function shellQuote(arg: string): string {
  return /^[\w./:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function main(): void {
  const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
  const workspace = createWorkspace(values.out);
  const db = path.join(workspace, "borrowdesk.db");
  const report = path.join(workspace, "dashboard.html");

  console.log(`BorrowDesk demo workspace: ${workspace}`);
  console.log(`Commands below run as: node dist/cli.js --db "$DB" ...   with DB=${db}`);

  const run = (args: string[], expectedExit = 0): any => {
    console.log(`\n$ node dist/cli.js --db "$DB" ${args.map(shellQuote).join(" ")}`);
    const result = spawnSync(process.execPath, [CLI, "--db", db, ...args], { encoding: "utf8" });
    process.stdout.write(result.stdout);
    process.stdout.write(result.stderr);
    if (result.status !== expectedExit) {
      throw new Error(`Expected exit code ${expectedExit}, got ${result.status}`);
    }
    return JSON.parse(expectedExit === 0 ? result.stdout : result.stderr);
  };

  run(["init"]);
  run(["add-item", "projector-01", "Portable projector"]);
  run(["add-item", "drill-01", "Cordless drill"]);
  run(["add-item", "camera-01", "Mirrorless camera"]);
  run(["add-item", "microphone-01", "USB microphone"]);

  const projectorLoan = run(["checkout", "projector-01", "member-001"]).data.loan.id;
  run(["checkout", "drill-01", "member-002"]);

  console.log("\n# The drill is already on loan, so a second checkout is rejected (exit code 2):");
  run(["checkout", "drill-01", "member-003"], 2);

  run(["return", String(projectorLoan)]);
  console.log("\n# Lending the projector again creates a new loan; the returned one stays in history:");
  run(["checkout", "projector-01", "member-004"]);

  console.log("\n# A maintenance hold blocks a new checkout until it is released:");
  run(["hold", "microphone-01"]);
  run(["checkout", "microphone-01", "member-005"], 2);
  run(["release", "microphone-01"]);

  const items = run(["list-items"]).data.items as { id: string; available: boolean; held: boolean; activeLoan: unknown }[];
  run(["list-loans", "--active"]);
  const loans = run(["list-loans"]).data.loans as { status: string }[];
  const reportResult = run(["report", "--out", report]).data;

  const available = items.filter((item) => item.available).map((item) => item.id);
  const onLoan = items.filter((item) => item.activeLoan !== null).map((item) => item.id);
  const returned = loans.filter((loan) => loan.status === "returned").length;
  if (available.length === 0 || onLoan.length === 0 || returned === 0 || returned === loans.length) {
    throw new Error("Demo did not reach the expected mix of available/borrowed items and active/returned loans");
  }

  console.log(`
Demo complete.
  Available: ${available.join(", ")}
  On loan:   ${onLoan.join(", ")}
  Loans:     ${loans.length} recorded (${loans.length - returned} active, ${returned} returned)
  Database:  ${db}
  Dashboard: ${reportResult.path}`);
}

try {
  main();
} catch (error) {
  console.error(`Demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
