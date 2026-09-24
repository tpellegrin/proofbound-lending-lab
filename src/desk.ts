import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BorrowDeskError } from "./errors.js";
import { requireBorrowerId, requireItemId, requireItemName, requireLoanId } from "./validation.js";

/** Schema version written by BorrowDesk v0 (stored in SQLite's `user_version`). */
export const SCHEMA_VERSION = 1;

/** Marks a file as a BorrowDesk database (stored in SQLite's `application_id`; "BorD"). */
export const APPLICATION_ID = 0x426f7244;

/** How long a connection waits for another process's lock before failing with DATABASE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

const SCHEMA_SQL = `
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

  -- At most one active (unreturned) loan per item.
  CREATE UNIQUE INDEX loans_one_active_per_item ON loans (item_id) WHERE returned_at IS NULL;
`;

export interface ActiveLoanSummary {
  id: number;
  borrowerId: string;
  checkedOutAt: string;
}

export interface Item {
  id: string;
  name: string;
  status: "available" | "on_loan";
  activeLoan: ActiveLoanSummary | null;
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
}

export interface OpenOptions {
  /** Clock used for checkout, return and snapshot timestamps. Defaults to the system clock. */
  now?: () => Date;
}

interface ItemRow {
  id: string;
  name: string;
  loan_id: number | null;
  borrower_id: string | null;
  checked_out_at: string | null;
}

interface LoanRow {
  id: number;
  item_id: string;
  borrower_id: string;
  checked_out_at: string;
  returned_at: string | null;
}

const ITEM_SELECT = `
  SELECT i.id, i.name, l.id AS loan_id, l.borrower_id, l.checked_out_at
  FROM items i
  LEFT JOIN loans l ON l.item_id = i.id AND l.returned_at IS NULL`;

const LOAN_SELECT = `SELECT id, item_id, borrower_id, checked_out_at, returned_at FROM loans`;

/**
 * Creates the v0 schema in a new or empty SQLite file. Running it against an
 * already-initialized BorrowDesk database changes nothing.
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
    const alreadyInitialized = rejectNonDatabase(database, () =>
      db
        .transaction(() => {
          if (schemaState(db, database) === "current") return true;
          db.exec(SCHEMA_SQL);
          db.pragma(`application_id = ${APPLICATION_ID}`);
          db.pragma(`user_version = ${SCHEMA_VERSION}`);
          return false;
        })
        .immediate(),
    );
    return { database, schemaVersion: SCHEMA_VERSION, alreadyInitialized };
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
      if (schemaState(db, database) === "empty") {
        throw new BorrowDeskError(
          "DATABASE_NOT_INITIALIZED",
          `Database ${database} is not initialized; run the init command first`,
        );
      }
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
  return {
    id: row.id,
    name: row.name,
    status: activeLoan ? "on_loan" : "available",
    activeLoan,
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

/**
 * Classifies an open connection's file: "empty" (no schema yet), "current"
 * (a BorrowDesk v0 database), or throws for anything else.
 */
function schemaState(db: Database.Database, database: string): "empty" | "current" {
  const { applicationId, version, objectCount } = rejectNonDatabase(database, () => ({
    applicationId: db.pragma("application_id", { simple: true }) as number,
    version: db.pragma("user_version", { simple: true }) as number,
    objectCount: (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n,
  }));

  if (applicationId === APPLICATION_ID) {
    if (version === SCHEMA_VERSION) return "current";
    throw new BorrowDeskError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `${database} has schema version ${version}; this release supports version ${SCHEMA_VERSION}`,
    );
  }
  if (applicationId === 0 && version === 0 && objectCount === 0) return "empty";
  throw new BorrowDeskError(
    "NOT_A_BORROWDESK_DATABASE",
    `${database} is a SQLite database that was not created by BorrowDesk`,
  );
}

/** Runs body, reporting "file is not a database" as a rejection rather than a storage failure. */
function rejectNonDatabase<T>(database: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code === "SQLITE_NOTADB") {
      throw new BorrowDeskError("NOT_A_BORROWDESK_DATABASE", `${database} is not a SQLite database`);
    }
    throw error;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
