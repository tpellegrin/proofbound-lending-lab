import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BorrowDeskError } from "./errors.js";
import { requireBorrowerId, requireItemId, requireItemName, requireLoanId } from "./validation.js";

/** Schema version written by the current release (stored in SQLite's `user_version`). */
export const SCHEMA_VERSION = 2;

/** Schema version written by BorrowDesk v0; readable only through `migrate`. */
export const V0_SCHEMA_VERSION = 1;

/** Marks a file as a BorrowDesk database (stored in SQLite's `application_id`; "BorD"). */
export const APPLICATION_ID = 0x426f7244;

/** How long a connection waits for another process's lock before failing with DATABASE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

const ITEMS_TABLE_SQL = `
  CREATE TABLE items (
    id   TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (length(name) > 0)
  ) STRICT;
`;

const LOANS_TABLE_SQL = `
  CREATE TABLE loans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id        TEXT NOT NULL REFERENCES items (id),
    borrower_id    TEXT NOT NULL CHECK (length(borrower_id) BETWEEN 1 AND 64),
    checked_out_at TEXT NOT NULL,
    returned_at    TEXT
  ) STRICT;

  -- At most one active (unreturned) loan per item.
  CREATE UNIQUE INDEX loans_one_active_per_item ON loans (item_id) WHERE returned_at IS NULL;
`;

/**
 * Version 2 adds maintenance holds as a separate one-row-per-item table. A hold
 * has no exposed timestamp; `held_at` exists only so the record is stable and
 * an idempotent repeat does not rewrite it.
 */
const HOLDS_TABLE_SQL = `
  CREATE TABLE holds (
    item_id TEXT PRIMARY KEY NOT NULL REFERENCES items (id),
    held_at TEXT NOT NULL
  ) STRICT;
`;

const SCHEMA_SQL = `${ITEMS_TABLE_SQL}${LOANS_TABLE_SQL}${HOLDS_TABLE_SQL}`;

export interface ActiveLoanSummary {
  id: number;
  borrowerId: string;
  checkedOutAt: string;
}

export interface Item {
  id: string;
  name: string;
  /** Loan state only: "on_loan" iff there is an active loan, otherwise "available". */
  status: "available" | "on_loan";
  activeLoan: ActiveLoanSummary | null;
  /** True when a maintenance hold is effective. */
  held: boolean;
  /** Checkout availability: neither held nor borrowed. */
  available: boolean;
}

export interface Loan {
  id: number;
  itemId: string;
  borrowerId: string;
  /** UTC, ISO 8601 with milliseconds, e.g. 2026-09-24T14:03:00.000Z. */
  checkedOutAt: string;
  returnedAt: string | null;
  status: "active" | "returned";
}

export interface Snapshot {
  generatedAt: string;
  items: Item[];
  loans: Loan[];
}

export interface InitResult {
  database: string;
  schemaVersion: number;
  alreadyInitialized: boolean;
  migrationRequired: boolean;
}

export interface MigrateResult {
  database: string;
  fromSchemaVersion: number;
  schemaVersion: number;
  migrated: boolean;
}

export interface HoldResult {
  item: Item;
  changed: boolean;
}

export interface OpenOptions {
  /** Clock used for checkout, return, hold and snapshot timestamps. Defaults to the system clock. */
  now?: () => Date;
}

export interface MigrateOptions {
  /**
   * Test-only fault seam. Called inside the migration transaction after the
   * first schema change and before the `user_version` update; if it throws, the
   * whole transaction rolls back. Not used by the CLI.
   */
  onFirstSchemaChange?: () => void;
}

interface ItemRow {
  id: string;
  name: string;
  loan_id: number | null;
  borrower_id: string | null;
  checked_out_at: string | null;
  held_at: string | null;
}

interface LoanRow {
  id: number;
  item_id: string;
  borrower_id: string;
  checked_out_at: string;
  returned_at: string | null;
}

const ITEM_SELECT = `
  SELECT i.id, i.name, l.id AS loan_id, l.borrower_id, l.checked_out_at, h.held_at
  FROM items i
  LEFT JOIN loans l ON l.item_id = i.id AND l.returned_at IS NULL
  LEFT JOIN holds h ON h.item_id = i.id`;

