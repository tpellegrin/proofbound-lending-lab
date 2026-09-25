/**
 * Child process used by the hold-versus-checkout concurrency test. Like
 * checkout-worker, it opens the database, prints "ready", waits for "go" on
 * stdin, then places one hold and prints the outcome as JSON. The returned item
 * is read inside the hold's own write transaction, so it records whether a loan
 * already existed when the hold took effect.
 *
 * Usage: node hold-worker.js <db> <item-id>
 */
import { BorrowDesk } from "../src/desk.js";
import { BorrowDeskError } from "../src/errors.js";

const [db = "", itemId = ""] = process.argv.slice(2);
const desk = BorrowDesk.open(db);
process.stdout.write("ready\n");

process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  let outcome: object;
  try {
    outcome = { ok: true, ...desk.hold(itemId) };
  } catch (error) {
    outcome = { ok: false, code: error instanceof BorrowDeskError ? error.code : String(error) };
  } finally {
    desk.close();
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.stdin.destroy();
});
