/**
 * Child process used by the concurrency test. It opens the database, prints
 * "ready", waits for "go" on stdin, attempts one checkout and prints the
 * outcome as JSON. Holding every worker at the barrier until all are ready
 * makes the checkouts genuinely contend for the same item.
 *
 * Usage: node checkout-worker.js <db> <item-id> <borrower-id>
 */
import { BorrowDesk } from "../src/desk.js";
import { BorrowDeskError } from "../src/errors.js";

const [db = "", itemId = "", borrowerId = ""] = process.argv.slice(2);
const desk = BorrowDesk.open(db);
process.stdout.write("ready\n");

process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  let outcome: object;
  try {
    outcome = { ok: true, loanId: desk.checkout(itemId, borrowerId).id };
  } catch (error) {
    outcome = { ok: false, code: error instanceof BorrowDeskError ? error.code : String(error) };
  } finally {
    desk.close();
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.stdin.destroy();
});
