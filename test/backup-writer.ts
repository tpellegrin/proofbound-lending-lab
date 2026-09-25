/**
 * Child process used by the backup concurrency tests. It opens a v0 database,
 * takes the write lock (`BEGIN IMMEDIATE`) and performs one uncommitted insert,
 * then prints "ready" and waits for "commit" or "rollback" on stdin. Holding the
 * lock at the barrier makes a concurrent `migrate --backup` genuinely contend.
 *
 * Usage: node backup-writer.js <db>
 */
import Database from "better-sqlite3";

const [db = ""] = process.argv.slice(2);
const connection = new Database(db, { timeout: 5000 });
connection.exec("BEGIN IMMEDIATE");
connection.prepare("INSERT INTO items (id, name) VALUES (?, ?)").run("concurrent-01", "Concurrent item");
process.stdout.write("ready\n");

process.stdin.setEncoding("utf8");
process.stdin.once("data", (chunk: string) => {
  const action = chunk.toString().trim();
  if (action === "commit") connection.exec("COMMIT");
  else connection.exec("ROLLBACK");
  process.stdout.write("done\n");
  connection.close();
  process.stdin.destroy();
});