const LOAN_SELECT = `SELECT id, item_id, borrower_id, checked_out_at, returned_at FROM loans`;

/**
 * Creates the version 2 schema in a new or empty SQLite file. Running it against
 * an already-initialized BorrowDesk database changes nothing; on a v0 database it
 * reports `migrationRequired: true` and does not migrate.
 */
export function initializeDatabase(file: string): InitResult {
  const database = path.resolve(file);
  const directory = path.dirname(database);
  if (!isDirectory(directory)) {
    throw new BorrowDeskError("INVALID_DATABASE_PATH", `Directory does not exist: ${directory}`);
  }
  if (isDirectory(database)) {
    throw new BorrowDeskError("INVALID_DATABASE_PATH", `Database path is a directory: ${database}`);
  }

  const db = new Database(database, { timeout: BUSY_TIMEOUT_MS });
  try {
    const result = rejectNonDatabase(database, () =>
      db
        .transaction(() => {
          const { applicationId, version, objectCount } = inspect(db, database);
          if (applicationId === APPLICATION_ID) {
            if (version === SCHEMA_VERSION) {
              return { schemaVersion: SCHEMA_VERSION, alreadyInitialized: true, migrationRequired: false };
            }
            if (version === V0_SCHEMA_VERSION) {
              return { schemaVersion: V0_SCHEMA_VERSION, alreadyInitialized: true, migrationRequired: true };
            }
            throw new BorrowDeskError(
              "UNSUPPORTED_SCHEMA_VERSION",
              `${database} has schema version ${version}; this release supports version ${SCHEMA_VERSION}`,
            );
          }
          if (applicationId === 0 && version === 0 && objectCount === 0) {
            db.exec(SCHEMA_SQL);
            db.pragma(`application_id = ${APPLICATION_ID}`);
            db.pragma(`user_version = ${SCHEMA_VERSION}`);
            return { schemaVersion: SCHEMA_VERSION, alreadyInitialized: false, migrationRequired: false };
          }
          throw new BorrowDeskError(
            "NOT_A_BORROWDESK_DATABASE",
            `${database} is a SQLite database that was not created by BorrowDesk`,
          );
        })
        .immediate(),
    );
    return { database, ...result };
  } finally {
    db.close();
  }
}

/**
 * Explicitly upgrades a v0 database to version 2. It is the only operation that
 * migrates. The whole migration runs in one `BEGIN IMMEDIATE` transaction, so a
 * failure leaves the file exactly as it was. Every refusal leaves the file
 * byte-identical (or creates no file).
 */
export function migrateDatabase(file: string, options: MigrateOptions = {}): MigrateResult {
  const database = path.resolve(file);
  if (!fs.existsSync(database)) {
    throw new BorrowDeskError(
      "DATABASE_NOT_FOUND",
      `No database at ${database}; create one with the init command`,
    );
  }
  if (isDirectory(database)) {
    throw new BorrowDeskError("INVALID_DATABASE_PATH", `Database path is a directory: ${database}`);
  }

  const db = new Database(database, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const { version } = inspectForMigrate(db, database);
    if (version !== V0_SCHEMA_VERSION && version !== SCHEMA_VERSION) {
      throw new BorrowDeskError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `${database} has schema version ${version}; this release supports version ${SCHEMA_VERSION}`,
      );
    }
    assertIntegrity(db, database);
    if (version === SCHEMA_VERSION) {
      return { database, fromSchemaVersion: SCHEMA_VERSION, schemaVersion: SCHEMA_VERSION, migrated: false };
    }
    // Re-read the version inside the write transaction: a migrate that loses a race
    // to a concurrent migrate on the same file then sees the committed version 2 and
    // becomes an idempotent no-op instead of trying to recreate the `holds` table.
    const migrated = db
      .transaction(() => {
        const current = inspectForMigrate(db, database).version;
        if (current === SCHEMA_VERSION) return false;
        if (current !== V0_SCHEMA_VERSION) {
          throw new BorrowDeskError(
            "UNSUPPORTED_SCHEMA_VERSION",
            `${database} has schema version ${current}; this release supports version ${SCHEMA_VERSION}`,
          );
        }
        db.exec(HOLDS_TABLE_SQL);
        options.onFirstSchemaChange?.();
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
        return true;
      })
      .immediate();
    return {
      database,
      fromSchemaVersion: migrated ? V0_SCHEMA_VERSION : SCHEMA_VERSION,
      schemaVersion: SCHEMA_VERSION,
      migrated,
    };
  } finally {
    db.close();
  }
}

