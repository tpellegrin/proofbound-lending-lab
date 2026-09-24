#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { renderDashboard } from "./dashboard.js";
import { BorrowDesk, initializeDatabase, migrateDatabase } from "./desk.js";
import { BorrowDeskError, type ErrorCode } from "./errors.js";
import { parseLoanId } from "./validation.js";

const HELP = `BorrowDesk - equipment lending desk

Usage:
  node dist/cli.js --db <path> <command> [arguments] [options]

Commands:
  init                               Create the current schema (safe to repeat; never migrates)
  migrate                            Upgrade a v0 database to the current schema (atomic)
  add-item <item-id> <name>          Register an equipment item
  list-items                         List items with availability, ordered by id
  hold <item-id>                     Place a maintenance hold on an item
  release <item-id>                  Remove a maintenance hold from an item
  checkout <item-id> <borrower-id>   Lend an available item; prints the new loan
  return <loan-id>                   Close an active loan
  list-loans [--active]              Loan history ordered by loan id (--active: open loans only)
  report --out <file> [--force]      Write a read-only HTML dashboard snapshot
                                     (refuses to replace an existing file without --force)

Options:
  --db <path>   SQLite database file (required). Only init creates it.
  -h, --help    Show this help

A held item cannot be checked out; holds and loans are independent, so an item
can be held while it is on loan. Ordinary commands refuse a v0 database with
MIGRATION_REQUIRED; run migrate first.

Identifiers are 1-64 characters of lowercase letters, digits, "-", "_" or ".",
starting with a letter or digit (e.g. drill-01, member-001). Names containing
spaces must be quoted; use "--" before a name that begins with "-".

Successful results are JSON on stdout; errors are JSON on stderr.
Exit codes: 0 success, 2 invalid input or rejected operation, 1 unexpected failure.
`;

interface CommandSpec {
  args: readonly string[];
  options: readonly ("active" | "out" | "force")[];
}

const COMMANDS: Record<string, CommandSpec> = {
  init: { args: [], options: [] },
  migrate: { args: [], options: [] },
  "add-item": { args: ["item-id", "name"], options: [] },
  "list-items": { args: [], options: [] },
  hold: { args: ["item-id"], options: [] },
  release: { args: ["item-id"], options: [] },
  checkout: { args: ["item-id", "borrower-id"], options: [] },
  return: { args: ["loan-id"], options: [] },
  "list-loans": { args: [], options: ["active"] },
  report: { args: [], options: ["out", "force"] },
};

interface ParsedCommand {
  command: string;
  db: string;
  args: string[];
  active: boolean;
  out: string | undefined;
  force: boolean;
}

function usageError(message: string): BorrowDeskError {
  return new BorrowDeskError("INVALID_ARGUMENTS", `${message} (see --help)`);
}

/** Parses argv; reports a recognized command name through onCommand before validating its arguments. */
function parse(argv: string[], onCommand: (command: string) => void): ParsedCommand | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      active: { type: "boolean" },
      out: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...args] = positionals;
  if (values.help || command === "help") return "help";
  if (command === undefined) throw usageError("Missing command");

  const spec = COMMANDS[command];
  if (!spec) throw usageError(`Unknown command "${command}"`);
  onCommand(command);
  if (args.length !== spec.args.length) {
    const expected = spec.args.map((name) => `<${name}>`).join(" ");
    throw usageError(`Usage: ${command}${expected ? ` ${expected}` : ""}`);
  }
  for (const option of ["active", "out", "force"] as const) {
    if (values[option] !== undefined && !spec.options.includes(option)) {
      throw usageError(`Option --${option} is not valid for ${command}`);
    }
  }
  if (values.db === undefined || values.db === "") throw usageError("Missing required option --db <path>");
  if (command === "report" && (values.out === undefined || values.out === "")) {
    throw usageError("Missing required option --out <file>");
  }

  return {
    command,
    db: values.db,
    args,
    active: values.active ?? false,
    out: values.out,
    force: values.force ?? false,
  };
}

