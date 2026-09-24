# BorrowDesk v0 behavior

This is the behavior contract for the v0 release. The rules, CLI syntax, JSON
shapes, error codes, exit codes and database schema described here are the
compatibility surface that later releases must preserve or deliberately migrate.

## Domain rules

1. An **item** has a unique, stable id and a nonempty name. Items cannot be renamed or removed in v0.
2. A **checkout** creates a new **loan** with a stable integer id, the item id, the borrower id and a
   `checkedOutAt` timestamp. Loan ids are assigned by SQLite (`AUTOINCREMENT`) and are never reused.
3. An item has at most one active loan. This holds across processes: write operations run in
   `BEGIN IMMEDIATE` transactions, and a partial unique index (`loans(item_id) WHERE returned_at IS NULL`)
   rejects a second active loan at the storage level.
4. Checking out an unknown item (`ITEM_NOT_FOUND`) or an item already on loan (`ITEM_UNAVAILABLE`) fails
   and changes nothing.
5. Returning an active loan sets `returnedAt`; the item becomes available.
6. Returning an unknown loan (`LOAN_NOT_FOUND`) or a returned loan (`LOAN_ALREADY_RETURNED`) fails and
   changes nothing. The original `returnedAt` is kept.
7. Returned loans stay in history. Lending the same item again creates a new loan.
8. Data is stored in a single SQLite file and persists across processes.
9. Listing order:
   - Items are ordered by id, ascending, using byte-wise (ASCII) comparison. Because ids are restricted to
     `a-z 0-9 - . _`, this means `-` < `.` < digits < `_` < letters, and `drill-10` sorts before `drill-2`.
   - Loans (history and active) are ordered by loan id ascending, which is checkout order.
10. Listing and report generation only read the database. The database file is unchanged by them.
11. `init` on an existing v0 database changes nothing and reports `"alreadyInitialized": true`.
12. Invalid input is rejected before any change, with a clear message and the offending field.

Timestamps (`checkedOutAt`, `returnedAt`, report `generatedAt`) are UTC, ISO 8601 with milliseconds,
e.g. `2026-09-24T14:03:00.000Z`. They record when things happened; they are not schedules. BorrowDesk does
not reject a return whose timestamp is earlier than the checkout (for example after a clock change).

## Input validation

Validation runs at runtime in the lending module, so every caller (the CLI or code using `BorrowDesk`)
gets the same rules. Input is never trimmed, lowercased or otherwise normalized: it is accepted as given
or rejected.

| Input | Rule |
| --- | --- |
| Item id, borrower id | 1-64 characters from `a-z`, `0-9`, `-`, `_`, `.`; first character is a letter or digit. |
| Item name | 1-200 characters (Unicode code points); no leading or trailing whitespace; no control characters (U+0000-U+001F, U+007F-U+009F, which includes newlines and tabs); well-formed Unicode. Any other text, including `<`, `&` and quotes, is stored exactly. |
| Loan id (CLI) | Decimal positive integer without sign, leading zeros or decimal point, at most 16 digits and at most 2^53-1. |

Borrower ids are opaque labels such as `member-001`. There is no borrower registry; any valid id is accepted.

## CLI

```
node dist/cli.js --db <path> <command> [arguments] [options]
```

| Command | Result `data` |
| --- | --- |
| `init` | `{ "database": <absolute path>, "schemaVersion": 1, "alreadyInitialized": <bool> }` |
| `add-item <item-id> <name>` | `{ "item": Item }` |
| `list-items` | `{ "items": [Item, ...] }` |
| `checkout <item-id> <borrower-id>` | `{ "loan": Loan }` |
| `return <loan-id>` | `{ "loan": Loan }` |
| `list-loans [--active]` | `{ "loans": [Loan, ...] }` (all loans, or only active ones with `--active`) |
| `report --out <file> [--force]` | `{ "path", "generatedAt", "itemCount", "loanCount", "activeLoanCount" }` |

- `--db` is required for every command except `--help`. Only `init` creates a database file; `init`
  requires the parent directory to exist. Other commands report `DATABASE_NOT_FOUND` or
  `DATABASE_NOT_INITIALIZED` instead of creating anything.
- Options may appear anywhere; an option that does not apply to the command is rejected. Use `--`
  before positional arguments that begin with `-`.
- `report` refuses an existing output file (`OUTPUT_EXISTS`) unless `--force` is given, and never
  writes over the database file.
- `--help` / `-h` / `help` prints plain-text help to stdout and exits 0.

Shapes:

```json
Item: { "id": "drill-01", "name": "Cordless drill", "status": "on_loan",
        "activeLoan": { "id": 2, "borrowerId": "member-002", "checkedOutAt": "2026-09-24T14:03:00.000Z" } }
      (status is "available" with "activeLoan": null when not on loan)

Loan: { "id": 2, "itemId": "drill-01", "borrowerId": "member-002",
        "checkedOutAt": "2026-09-24T14:03:00.000Z", "returnedAt": null, "status": "active" }
      (status is "returned" and returnedAt is set once returned)
```