export class BorrowDesk {
  readonly #db: Database.Database;
  readonly #now: () => Date;

  private constructor(db: Database.Database, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  /** Opens an existing, initialized BorrowDesk database. Never creates a file. */
  static open(file: string, options: OpenOptions = {}): BorrowDesk {
    const database = path.resolve(file);
    if (!fs.existsSync(database)) {
      throw new BorrowDeskError(
        "DATABASE_NOT_FOUND",
        `No database at ${database}; create one with the init command`,
      );
    }
    if (isDirectory(database)) {
      throw new BorrowDeskError("INVALID_DATABASE_PATH", `Database path is a directory: ${database}`);
    }

    const db = new Database(database, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    try {
      assertOpenable(db, database);
      db.pragma("foreign_keys = ON");
    } catch (error) {
      db.close();
      throw error;
    }
    return new BorrowDesk(db, options.now ?? (() => new Date()));
  }

  close(): void {
    this.#db.close();
  }

  registerItem(itemId: string, name: string): Item {
    const id = requireItemId(itemId);
    const itemName = requireItemName(name);
    return this.#write(() => {
      if (this.#findItem(id)) {
        throw new BorrowDeskError("ITEM_ALREADY_EXISTS", `Item ${id} is already registered`, "itemId");
      }
      this.#db.prepare("INSERT INTO items (id, name) VALUES (?, ?)").run(id, itemName);
      return this.#getItem(id);
    });
  }

  /** All items, ordered by id (ascending, byte-wise). */
  listItems(): Item[] {
    return this.#read(() => this.#allItems());
  }

