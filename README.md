# BorrowDesk

BorrowDesk is a small command-line lending desk for a community workshop that lends individually
identified equipment (`projector-01`, `drill-01`, ...). An operator registers equipment, checks items out
to borrower identifiers (`member-001`, ...), records returns, reviews active loans and history, and can
write a read-only HTML dashboard. Data lives in a single SQLite file.

The exact rules, validation policy, JSON output, error codes and schema are in
[docs/behavior-v0.md](docs/behavior-v0.md).

## Prerequisites

- Node.js 24 (verified with **24.19.0**, recorded in `.node-version`) and the npm that ships with it
  (verified with 11.17.0).
- No separate database server. `better-sqlite3` ships prebuilt native binaries for macOS, Linux and Windows
  on x64/arm64; on other platforms npm compiles it, which needs Python and a C++ toolchain.

## Setup

```sh
npm ci          # installs exactly what package-lock.json records
npm run check   # type-check, clean build, full test suite
```

Nothing after `npm ci` downloads packages: builds, tests, the CLI and the demo use only installed files.

## Upgrading an existing v0 database

A database created by the v0 release has schema version 1. Migrate it once, before running any other
command on it:

```sh
node dist/cli.js --db "$DB" migrate
```

Until it is migrated, every ordinary command — including the read-only `list-items`, `list-loans` and
`report` — refuses the file with `MIGRATION_REQUIRED` (exit 2) and leaves it unchanged. `init` never
migrates, replaces or resets an existing database.

`migrate` is atomic and preserves every record (ids, borrowers, timestamps and the complete loan
history); migrated items start without a hold. It is safe to repeat: on a current database it succeeds
and changes nothing. See "Initialization and migration" in
[docs/behavior-v0.md](docs/behavior-v0.md#initialization-and-migration).

## Using the CLI

Build once (`npm run build`), then run `node dist/cli.js --db <path> <command>`. Every command requires
an explicit `--db` path; only `init` creates the file.

```sh
DB=./workshop.db
node dist/cli.js --db "$DB" init
node dist/cli.js --db "$DB" add-item drill-01 "Cordless drill"
node dist/cli.js --db "$DB" add-item projector-01 "Portable projector"
node dist/cli.js --db "$DB" list-items
node dist/cli.js --db "$DB" hold drill-01                       # maintenance hold; blocks new checkouts
node dist/cli.js --db "$DB" release drill-01                    # remove the hold
node dist/cli.js --db "$DB" checkout drill-01 member-001      # prints the loan, including its id
node dist/cli.js --db "$DB" list-loans --active
node dist/cli.js --db "$DB" return 1                          # loan id from checkout
node dist/cli.js --db "$DB" list-loans                        # full history, oldest first
node dist/cli.js --db "$DB" report --out ./dashboard.html     # add --force to replace an existing file
node dist/cli.js --db "$DB" migrate                           # upgrade a v0 database to schema version 2
node dist/cli.js --help
```

Successful commands print one JSON document on stdout and exit 0. Errors print a JSON document with a
stable `error.code` on stderr and exit 2 (invalid input or rejected operation) or 1 (unexpected storage
or program failure). For example, `checkout` of a borrowed item exits 2 with `ITEM_UNAVAILABLE`. In
scripts, read the new loan id from `.data.loan.id` (e.g. `... checkout drill-01 member-001 | jq .data.loan.id`).

## Demo

```sh
npm run demo                              # new directory under demo-output/
npm run demo -- --out /tmp/borrowdesk-demo   # or a directory that must not exist yet
```

The demo builds the app and then runs the real CLI as separate processes against a new database. It
registers four items, checks out two, shows a rejected double checkout, returns one loan, lends the
returned item again, lists items and loans, and writes `dashboard.html`. It prints the database and
dashboard paths at the end. It never reuses an existing directory, so it cannot overwrite earlier output.
Open the dashboard directly in a browser; it needs no network or JavaScript.

## Tests

- `npm test` builds the app (`dist/`) and the tests (`dist-test/`) from a clean state, then runs the
  compiled tests with Node's built-in test runner. It works straight after `npm ci`.
- `npm run check` is the canonical verification (type-check + `npm test`); CI runs exactly this.
- `npm run typecheck` and `npm run build` are available separately.

Tests use temporary databases under the OS temp directory and remove them afterwards. They cover the
lending rules through the `BorrowDesk` module, the CLI's JSON output and exit codes through real
processes, the dashboard contents and escaping, and concurrent checkouts from separate processes
(workers wait at a barrier, then race for the same item; exactly one wins).

## Project layout

```
src/desk.ts        lending rules and SQLite storage (BorrowDesk class, initializeDatabase)
src/validation.ts  runtime input validation
src/errors.ts      error type and stable error codes
src/dashboard.ts   HTML rendering from a snapshot
src/cli.ts         argument parsing and JSON output (dist/cli.js)
src/demo.ts        demo driver (dist/demo.js)
test/              node:test suites and the concurrency worker
```

## Compatibility fixtures

To create a populated v0 database for future compatibility tests, use public commands only; see
"Creating a populated v0 database" in [docs/behavior-v0.md](docs/behavior-v0.md#creating-a-populated-v0-database-for-compatibility-tests).
`npm run demo -- --out <new-dir>` is the quickest route. Generated databases are git-ignored and should
not be committed.

## Verified environment

| Component | Version |
| --- | --- |
| Node.js | 24.19.0 (N-API 10, ABI 137) |
| npm | 11.17.0 |
| better-sqlite3 | 13.0.3 (bundled SQLite 3.53.4, prebuilt `darwin-arm64` binary loaded) |
| TypeScript | 7.0.2 |
| @types/node | 24.13.6 |
| @types/better-sqlite3 | 9.6.0 |
| Host | macOS 15.7.8, arm64 |

## Limitations

- Single-operator CLI with no authentication; anyone who can write the database file can change it.
- Items cannot be renamed or removed, and loans cannot be edited or deleted.
- Borrower ids are free-form labels; there is no borrower list.
- Identifiers are lowercase-only and are not normalized (`Drill-01` is rejected, not converted).
- Listing is byte-wise, not natural sort (`drill-10` before `drill-2`).
- Timestamps come from the local system clock; BorrowDesk does not guard against clock changes.
- The dashboard is a static snapshot; regenerate it to see new data.
- Databases are for local disks; SQLite locking over network file systems is not supported.
- The current release uses schema version 2. A v0 database must be upgraded with `migrate`; ordinary
  commands refuse it with `MIGRATION_REQUIRED` rather than migrating silently (see
  [Upgrading an existing v0 database](#upgrading-an-existing-v0-database)).
