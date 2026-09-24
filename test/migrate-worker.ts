/**
 * Child process used by the concurrent-migration test. It prints "ready", waits
 * for "go" on stdin, then runs one `migrateDatabase` and prints the outcome as
 * JSON. Holding every worker at the barrier until all are ready makes the
 * migrations genuinely contend for the same file.
 *
 * Usage: node migrate-worker.js <db>
 */
import { migrateDatabase } from "../src/desk.js";
import { BorrowDeskError } from "../src/errors.js";

const [db = ""] = process.argv.slice(2);
process.stdout.write("ready\n");

process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  let outcome: object;
  try {
    outcome = { ok: true, ...migrateDatabase(db) };
  } catch (error) {
    outcome = { ok: false, code: error instanceof BorrowDeskError ? error.code : String(error) };
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.stdin.destroy();
});