  checkout(itemId: string, borrowerId: string): Loan {
    const id = requireItemId(itemId);
    const borrower = requireBorrowerId(borrowerId);
    return this.#write(() => {
      const item = this.#findItem(id);
      if (!item) {
        throw new BorrowDeskError("ITEM_NOT_FOUND", `No item with id ${id}`, "itemId");
      }
      if (item.activeLoan) {
        throw new BorrowDeskError(
          "ITEM_UNAVAILABLE",
          `Item ${id} is already on loan (loan ${item.activeLoan.id})`,
          "itemId",
        );
      }
      if (item.held) {
        throw new BorrowDeskError("ITEM_HELD", `Item ${id} has a maintenance hold`, "itemId");
      }
      const result = this.#db
        .prepare("INSERT INTO loans (item_id, borrower_id, checked_out_at) VALUES (?, ?, ?)")
        .run(id, borrower, this.#timestamp());
      return this.#getLoan(Number(result.lastInsertRowid));
    });
  }

  returnLoan(loanId: number): Loan {
    const id = requireLoanId(loanId);
    return this.#write(() => {
      const loan = this.#findLoan(id);
      if (!loan) {
        throw new BorrowDeskError("LOAN_NOT_FOUND", `No loan with id ${id}`, "loanId");
      }
      if (loan.returnedAt !== null) {
        throw new BorrowDeskError(
          "LOAN_ALREADY_RETURNED",
          `Loan ${id} was already returned at ${loan.returnedAt}`,
          "loanId",
        );
      }
      this.#db
        .prepare("UPDATE loans SET returned_at = ? WHERE id = ? AND returned_at IS NULL")
        .run(this.#timestamp(), id);
      return this.#getLoan(id);
    });
  }

  /** Places a maintenance hold on an existing item. Repeating it changes nothing. */
  hold(itemId: string): HoldResult {
    const id = requireItemId(itemId);
    return this.#write(() => {
      const item = this.#findItem(id);
      if (!item) {
        throw new BorrowDeskError("ITEM_NOT_FOUND", `No item with id ${id}`, "itemId");
      }
      if (item.held) return { item, changed: false };
      this.#db.prepare("INSERT INTO holds (item_id, held_at) VALUES (?, ?)").run(id, this.#timestamp());
      return { item: this.#getItem(id), changed: true };
    });
  }

  /** Removes a maintenance hold from an existing item. Repeating it changes nothing. */
  release(itemId: string): HoldResult {
    const id = requireItemId(itemId);
    return this.#write(() => {
      const item = this.#findItem(id);
      if (!item) {
        throw new BorrowDeskError("ITEM_NOT_FOUND", `No item with id ${id}`, "itemId");
      }
      if (!item.held) return { item, changed: false };
      this.#db.prepare("DELETE FROM holds WHERE item_id = ?").run(id);
      return { item: this.#getItem(id), changed: true };
    });
  }

  /** Loans ordered by id (checkout order). Includes returned loans unless activeOnly is set. */
  listLoans(options: { activeOnly?: boolean } = {}): Loan[] {
    return this.#read(() => this.#allLoans(options.activeOnly === true));
  }

  /** A consistent read of all items and loans, stamped with the time it was taken. */
  snapshot(): Snapshot {
    return this.#read(() => ({
      generatedAt: this.#timestamp(),
      items: this.#allItems(),
      loans: this.#allLoans(false),
    }));
  }

  // Write transactions take the write lock up front (BEGIN IMMEDIATE), so the
  // checks inside them cannot be invalidated by another connection before commit.
  #write<T>(body: () => T): T {
    return this.#db.transaction(body).immediate();
  }

  #read<T>(body: () => T): T {
    return this.#db.transaction(body).deferred();
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #allItems(): Item[] {
    const rows = this.#db.prepare(`${ITEM_SELECT} ORDER BY i.id`).all() as ItemRow[];
    return rows.map(toItem);
  }

  #findItem(id: string): Item | undefined {
    const row = this.#db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
    return row && toItem(row);
  }

  #getItem(id: string): Item {
    const item = this.#findItem(id);
    if (!item) throw new Error(`Item ${id} vanished inside its own transaction`);
    return item;
  }

  #allLoans(activeOnly: boolean): Loan[] {
    const where = activeOnly ? " WHERE returned_at IS NULL" : "";
    const rows = this.#db.prepare(`${LOAN_SELECT}${where} ORDER BY id`).all() as LoanRow[];
    return rows.map(toLoan);
  }

  #findLoan(id: number): Loan | undefined {
    const row = this.#db.prepare(`${LOAN_SELECT} WHERE id = ?`).get(id) as LoanRow | undefined;
    return row && toLoan(row);
  }

  #getLoan(id: number): Loan {
    const loan = this.#findLoan(id);
    if (!loan) throw new Error(`Loan ${id} vanished inside its own transaction`);
    return loan;
  }
}

function toItem(row: ItemRow): Item {
  const activeLoan =
    row.loan_id === null
      ? null
      : { id: row.loan_id, borrowerId: row.borrower_id ?? "", checkedOutAt: row.checked_out_at ?? "" };
  const held = row.held_at !== null;
  return {
    id: row.id,
    name: row.name,
    status: activeLoan ? "on_loan" : "available",
    activeLoan,
    held,
    available: activeLoan === null && !held,
  };
}

function toLoan(row: LoanRow): Loan {
  return {
    id: row.id,
    itemId: row.item_id,
    borrowerId: row.borrower_id,
    checkedOutAt: row.checked_out_at,
    returnedAt: row.returned_at,
    status: row.returned_at === null ? "active" : "returned",
  };
}

interface Inspected {
  applicationId: number;
  version: number;
  objectCount: number;
}