### Output envelope and exit codes

Success: exit code 0, one JSON document on stdout, nothing on stderr.

```json
{ "ok": true, "command": "checkout", "data": { "loan": { "id": 2, ... } } }
```

Failure: nothing on stdout, one JSON document on stderr, no stack trace.

```json
{ "ok": false, "command": "checkout", "error": { "code": "ITEM_UNAVAILABLE", "message": "Item drill-01 is already on loan (loan 2)", "field": "itemId" } }
```

`command` is `null` when no valid command was recognized. `field` is present when a specific input is at
fault (`itemId`, `borrowerId`, `name`, `loanId`, `out`). Messages are for people; match on `code`.

| Exit | Code | Meaning |
| --- | --- | --- |
| 2 | `INVALID_ARGUMENTS` | Unknown command or option, wrong number of arguments, missing `--db`/`--out` |
| 2 | `INVALID_INPUT` | An id, name or loan id fails validation |
| 2 | `INVALID_DATABASE_PATH` | `--db` is a directory, or its parent directory does not exist (`init`) |
| 2 | `DATABASE_NOT_FOUND` | No file at `--db` (non-`init` commands) |
| 2 | `DATABASE_NOT_INITIALIZED` | File exists but is empty; run `init` |
| 2 | `NOT_A_BORROWDESK_DATABASE` | Not SQLite, or a SQLite file not created by BorrowDesk |
| 2 | `UNSUPPORTED_SCHEMA_VERSION` | A BorrowDesk database with a schema version this release does not know |
| 2 | `ITEM_ALREADY_EXISTS` | `add-item` with an id already registered |
| 2 | `ITEM_NOT_FOUND` | `checkout` of an unknown item |
| 2 | `ITEM_UNAVAILABLE` | `checkout` of an item that has an active loan (including a lost concurrent race) |
| 2 | `LOAN_NOT_FOUND` | `return` of an unknown loan |
| 2 | `LOAN_ALREADY_RETURNED` | `return` of a returned loan |
| 2 | `OUTPUT_EXISTS` | `report` target exists and `--force` was not given |
| 2 | `INVALID_OUTPUT_PATH` | `report` target is a directory, the database file, or its directory is missing |
| 1 | `DATABASE_BUSY` | Another process held the database lock for more than 5 seconds |
| 1 | `STORAGE_ERROR` | Any other SQLite failure (e.g. read-only file, disk full) |
| 1 | `INTERNAL_ERROR` | Unexpected program error |

### Concurrency

Every command opens the database, does its work in one transaction and closes it. Writers take the
write lock up front and wait up to 5 seconds (`busy_timeout`) for other processes. When several
processes check out the same item at once, exactly one succeeds; the others then see the item on loan
and fail with `ITEM_UNAVAILABLE`. The database uses SQLite's default rollback journal (no `-wal`/`-shm`
files persist).

## Dashboard

`report` writes one HTML file: equipment with availability and current borrower, active loans, and
complete loan history, plus summary counts. It is labeled as a read-only snapshot with its generation
time, reflects one consistent read of the database, escapes all stored text, embeds its CSS, contains
no JavaScript, and loads nothing from the network (a Content-Security-Policy meta tag enforces this).

## Database schema (version 1)

```sql
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
```

A v0 database is recognized by `PRAGMA application_id = 0x426F7244` ("BorD") and
`PRAGMA user_version = 1`. v0 opens only databases with exactly these values; there is no migration
mechanism yet.

## Creating a populated v0 database for compatibility tests

Use only public commands, so the file is exactly what v0 produces. Either run the demo into a new
directory (the database is `<dir>/borrowdesk.db`):

```sh
npm run demo -- --out /path/to/new-dir
```

or run the commands yourself:

```sh
DB=/path/to/v0-fixture.db
node dist/cli.js --db "$DB" init
node dist/cli.js --db "$DB" add-item projector-01 "Portable projector"
node dist/cli.js --db "$DB" add-item drill-01 "Cordless drill"
node dist/cli.js --db "$DB" add-item camera-01 "Mirrorless camera"
node dist/cli.js --db "$DB" add-item microphone-01 "USB microphone"
node dist/cli.js --db "$DB" checkout projector-01 member-001   # loan 1
node dist/cli.js --db "$DB" checkout drill-01 member-002       # loan 2
node dist/cli.js --db "$DB" return 1
node dist/cli.js --db "$DB" checkout projector-01 member-004   # loan 3
```

Resulting state: `camera-01` and `microphone-01` available; `drill-01` (loan 2) and `projector-01`
(loan 3) on loan; loan 1 returned. Timestamps reflect when the commands ran. Do not commit generated
databases.
