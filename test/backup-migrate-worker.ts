/**
 * Child process used by the backup concurrency tests. Runs one
 * `migrateDatabase(db, { backup: destination })` and prints "started", then the
 * outcome as a JSON line.
 *
 * Usage: node backup-migrate-worker.js <db> <destination>
 */
import { migrateDatabase } from "../src/desk.js";
import { BorrowDeskError } from "../src/errors.js";

const [db = "", destination = ""] = process.argv.slice(2);
process.stdout.write("started\n");

try {
  const result = migrateDatabase(db, { backup: destination });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  const annotated = error as { backup?: unknown; leftover?: unknown };
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: error instanceof BorrowDeskError ? error.code : String(error),
      backup: annotated.backup ?? null,
      ...(annotated.leftover === undefined ? {} : { leftover: annotated.leftover }),
    })}\n`,
  );
}