/** Reads the file's identifying pragmas and object count, rejecting non-SQLite files. */
function inspect(db: Database.Database, database: string): Inspected {
  return rejectNonDatabase(database, () => ({
    applicationId: db.pragma("application_id", { simple: true }) as number,
    version: db.pragma("user_version", { simple: true }) as number,
    objectCount: (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n,
  }));
}

/**
 * Accepts a v2 database, refuses a v0 database with MIGRATION_REQUIRED, and
 * classifies empty/foreign/unknown files exactly as v0 did.
 */
function assertOpenable(db: Database.Database, database: string): void {
  const { applicationId, version, objectCount } = inspect(db, database);
  if (applicationId === APPLICATION_ID) {
    if (version === SCHEMA_VERSION) return;
    if (version === V0_SCHEMA_VERSION) {
      throw new BorrowDeskError(
        "MIGRATION_REQUIRED",
        `${database} is a version ${V0_SCHEMA_VERSION} database; run the migrate command first`,
      );
    }
    throw new BorrowDeskError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `${database} has schema version ${version}; this release supports version ${SCHEMA_VERSION}`,
    );
  }
  if (applicationId === 0 && version === 0 && objectCount === 0) {
    throw new BorrowDeskError(
      "DATABASE_NOT_INITIALIZED",
      `Database ${database} is not initialized; run the init command first`,
    );
  }
  throw new BorrowDeskError(
    "NOT_A_BORROWDESK_DATABASE",
    `${database} is a SQLite database that was not created by BorrowDesk`,
  );
}

/** Reads a BorrowDesk file's version for migration, distinguishing empty from foreign. */
function inspectForMigrate(db: Database.Database, database: string): { applicationId: number; version: number } {
  const applicationId = readPragma(db, "application_id", database);
  const version = readPragma(db, "user_version", database);
  if (applicationId !== APPLICATION_ID) {
    const objectCount = countSchemaObjects(db, database);
    if (applicationId === 0 && version === 0 && objectCount === 0) {
      throw new BorrowDeskError(
        "DATABASE_NOT_INITIALIZED",
        `Database ${database} is not initialized; run the init command first`,
      );
    }
    throw new BorrowDeskError(
      "NOT_A_BORROWDESK_DATABASE",
      `${database} is a SQLite database that was not created by BorrowDesk`,
    );
  }
  return { applicationId, version };
}

function readPragma(db: Database.Database, pragma: string, database: string): number {
  try {
    return db.pragma(pragma, { simple: true }) as number;
  } catch (error) {
    throw migrateReadError(error, database);
  }
}

function countSchemaObjects(db: Database.Database, database: string): number {
  try {
    return (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n;
  } catch (error) {
    throw migrateReadError(error, database);
  }
}

function migrateReadError(error: unknown, database: string): unknown {
  if (isNotADatabase(error)) {
    return new BorrowDeskError("NOT_A_BORROWDESK_DATABASE", `${database} is not a SQLite database`);
  }
  if (isCorruption(error)) {
    return new BorrowDeskError("DATABASE_CORRUPT", `${database} is a corrupt BorrowDesk database`);
  }
  return error;
}

/** Runs SQLite's integrity check and rejects a corrupt BorrowDesk database. */
function assertIntegrity(db: Database.Database, database: string): void {
  let rows: unknown;
  try {
    rows = db.pragma("integrity_check");
  } catch (error) {
    if (isCorruption(error)) {
      throw new BorrowDeskError("DATABASE_CORRUPT", `${database} failed SQLite's integrity check`);
    }
    throw error;
  }
  const healthy = Array.isArray(rows) && rows.length === 1 && Object.values(rows[0] as object).includes("ok");
  if (!healthy) {
    throw new BorrowDeskError("DATABASE_CORRUPT", `${database} failed SQLite's integrity check`);
  }
}

/** Runs body, reporting "file is not a database" as a rejection rather than a storage failure. */
function rejectNonDatabase<T>(database: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (isNotADatabase(error)) {
      throw new BorrowDeskError("NOT_A_BORROWDESK_DATABASE", `${database} is not a SQLite database`);
    }
    throw error;
  }
}

function sqliteErrorCode(error: unknown): string | undefined {
  return error instanceof Database.SqliteError ? error.code : undefined;
}

function isNotADatabase(error: unknown): boolean {
  return sqliteErrorCode(error) === "SQLITE_NOTADB";
}

function isCorruption(error: unknown): boolean {
  return sqliteErrorCode(error)?.startsWith("SQLITE_CORRUPT") ?? false;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
