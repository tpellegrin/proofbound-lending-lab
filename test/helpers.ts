import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import {
  APPLICATION_ID,
  BorrowDesk,
  V0_SCHEMA_VERSION,
  initializeDatabase,
  type OpenOptions,
} from "../src/desk.js";
import { BorrowDeskError, type ErrorCode } from "../src/errors.js";

// Compiled helpers live in dist-test/test/, so the repository root is two levels up.
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CLI = path.join(REPO_ROOT, "dist", "cli.js");

/** Creates a temporary directory that is removed when the test finishes. */
export function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "borrowdesk-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A deterministic clock: each call returns the next minute after `start`. */
export function steppingClock(start = "2026-03-01T09:00:00.000Z"): () => Date {
  let next = Date.parse(start);
  return () => {
    const now = new Date(next);
    next += 60_000;
    return now;
  };
}

/** Initializes a database in a temporary directory and opens it. */
export function newDesk(
  t: TestContext,
  options: OpenOptions = {},
): { desk: BorrowDesk; file: string; dir: string } {
  const dir = tempDir(t);
  const file = path.join(dir, "desk.db");
  initializeDatabase(file);
  const desk = BorrowDesk.open(file, options);
  t.after(() => desk.close());
  return { desk, file, dir };
}

/** Domain state as seen through the public API. */
export function domainState(desk: BorrowDesk) {
  return { items: desk.listItems(), loans: desk.listLoans() };
}

export function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function assertRejects(action: () => unknown, code: ErrorCode, field?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof BorrowDeskError, `expected BorrowDeskError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runCliAsync(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Asserts a successful CLI result and returns its `data` payload. */
export function expectOk(result: CliResult, command: string): any {
  assert.equal(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.command, command);
  return body.data;
}

/** Asserts a failed CLI result with the given exit code and error code; returns the error object. */
export function expectError(result: CliResult, exitCode: 1 | 2, code: string): any {
  assert.equal(result.status, exitCode, `expected exit ${exitCode}; stdout: ${result.stdout} stderr: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /\n\s+at /, "stderr must not contain a stack trace");
  const body = JSON.parse(result.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  return body.error;
}

/**
 * The exact v0 DDL documented in docs/behavior-v0.md, "Database schema
 * (version 1)". Compatibility fixtures are built in process from this, because
 * the current release's `init` creates version 2.
 */
export const V0_SCHEMA_SQL = `
CREATE TABLE items (
  id   TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) > 0)
) STRICT;

CREATE TABLE loans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        TEXT NOT NULL REFERENCES items (id),
  borrower_id    TEXT NOT NULL CHECK (length(borrower_id) BETWEEN 1 AND 64),
  checked_out_at TEXT NOT NULL,
  returned_at    TEXT
) STRICT;

CREATE UNIQUE INDEX loans_one_active_per_item ON loans (item_id) WHERE returned_at IS NULL;
`;

export interface V0Seed {
  items: { id: string; name: string }[];
  loans?: { id: number; itemId: string; borrowerId: string; checkedOutAt: string; returnedAt: string | null }[];
}

/** Builds a populated v0 database in process, exactly as the v0 release stored it. */
export function createV0Database(file: string, seed: V0Seed): void {
  const db = new Database(file);
  try {
    db.exec(V0_SCHEMA_SQL);
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${V0_SCHEMA_VERSION}`);
    const insertItem = db.prepare("INSERT INTO items (id, name) VALUES (?, ?)");
    for (const item of seed.items) insertItem.run(item.id, item.name);
    const insertLoan = db.prepare(
      "INSERT INTO loans (id, item_id, borrower_id, checked_out_at, returned_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const loan of seed.loans ?? []) {
      insertLoan.run(loan.id, loan.itemId, loan.borrowerId, loan.checkedOutAt, loan.returnedAt);
    }
  } finally {
    db.close();
  }
}

export interface RawSnapshot {
  applicationId: number;
  userVersion: number;
  schema: { type: string; name: string; sql: string | null }[];
  items: { id: string; name: string }[];
  loans: { id: number; item_id: string; borrower_id: string; checked_out_at: string; returned_at: string | null }[];
  /** Hold rows, or null when the v2 `holds` table does not exist. */
  holds: { item_id: string; held_at: string }[] | null;
}

/** A logical snapshot of a database, used to prove migration atomicity. */
export function rawSnapshot(file: string): RawSnapshot {
  const db = new Database(file, { readonly: true });
  try {
    const schema = db
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name")
      .all() as { type: string; name: string; sql: string | null }[];
    const hasHolds = schema.some((entry) => entry.name === "holds");
    return {
      applicationId: db.pragma("application_id", { simple: true }) as number,
      userVersion: db.pragma("user_version", { simple: true }) as number,
      schema,
      items: db.prepare("SELECT id, name FROM items ORDER BY id").all() as { id: string; name: string }[],
      loans: db
        .prepare("SELECT id, item_id, borrower_id, checked_out_at, returned_at FROM loans ORDER BY id")
        .all() as RawSnapshot["loans"],
      holds: hasHolds
        ? (db.prepare("SELECT item_id, held_at FROM holds ORDER BY item_id").all() as RawSnapshot["holds"])
        : null,
    };
  } finally {
    db.close();
  }
}
