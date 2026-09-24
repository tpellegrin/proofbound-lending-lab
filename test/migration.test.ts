import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { APPLICATION_ID, BorrowDesk, initializeDatabase, migrateDatabase } from "../src/desk.js";
import {
  createV0Database,
  expectError,
  expectOk,
  fileHash,
  rawSnapshot,
  runCli,
  steppingClock,
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

test("init creates version 2 and is idempotent", (t) => {
  const file = path.join(tempDir(t), "new.db");
  assert.deepEqual(initializeDatabase(file), {
    database: file,
    schemaVersion: 2,
    alreadyInitialized: false,
    migrationRequired: false,
  });
  const raw = rawSnapshot(file);
  assert.equal(raw.applicationId, APPLICATION_ID);
  assert.equal(raw.userVersion, 2);
  assert.ok(raw.holds !== null, "version 2 has a holds table");
  assert.deepEqual(initializeDatabase(file), {
    database: file,
    schemaVersion: 2,
    alreadyInitialized: true,
    migrationRequired: false,
  });
});

test("init on a v0 database is a no-op that reports migrationRequired", (t) => {
  const file = path.join(tempDir(t), "v0.db");
  createV0Database(file, V0_SEED);
  const hash = fileHash(file);
  assert.deepEqual(initializeDatabase(file), {
    database: file,
    schemaVersion: 1,
    alreadyInitialized: true,
    migrationRequired: true,
  });
  assert.equal(fileHash(file), hash);
  const raw = rawSnapshot(file);
  assert.equal(raw.userVersion, 1);
  assert.equal(raw.holds, null);
});

test("ordinary CLI commands, including read-only ones, refuse v0 with MIGRATION_REQUIRED", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);
  const hash = fileHash(db);

  const invocations: string[][] = [
    ["list-items"],
    ["list-loans"],
    ["list-loans", "--active"],
    ["add-item", "saw-01", "Circular saw"],
    ["hold", "drill-01"],
    ["release", "drill-01"],
    ["checkout", "camera-01", "member-001"],
    ["return", "2"],
  ];
  for (const args of invocations) {
    const error = expectError(runCli(["--db", db, ...args]), 2, "MIGRATION_REQUIRED");
    assert.match(error.message, /migrate/);
  }
  const out = path.join(dir, "report.html");
  expectError(runCli(["--db", db, "report", "--out", out]), 2, "MIGRATION_REQUIRED");
  assert.equal(fs.existsSync(out), false, "refused report must not write its output");
  assert.equal(fileHash(db), hash);
});

test("migrate upgrades v0 to version 2, preserving records and starting items unheld", (t) => {
  const file = path.join(tempDir(t), "v0.db");
  createV0Database(file, V0_SEED);
  const before = rawSnapshot(file);

  assert.deepEqual(migrateDatabase(file), {
    database: file,
    fromSchemaVersion: 1,
    schemaVersion: 2,
    migrated: true,
  });

  const after = rawSnapshot(file);
  assert.equal(after.applicationId, APPLICATION_ID);
  assert.equal(after.userVersion, 2);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.loans, before.loans);
  assert.deepEqual(after.holds, []);
  assert.ok(after.schema.some((entry) => entry.name === "loans_one_active_per_item"));
  assert.ok(after.schema.some((entry) => entry.name === "holds"));

  const desk = BorrowDesk.open(file);
  t.after(() => desk.close());
  assert.deepEqual(
    desk.listItems().map((item) => [item.id, item.held, item.available, item.status]),
    [
      ["camera-01", false, true, "available"],
      ["drill-01", false, false, "on_loan"],
      ["microphone-01", false, true, "available"],
      ["projector-01", false, false, "on_loan"],
    ],
  );
  assert.deepEqual(
    desk.listLoans().map((loan) => [loan.id, loan.itemId, loan.borrowerId, loan.checkedOutAt, loan.returnedAt]),
    V0_SEED.loans?.map((loan) => [loan.id, loan.itemId, loan.borrowerId, loan.checkedOutAt, loan.returnedAt]),
  );
});

