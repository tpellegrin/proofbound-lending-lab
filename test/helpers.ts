import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { BorrowDesk, initializeDatabase, type OpenOptions } from "../src/desk.js";
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