function execute(parsed: ParsedCommand): unknown {
  if (parsed.command === "init") return initializeDatabase(parsed.db);
  if (parsed.command === "migrate") return migrateDatabase(parsed.db);

  const desk = BorrowDesk.open(parsed.db);
  try {
    const [first = "", second = ""] = parsed.args;
    switch (parsed.command) {
      case "add-item":
        return { item: desk.registerItem(first, second) };
      case "list-items":
        return { items: desk.listItems() };
      case "hold":
        return desk.hold(first);
      case "release":
        return desk.release(first);
      case "checkout":
        return { loan: desk.checkout(first, second) };
      case "return":
        return { loan: desk.returnLoan(parseLoanId(first)) };
      case "list-loans":
        return { loans: desk.listLoans({ activeOnly: parsed.active }) };
      case "report":
        return writeReport(desk, parsed.db, parsed.out ?? "", parsed.force);
      default:
        throw new Error(`Unhandled command ${parsed.command}`);
    }
  } finally {
    desk.close();
  }
}

function writeReport(desk: BorrowDesk, db: string, out: string, force: boolean) {
  const target = path.resolve(out);
  const directory = path.dirname(target);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new BorrowDeskError("INVALID_OUTPUT_PATH", `Directory does not exist: ${directory}`, "out");
  }
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) {
      throw new BorrowDeskError("INVALID_OUTPUT_PATH", `Output path is a directory: ${target}`, "out");
    }
    if (fs.realpathSync(target) === fs.realpathSync(db)) {
      throw new BorrowDeskError("INVALID_OUTPUT_PATH", "Output path must not be the database file", "out");
    }
    if (!force) {
      throw new BorrowDeskError(
        "OUTPUT_EXISTS",
        `${target} already exists; choose another path or pass --force to replace it`,
        "out",
      );
    }
  }

  const snapshot = desk.snapshot();
  const html = renderDashboard(snapshot, path.basename(db));
  try {
    fs.writeFileSync(target, html, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new BorrowDeskError("OUTPUT_EXISTS", `${target} already exists`, "out");
    }
    throw error;
  }
  return {
    path: target,
    generatedAt: snapshot.generatedAt,
    itemCount: snapshot.items.length,
    loanCount: snapshot.loans.length,
    activeLoanCount: snapshot.loans.filter((loan) => loan.status === "active").length,
    heldItemCount: snapshot.items.filter((item) => item.held).length,
    availableItemCount: snapshot.items.filter((item) => item.available).length,
  };
}

interface Failure {
  code: ErrorCode;
  message: string;
  field?: string;
  exitCode: 1 | 2;
}

function describeFailure(error: unknown): Failure {
  if (error instanceof BorrowDeskError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
      exitCode: error.isRejection ? 2 : 1,
    };
  }
  if (error instanceof Database.SqliteError) {
    const busy = error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED");
    return busy
      ? { code: "DATABASE_BUSY", message: `Database is locked by another process: ${error.message}`, exitCode: 1 }
      : { code: "STORAGE_ERROR", message: `${error.code}: ${error.message}`, exitCode: 1 };
  }
  const nodeCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof nodeCode === "string" && nodeCode.startsWith("ERR_PARSE_ARGS")) {
    return { code: "INVALID_ARGUMENTS", message: `${(error as Error).message} (see --help)`, exitCode: 2 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL_ERROR", message, exitCode: 1 };
}

function main(argv: string[]): number {
  let command: string | null = null;
  try {
    const parsed = parse(argv, (name) => (command = name));
    if (parsed === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    const data = execute(parsed);
    process.stdout.write(`${JSON.stringify({ ok: true, command, data }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const { exitCode, ...details } = describeFailure(error);
    process.stderr.write(`${JSON.stringify({ ok: false, command, error: details }, null, 2)}\n`);
    return exitCode;
  }
}

process.exitCode = main(process.argv.slice(2));
