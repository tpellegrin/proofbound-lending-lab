import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { APPLICATION_ID, initializeDatabase, migrateDatabase, type BackupInfo } from "../src/desk.js";
import { BorrowDeskError } from "../src/errors.js";
import {
  createV0Database,
  expectError,
  expectOk,
  fileHash,
  rawSnapshot,
  runCli,
  runCliAsync,
  tempDir,
  type V0Seed,
} from "./helpers.js";

const V0_SEED: V0Seed = {
  items: [
    { id: "camera-01", name: "Mirrorless camera" },
    { id: "drill-01", name: "Cordless drill" },
    { id: "microphone-01", name: "USB microphone" },
    { id: "projector-01", name: "Portable projector" },
  ],
  loans: [
    {
      id: 1,
      itemId: "projector-01",
      borrowerId: "member-001",
      checkedOutAt: "2026-03-01T09:00:00.000Z",
      returnedAt: "2026-03-01T09:03:00.000Z",
    },
    {
      id: 2,
      itemId: "drill-01",
      borrowerId: "member-002",
      checkedOutAt: "2026-03-01T09:01:00.000Z",
      returnedAt: null,
    },
    {
      id: 3,
      itemId: "projector-01",
      borrowerId: "member-004",
      checkedOutAt: "2026-03-01T09:02:00.000Z",
      returnedAt: null,
    },
  ],
};

const WRITER = path.join(import.meta.dirname, "backup-writer.js");
const MIGRATOR = path.join(import.meta.dirname, "backup-migrate-worker.js");

interface AnnotatedError extends BorrowDeskError {
  backup?: BackupInfo | null;
  leftover?: string;
}

