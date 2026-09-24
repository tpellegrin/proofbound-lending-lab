import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { BorrowDesk, initializeDatabase } from "../src/desk.js";
import { expectError, expectOk, runCliAsync, tempDir } from "./helpers.js";

const WORKER = path.join(import.meta.dirname, "checkout-worker.js");
const WORKERS = 8;
const ROUNDS = 3;

interface Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  outcome: Promise<{ ok: boolean; loanId?: number; code?: string }>;
}

function startWorker(db: string, itemId: string, borrowerId: string): Worker {
  const child = spawn(process.execPath, [WORKER, db, itemId, borrowerId]);
  let stdout = "";
  let stderr = "";
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.startsWith("ready\n")) markReady();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const outcome = new Promise<{ ok: boolean; loanId?: number; code?: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      const lines = stdout.trim().split("\n");
      if (status !== 0 || lines[0] !== "ready" || lines.length !== 2) {
        reject(new Error(`worker failed (exit ${status}): ${stdout} ${stderr}`));
      } else {
        resolve(JSON.parse(lines[1] as string));
      }
    });
  });
  // Surface startup failures instead of waiting forever at the barrier.
  outcome.catch(() => markReady());
  return { child, ready, outcome };
}

test("concurrent checkouts from separate processes create exactly one active loan", { timeout: 30_000 }, async (t) => {
  const db = path.join(tempDir(t), "race.db");
  initializeDatabase(db);
  const setup = BorrowDesk.open(db);
  for (let round = 0; round < ROUNDS; round++) setup.registerItem(`drill-0${round}`, `Drill ${round}`);
  setup.close();

  for (let round = 0; round < ROUNDS; round++) {
    const itemId = `drill-0${round}`;
    const workers = Array.from({ length: WORKERS }, (_, i) => startWorker(db, itemId, `member-00${i}`));
    t.after(() => workers.forEach((worker) => worker.child.kill()));

    // Barrier: every worker has opened the database before any is released.
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.stdin.write("go\n");
    const outcomes = await Promise.all(workers.map((worker) => worker.outcome));

    const winners = outcomes.filter((outcome) => outcome.ok);
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.deepEqual(
      outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.code),
      Array(WORKERS - 1).fill("ITEM_UNAVAILABLE"),
    );

    const desk = BorrowDesk.open(db);
    const active = desk.listLoans({ activeOnly: true }).filter((loan) => loan.itemId === itemId);
    const all = desk.listLoans().filter((loan) => loan.itemId === itemId);
    desk.close();
    assert.equal(active.length, 1);
    assert.equal(all.length, 1);
    assert.equal(active[0]?.id, winners[0]?.loanId);
  }
});

test("concurrent CLI checkouts: one succeeds, the rest are rejected with ITEM_UNAVAILABLE", { timeout: 30_000 }, async (t) => {
  const db = path.join(tempDir(t), "race-cli.db");
  expectOk(await runCliAsync(["--db", db, "init"]), "init");
  expectOk(await runCliAsync(["--db", db, "add-item", "camera-01", "Mirrorless camera"]), "add-item");

  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => runCliAsync(["--db", db, "checkout", "camera-01", `member-01${i}`])),
  );
  const successes = results.filter((result) => result.status === 0);
  assert.equal(successes.length, 1, results.map((result) => result.stderr).join("\n"));
  for (const result of results.filter((result) => result.status !== 0)) {
    expectError(result, 2, "ITEM_UNAVAILABLE");
  }
  const loans = expectOk(await runCliAsync(["--db", db, "list-loans", "--active"]), "list-loans").loans;
  assert.equal(loans.length, 1);
});