test("a v0 outstanding loan is returnable after migration, preserving id and checkedOutAt", (t) => {
  const file = path.join(tempDir(t), "v0.db");
  createV0Database(file, V0_SEED);
  migrateDatabase(file);

  const desk = BorrowDesk.open(file, { now: steppingClock("2026-04-01T10:00:00.000Z") });
  t.after(() => desk.close());
  const returned = desk.returnLoan(2);
  assert.equal(returned.id, 2);
  assert.equal(returned.checkedOutAt, "2026-03-01T09:01:00.000Z");
  assert.equal(returned.returnedAt, "2026-04-01T10:00:00.000Z");
  assert.equal(returned.status, "returned");
  assert.equal(desk.listItems().find((item) => item.id === "drill-01")?.available, true);
});

test("migrate on a version 2 database is an idempotent success", (t) => {
  const file = path.join(tempDir(t), "v2.db");
  initializeDatabase(file);
  const hash = fileHash(file);
  assert.deepEqual(migrateDatabase(file), {
    database: file,
    fromSchemaVersion: 2,
    schemaVersion: 2,
    migrated: false,
  });
  assert.equal(fileHash(file), hash);
});

test("a failure during migration rolls back to an identical v0 database", (t) => {
  const file = path.join(tempDir(t), "v0.db");
  createV0Database(file, V0_SEED);
  const before = rawSnapshot(file);
  const hash = fileHash(file);

  assert.throws(
    () =>
      migrateDatabase(file, {
        onFirstSchemaChange: () => {
          throw new Error("injected migration failure");
        },
      }),
    /injected migration failure/,
  );

  const after = rawSnapshot(file);
  assert.deepEqual(after, before);
  assert.equal(after.userVersion, 1);
  assert.equal(after.holds, null);
  assert.equal(fileHash(file), hash);

  // The database is still a valid v0 database that can be migrated later.
  assert.equal(migrateDatabase(file).migrated, true);
});

test("migrate refuses missing, empty, foreign and unknown-version files without replacement", (t) => {
  const dir = tempDir(t);

  const missing = path.join(dir, "missing.db");
  assert.throws(() => migrateDatabase(missing), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, "DATABASE_NOT_FOUND");
    return true;
  });
  assert.equal(fs.existsSync(missing), false);

  const empty = path.join(dir, "empty.db");
  fs.writeFileSync(empty, "");
  const emptyHash = fileHash(empty);
  assert.throws(() => migrateDatabase(empty), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "DATABASE_NOT_INITIALIZED");
    return true;
  });
  assert.equal(fileHash(empty), emptyHash);

  const text = path.join(dir, "notes.txt");
  fs.writeFileSync(text, "not a database, just some text that is long enough to have a header".repeat(3));
  const textHash = fileHash(text);
  assert.throws(() => migrateDatabase(text), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "NOT_A_BORROWDESK_DATABASE");
    return true;
  });
  assert.equal(fileHash(text), textHash);

  const foreign = path.join(dir, "foreign.db");
  const raw = new Database(foreign);
  raw.exec("CREATE TABLE things (x TEXT)");
  raw.close();
  const foreignHash = fileHash(foreign);
  assert.throws(() => migrateDatabase(foreign), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "NOT_A_BORROWDESK_DATABASE");
    return true;
  });
  assert.equal(fileHash(foreign), foreignHash);

  const future = path.join(dir, "future.db");
  initializeDatabase(future);
  const bump = new Database(future);
  bump.pragma("user_version = 3");
  bump.close();
  const futureHash = fileHash(future);
  assert.throws(() => migrateDatabase(future), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "UNSUPPORTED_SCHEMA_VERSION");
    return true;
  });
  assert.equal(fileHash(future), futureHash);
});

test("migrate refuses a corrupt BorrowDesk database with DATABASE_CORRUPT, byte-identically", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "corrupt.db");
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: `item-${String(i).padStart(4, "0")}`,
    name: `Item number ${i} with padding so the file spans several pages`,
  }));
  createV0Database(file, { items });

  const buffer = fs.readFileSync(file);
  assert.ok(buffer.length >= 8192, "fixture should span more than one page");
  buffer[4096] = 0; // invalidate the b-tree page type of page 2
  fs.writeFileSync(file, buffer);
  const hash = fileHash(file);

  assert.throws(() => migrateDatabase(file), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "DATABASE_CORRUPT");
    return true;
  });
  assert.equal(fileHash(file), hash);
  const check = new Database(file, { readonly: true });
  t.after(() => check.close());
  assert.equal(check.pragma("user_version", { simple: true }), 1);
});