function assertBackupError(action: () => unknown, code: string, field?: string): AnnotatedError {
  let captured: AnnotatedError | undefined;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof BorrowDeskError, `expected BorrowDeskError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    captured = error as AnnotatedError;
    return true;
  });
  return captured as AnnotatedError;
}

function tempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

/** Best-effort cleanup: a child that already exited may reject kill() on macOS. */
function safeKill(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill();
  } catch {
    // already gone
  }
}

/** Reads complete newline-delimited lines from a child's stdout. */
function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  const lines: string[] = [];
  const pending: ((line: string) => void)[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const resolve = pending.shift();
      if (resolve) resolve(line);
      else lines.push(line);
      index = buffer.indexOf("\n");
    }
  });
  return () =>
    new Promise((resolve) => {
      const line = lines.shift();
      if (line !== undefined) resolve(line);
      else pending.push(resolve);
    });
}

test("migrate --backup on a v0 source writes a verified v0 backup and commits the migration", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const before = rawSnapshot(db);
  const dest = path.join(dir, "backup.db");

  const result = migrateDatabase(db, { backup: dest });
  assert.deepEqual(result, {
    database: db,
    fromSchemaVersion: 1,
    schemaVersion: 2,
    migrated: true,
    backup: { path: dest, created: true, verified: true, schemaVersion: 1 },
  });

  const backup = new Database(dest, { readonly: true });
  t.after(() => backup.close());
  assert.equal(backup.pragma("application_id", { simple: true }), APPLICATION_ID);
  assert.equal(backup.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(backup.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  assert.deepEqual(backup.prepare("SELECT id, name FROM items ORDER BY id").all(), before.items);
  assert.deepEqual(
    backup.prepare("SELECT id, item_id, borrower_id, checked_out_at, returned_at FROM loans ORDER BY id").all(),
    before.loans,
  );
  assert.deepEqual(backup.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all(), [
    { name: "loans", seq: 3 },
  ]);

  const after = rawSnapshot(db);
  assert.equal(after.userVersion, 2);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.loans, before.loans);
  assert.deepEqual(after.holds, []);
  assert.equal(tempFiles(dir).length, 0);
});

test("the backup preserves loan-id allocation state", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");
  migrateDatabase(db, { backup: dest });

  const backup = new Database(dest);
  t.after(() => backup.close());
  const info = backup
    .prepare("INSERT INTO loans (item_id, borrower_id, checked_out_at) VALUES (?, ?, ?)")
    .run("camera-01", "member-009", "2026-05-01T00:00:00.000Z");
  assert.equal(Number(info.lastInsertRowid), 4, "the backup allocates the next loan id the source would have");
});

test("the backup is an independent file, not a hard link", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");
  migrateDatabase(db, { backup: dest });

  const sourceStat = fs.statSync(db);
  const backupStat = fs.statSync(dest);
  assert.notEqual(sourceStat.ino, backupStat.ino);
  assert.equal(backupStat.nlink, 1);

  const sourceHash = fileHash(db);
  const backupHash = fileHash(dest);

  const backup = new Database(dest);
  backup.prepare("INSERT INTO items (id, name) VALUES (?, ?)").run("extra-01", "Extra item");
  backup.close();
  assert.equal(fileHash(db), sourceHash, "writing to the backup must not change the source");
  assert.notEqual(fileHash(dest), backupHash);
});

test("writing to the migrated source does not change the backup", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");
  migrateDatabase(db, { backup: dest });
  const backupHash = fileHash(dest);

  const desk = new Database(db);
  desk.prepare("INSERT INTO items (id, name) VALUES (?, ?)").run("later-01", "Later item");
  desk.close();
  assert.equal(fileHash(dest), backupHash, "writing to the migrated source must not change the backup");
});

test("migrate --backup refuses every bad destination without changing the source", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const hash = fileHash(db);

  const parentFile = path.join(dir, "not-a-dir");
  fs.writeFileSync(parentFile, "plain file");
  const existingDir = path.join(dir, "adir");
  fs.mkdirSync(existingDir);
  const existingFile = path.join(dir, "exists.db");
  fs.writeFileSync(existingFile, "old contents");
  const emptyFile = path.join(dir, "empty.db");
  fs.writeFileSync(emptyFile, "");
  const dangling = path.join(dir, "dangling.db");
  fs.symlinkSync(path.join(dir, "nowhere.db"), dangling);

  const cases: { name: string; dest: string; code: string }[] = [
    { name: "existing regular file", dest: existingFile, code: "OUTPUT_EXISTS" },
    { name: "empty file", dest: emptyFile, code: "OUTPUT_EXISTS" },
    { name: "existing directory", dest: existingDir, code: "INVALID_OUTPUT_PATH" },
    { name: "missing parent", dest: path.join(dir, "missing", "b.db"), code: "INVALID_OUTPUT_PATH" },
    { name: "parent is not a directory", dest: path.join(parentFile, "b.db"), code: "INVALID_OUTPUT_PATH" },
    { name: "destination is the source", dest: db, code: "INVALID_OUTPUT_PATH" },
    { name: "dangling symlink", dest: dangling, code: "OUTPUT_EXISTS" },
  ];
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const present = `${db}${suffix}`;
    fs.writeFileSync(present, "not a real journal");
    cases.push({ name: `sibling ${suffix} present`, dest: present, code: "INVALID_OUTPUT_PATH" });
  }

  for (const entry of cases) {
    assertBackupError(() => migrateDatabase(db, { backup: entry.dest }), entry.code, "backup");
  }

  for (const suffix of ["-journal", "-wal", "-shm"]) {
    fs.rmSync(`${db}${suffix}`, { force: true });
    assertBackupError(() => migrateDatabase(db, { backup: `${db}${suffix}` }), "INVALID_OUTPUT_PATH", "backup");
  }

  assert.equal(fs.readFileSync(existingFile, "utf8"), "old contents");
  assert.equal(fs.readFileSync(emptyFile, "utf8"), "");
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(fileHash(db), hash);
  assert.equal(rawSnapshot(db).userVersion, 1);
  assert.equal(tempFiles(dir).length, 0);
});

test("existing migrate refusals win over destination refusals", (t) => {
  const dir = tempDir(t);
  const missingParentDest = path.join(dir, "nope", "b.db");

  assertBackupError(
    () => migrateDatabase(path.join(dir, "missing.db"), { backup: missingParentDest }),
    "DATABASE_NOT_FOUND",
  );

  const corrupt = path.join(dir, "corrupt.db");
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: `item-${String(i).padStart(4, "0")}`,
    name: `Item number ${i} with padding so the file spans several pages`,
  }));
  createV0Database(corrupt, { items });
  const buffer = fs.readFileSync(corrupt);
  buffer[4096] = 0;
  fs.writeFileSync(corrupt, buffer);
  assertBackupError(() => migrateDatabase(corrupt, { backup: missingParentDest }), "DATABASE_CORRUPT");
});

test("migrate --backup on a v2 source ignores the destination entirely", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v2.db");
  initializeDatabase(db);
  const hash = fileHash(db);

  const oldBackup = path.join(dir, "old-backup.db");
  fs.writeFileSync(oldBackup, "old backup bytes");
  assert.deepEqual(migrateDatabase(db, { backup: oldBackup }), {
    database: db,
    fromSchemaVersion: 2,
    schemaVersion: 2,
    migrated: false,
    backup: null,
  });
  assert.equal(fs.readFileSync(oldBackup, "utf8"), "old backup bytes");

  const asDirectory = path.join(dir, "a-directory");
  fs.mkdirSync(asDirectory);
  assert.equal(migrateDatabase(db, { backup: asDirectory }).backup, null);
  assert.equal(fs.statSync(asDirectory).isDirectory(), true);

  const dangling = path.join(dir, "dangling.db");
  fs.symlinkSync(path.join(dir, "nowhere.db"), dangling);
  assert.equal(migrateDatabase(db, { backup: dangling }).backup, null);
  assert.equal(fileHash(db), hash);
});

test("a verification mismatch fails BACKUP_FAILED without publishing", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");
  const hash = fileHash(db);

  assertBackupError(
    () =>
      migrateDatabase(db, {
        backup: dest,
        onBackupStaged: (temporaryPath) => fs.writeFileSync(temporaryPath, "not a database"),
      }),
    "BACKUP_FAILED",
  );

  assert.equal(fs.existsSync(dest), false);
  assert.equal(fileHash(db), hash);
  assert.equal(rawSnapshot(db).userVersion, 1);
  assert.equal(tempFiles(dir).length, 0);
});

test("a backup creation failure fails BACKUP_FAILED without publishing", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");
  const hash = fileHash(db);

  assertBackupError(
    () =>
      migrateDatabase(db, {
        backup: dest,
        onBackupStaged: () => {
          throw new Error("injected backup failure");
        },
      }),
    "BACKUP_FAILED",
  );

  assert.equal(fs.existsSync(dest), false);
  assert.equal(fileHash(db), hash);
  assert.equal(tempFiles(dir).length, 0);
});

test("a migration failure after publication keeps the backup and reports it", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");
  const before = rawSnapshot(db);

  const error = assertBackupError(
    () =>
      migrateDatabase(db, {
        backup: dest,
        onFirstSchemaChange: () => {
          throw new BorrowDeskError("STORAGE_ERROR", "injected migration failure");
        },
      }),
    "STORAGE_ERROR",
  );
  assert.deepEqual(error.backup, { path: dest, created: true, verified: true, schemaVersion: 1 });
  assert.match(error.message, /backup was kept/);
  assert.match(error.message, /migration was not committed/);

  const backup = new Database(dest, { readonly: true });
  t.after(() => backup.close());
  assert.equal(backup.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(backup.prepare("SELECT id, name FROM items ORDER BY id").all(), before.items);

  const after = rawSnapshot(db);
  assert.equal(after.userVersion, 1);
  assert.equal(after.holds, null);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.loans, before.loans);
});

test("a destination that appears during publication is refused with OUTPUT_EXISTS", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");

  assertBackupError(
    () =>
      migrateDatabase(db, {
        backup: dest,
        onBackupStaged: () => fs.writeFileSync(dest, "concurrent file"),
      }),
    "OUTPUT_EXISTS",
    "backup",
  );

  assert.equal(fs.readFileSync(dest, "utf8"), "concurrent file");
  assert.equal(rawSnapshot(db).userVersion, 1);
  assert.equal(tempFiles(dir).length, 0);
});

test("--backup is only valid for migrate and requires a non-empty value", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);

  expectError(runCli(["--db", db, "list-items", "--backup", path.join(dir, "b.db")]), 2, "INVALID_ARGUMENTS");
  expectError(runCli(["--db", db, "migrate", "--backup"]), 2, "INVALID_ARGUMENTS");
  const error = expectError(runCli(["--db", db, "migrate", "--backup", ""]), 2, "INVALID_ARGUMENTS");
  assert.equal("backup" in error, false, "argument failures carry no backup field");
});

test("CLI migrate --backup reports the backup object and additive error fields", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");

  assert.deepEqual(expectOk(runCli(["--db", db, "migrate", "--backup", dest]), "migrate"), {
    database: db,
    fromSchemaVersion: 1,
    schemaVersion: 2,
    migrated: true,
    backup: { path: dest, created: true, verified: true, schemaVersion: 1 },
  });

  const db2 = path.join(dir, "v0b.db");
  createV0Database(db2, V0_SEED);
  const existing = path.join(dir, "existing.db");
  fs.writeFileSync(existing, "x");
  const error = expectError(runCli(["--db", db2, "migrate", "--backup", existing]), 2, "OUTPUT_EXISTS");
  assert.equal(error.field, "backup");
  assert.equal(error.backup, null);

  assert.equal("backup" in expectOk(runCli(["--db", db, "migrate"]), "migrate"), false);
});

test("a concurrent writer's committed change is included in the backup", { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");

  const writer = spawn(process.execPath, [WRITER, db]);
  const writerLine = lineReader(writer);
  const migrator = spawn(process.execPath, [MIGRATOR, db, dest]);
  const migratorLine = lineReader(migrator);
  t.after(() => {
    safeKill(writer);
    safeKill(migrator);
  });

  assert.equal(await writerLine(), "ready");
  assert.equal(await migratorLine(), "started");
  writer.stdin.write("commit\n");
  assert.equal(await writerLine(), "done");
  const outcome = JSON.parse(await migratorLine()) as { ok: boolean; migrated?: boolean };
  assert.equal(outcome.ok, true);
  assert.equal(outcome.migrated, true);

  const backup = new Database(dest, { readonly: true });
  t.after(() => backup.close());
  assert.deepEqual(backup.prepare("SELECT id, name FROM items WHERE id = ?").get("concurrent-01"), {
    id: "concurrent-01",
    name: "Concurrent item",
  });
  assert.ok(rawSnapshot(db).items.some((item) => item.id === "concurrent-01"), "the migration includes the writer");
});

test("a migrate --backup that cannot get the lock within the timeout fails DATABASE_BUSY", { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const dest = path.join(dir, "backup.db");

  const writer = spawn(process.execPath, [WRITER, db]);
  const writerLine = lineReader(writer);
  t.after(() => safeKill(writer));
  assert.equal(await writerLine(), "ready");

  const result = await runCliAsync(["--db", db, "migrate", "--backup", dest]);
  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stderr);
  assert.equal(body.error.code, "DATABASE_BUSY");
  assert.equal(body.error.backup, null);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(tempFiles(dir).length, 0);

  writer.stdin.write("rollback\n");
  assert.equal(await writerLine(), "done");
  const after = rawSnapshot(db);
  assert.equal(after.userVersion, 1);
  assert.equal(after.items.some((item) => item.id === "concurrent-01"), false);
});