test("ordinary commands keep v0's corruption classification (STORAGE_ERROR, exit 1)", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "corrupt-v2.db");
  initializeDatabase(db);
  const desk = BorrowDesk.open(db);
  for (let i = 0; i < 200; i++) {
    desk.registerItem(`item-${String(i).padStart(4, "0")}`, `Item number ${i} with padding so the file spans pages`);
  }
  desk.close();

  const buffer = fs.readFileSync(db);
  assert.ok(buffer.length >= 8192, "fixture should span more than one page");
  buffer[4096] = 0;
  fs.writeFileSync(db, buffer);

  expectError(runCli(["--db", db, "list-items"]), 1, "STORAGE_ERROR");
});

test("CLI migrate and init on v0 report the shared envelopes", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "v0.db");
  createV0Database(db, V0_SEED);

  assert.deepEqual(expectOk(runCli(["--db", db, "init"]), "init"), {
    database: db,
    schemaVersion: 1,
    alreadyInitialized: true,
    migrationRequired: true,
  });

  assert.deepEqual(expectOk(runCli(["--db", db, "migrate"]), "migrate"), {
    database: db,
    fromSchemaVersion: 1,
    schemaVersion: 2,
    migrated: true,
  });

  // Ordinary commands work once migrated, and a second migrate is idempotent.
  expectOk(runCli(["--db", db, "list-items"]), "list-items");
  assert.deepEqual(expectOk(runCli(["--db", db, "migrate"]), "migrate"), {
    database: db,
    fromSchemaVersion: 2,
    schemaVersion: 2,
    migrated: false,
  });
});

const MIGRATE_WORKER = path.join(import.meta.dirname, "migrate-worker.js");
const MIGRATE_WORKERS = 6;

interface MigrateOutcome {
  ok: boolean;
  migrated?: boolean;
  fromSchemaVersion?: number;
  schemaVersion?: number;
  code?: string;
}

interface MigrateWorker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  outcome: Promise<MigrateOutcome>;
}

function startMigrateWorker(db: string): MigrateWorker {
  const child = spawn(process.execPath, [MIGRATE_WORKER, db]);
  let stdout = "";
  let stderr = "";
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.startsWith("ready\n")) markReady();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const outcome = new Promise<MigrateOutcome>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      const lines = stdout.trim().split("\n");
      if (status !== 0 || lines[0] !== "ready" || lines.length !== 2) {
        reject(new Error(`migrate worker failed (exit ${status}): ${stdout} ${stderr}`));
      } else {
        resolve(JSON.parse(lines[1] as string) as MigrateOutcome);
      }
    });
  });
  // Surface startup failures instead of waiting forever at the barrier.
  outcome.catch(() => markReady());
  return { child, ready, outcome };
}

test("concurrent migrations on one v0 file: all succeed, exactly one migrates", { timeout: 30_000 }, async (t) => {
  const file = path.join(tempDir(t), "v0.db");
  createV0Database(file, V0_SEED);
  const before = rawSnapshot(file);

  const workers = Array.from({ length: MIGRATE_WORKERS }, () => startMigrateWorker(file));
  t.after(() => workers.forEach((worker) => worker.child.kill()));

  // Barrier: every worker has opened the database before any is released.
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.write("go\n");
  const outcomes = await Promise.all(workers.map((worker) => worker.outcome));

  assert.deepEqual(
    outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.code),
    [],
    JSON.stringify(outcomes),
  );
  const migrated = outcomes.filter((outcome) => outcome.migrated === true);
  assert.equal(migrated.length, 1, JSON.stringify(outcomes));
  assert.equal(migrated[0]?.fromSchemaVersion, 1);
  for (const outcome of outcomes.filter((outcome) => outcome.migrated !== true)) {
    assert.equal(outcome.fromSchemaVersion, 2);
  }
  for (const outcome of outcomes) assert.equal(outcome.schemaVersion, 2);

  const after = rawSnapshot(file);
  assert.equal(after.userVersion, 2);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.loans, before.loans);
  assert.deepEqual(after.holds, []);
});
