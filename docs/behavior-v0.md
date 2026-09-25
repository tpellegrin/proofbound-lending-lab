# BorrowDesk behavior

This is the behavior contract for BorrowDesk. It documents the **current release** (schema version 2:
maintenance holds plus an explicit migration path from v0) and preserves the **v0** rules and schema
that later releases must keep migratable. Sections marked "version 1" describe the frozen v0 release
(commit `63da90eb`); everything else describes the current release.

## Domain rules

1. An **item** has a unique, stable id and a nonempty name. Items cannot be renamed or removed.
2. A **checkout** creates a new **loan** with a stable integer id, the item id, the borrower id and a
   `checkedOutAt` timestamp. Loan ids are assigned by SQLite (`AUTOINCREMENT`) and are never reused.
3. An item has at most one active loan. This holds across processes: write operations run in
   `BEGIN IMMEDIATE` transactions, and a partial unique index (`loans(item_id) WHERE returned_at IS NULL`)
   rejects a second active loan at the storage level.
4. Checking out an unknown item (`ITEM_NOT_FOUND`) or an item already on loan (`ITEM_UNAVAILABLE`) fails
   and changes nothing.
5. Returning an active loan sets `returnedAt`; the item is no longer on loan.
6. Returning an unknown loan (`LOAN_NOT_FOUND`) or a returned loan (`LOAN_ALREADY_RETURNED`) fails and
   changes nothing. The original `returnedAt` is kept.
7. Returned loans stay in history. Lending the same item again creates a new loan.
8. Data is stored in a single SQLite file and persists across processes.
9. Listing order:
   - Items are ordered by id, ascending, using byte-wise (ASCII) comparison. Because ids are restricted to
     `a-z 0-9 - . _`, this means `-` < `.` < digits < `_` < letters, and `drill-10` sorts before `drill-2`.
   - Loans (history and active) are ordered by loan id ascending, which is checkout order.
10. Listing and report generation only read the database. The database file is unchanged by them.
11. `init` on an existing BorrowDesk database changes nothing and reports its actual schema version and
    `alreadyInitialized: true`.
12. Invalid input is rejected before any change, with a clear message and the offending field.

### Maintenance holds

13. A **maintenance hold** is a durable fact about an item, independent of loans. An operator can
    **place** a hold with `hold <item-id>` and **remove** it with `release <item-id>`. Both require an
    existing item; an unknown id is rejected with `ITEM_NOT_FOUND` and changes nothing.
14. Placing a hold on an item that is already held, and releasing an item that is not held, **succeed**
    with `changed: false` and write nothing. Placing on a not-held item and releasing a held item return
    `changed: true`. Neither operation exposes or rewrites a hold timestamp; repeating an effective
    hold or removal never changes stored data.
15. Holds and loans are independent:
    - an item may be held while it is borrowed; placing or removing a hold does not alter, close or
      otherwise touch an outstanding loan;
    - returning the outstanding loan of a held item succeeds exactly as before and does **not** remove
      the hold.
16. An item is **available** if and only if it is neither held nor borrowed. A held item is not
    available whether or not it is also borrowed.
17. A held item cannot be newly checked out:
    - checkout of a held item that has **no active loan** is rejected with the new `ITEM_HELD` code
      (exit 2, `field: "itemId"`, nothing changed);
    - checkout of an item that **has an active loan** keeps failing with `ITEM_UNAVAILABLE` whether or
      not it is also held (loan precedence), preserving the v0 meaning of `ITEM_UNAVAILABLE`.
18. `status` on an item reports **loan state only**: `"on_loan"` if and only if the item has an active
    loan, otherwise `"available"`. It is not a hold indicator. The additive boolean `available` is the
    checkout availability from rule 16; the additive boolean `held` reports the hold. A held item with
    no loan therefore reads `status: "available"`, `activeLoan: null`, `held: true`, `available: false`.

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

`hold` and `release` take the same item-id validation as the other item commands. Borrower ids are
opaque labels such as `member-001`; there is no borrower registry.

## CLI

```
node dist/cli.js --db <path> <command> [arguments] [options]
```

| Command | Result `data` |
| --- | --- |
| `init` | `{ "database": <absolute path>, "schemaVersion": <actual stored version>, "alreadyInitialized": <bool>, "migrationRequired": <bool> }` |
| `migrate` | `{ "database": <absolute path>, "fromSchemaVersion": <n>, "schemaVersion": 2, "migrated": <bool> }` |
| `add-item <item-id> <name>` | `{ "item": Item }` |
| `list-items` | `{ "items": [Item, ...] }` |
| `hold <item-id>` | `{ "item": Item, "changed": <bool> }` |
| `release <item-id>` | `{ "item": Item, "changed": <bool> }` |
| `checkout <item-id> <borrower-id>` | `{ "loan": Loan }` |
| `return <loan-id>` | `{ "loan": Loan }` |
| `list-loans [--active]` | `{ "loans": [Loan, ...] }` (all loans, or only active ones with `--active`) |
| `report --out <file> [--force]` | `{ "path", "generatedAt", "itemCount", "loanCount", "activeLoanCount", "heldItemCount", "availableItemCount" }` |

- `--db` is required for every command except `--help`. Only `init` creates a database file; `init`
  requires the parent directory to exist. Other commands report `DATABASE_NOT_FOUND` or
  `DATABASE_NOT_INITIALIZED` instead of creating anything. `migrate` never creates a file.
- Options may appear anywhere; an option that does not apply to the command is rejected. Use `--`
  before positional arguments that begin with `-`.
- `report` refuses an existing output file (`OUTPUT_EXISTS`) unless `--force` is given, and never
  writes over the database file.
- `--help` / `-h` / `help` prints plain-text help to stdout and exits 0.

### Initialization and migration

- `init` on a new or empty file creates schema version 2 and reports `schemaVersion: 2`,
  `alreadyInitialized: false`, `migrationRequired: false`.
- `init` on a version 2 database changes nothing and reports `schemaVersion: 2`,
  `alreadyInitialized: true`, `migrationRequired: false`.
- `init` on a v0 database **succeeds and changes nothing** and reports `schemaVersion: 1`,
  `alreadyInitialized: true`, `migrationRequired: true`. It never migrates.
- `migrate` is the only operation that migrates. On a v0 database it upgrades the file to version 2
  atomically and returns `fromSchemaVersion: 1`, `schemaVersion: 2`, `migrated: true`. On a version 2
  database it is an idempotent success that changes nothing (`fromSchemaVersion: 2`, `migrated: false`).
- Ordinary application commands (every command except `init` and `migrate`), **including the read-only
  `list-items`, `list-loans` and `report`**, refuse a v0 database with `MIGRATION_REQUIRED` (exit 2)
  and leave the file byte-identical. They never silently upgrade and never report
  `UNSUPPORTED_SCHEMA_VERSION` for a v0 file.
- `migrate` refuses bad input without replacing the file:
  - missing file → `DATABASE_NOT_FOUND` (no file created);
  - empty file → `DATABASE_NOT_INITIALIZED` (unchanged);
  - not SQLite, or a SQLite file not created by BorrowDesk → `NOT_A_BORROWDESK_DATABASE`;
  - a BorrowDesk database at a version this release does not know → `UNSUPPORTED_SCHEMA_VERSION`;
  - a BorrowDesk database that fails SQLite's integrity check → `DATABASE_CORRUPT` (exit 2, unchanged).
    `migrate` runs the integrity check before changing anything.

Shapes:

```json
Item: { "id": "drill-01", "name": "Cordless drill", "status": "on_loan",
        "activeLoan": { "id": 2, "borrowerId": "member-002", "checkedOutAt": "2026-09-24T14:03:00.000Z" },
        "held": false, "available": false }

Loan: { "id": 2, "itemId": "drill-01", "borrowerId": "member-002",
        "checkedOutAt": "2026-09-24T14:03:00.000Z", "returnedAt": null, "status": "active" }
```

`status` reports loan state only (`"available"` with `"activeLoan": null` when not on loan). `held` is
true when a maintenance hold is effective. `available` is the checkout availability (neither held nor
borrowed). The four combinations are:

| State | `status` | `activeLoan` | `held` | `available` |
| --- | --- | --- | --- | --- |
| available, not held | `"available"` | `null` | `false` | `true` |
| held, not borrowed | `"available"` | `null` | `true` | `false` |
| borrowed, not held | `"on_loan"` | set | `false` | `false` |
| borrowed and held | `"on_loan"` | set | `true` | `false` |

`Loan.status` is `"returned"` and `returnedAt` is set once returned.

### Output envelope and exit codes

Success: exit code 0, one JSON document on stdout, nothing on stderr.

```json
{ "ok": true, "command": "hold", "data": { "item": { "id": "drill-01", "held": true, "available": false, ... }, "changed": true } }
```

Failure: nothing on stdout, one JSON document on stderr, no stack trace.

```json
{ "ok": false, "command": "checkout", "error": { "code": "ITEM_HELD", "message": "Item drill-01 has a maintenance hold", "field": "itemId" } }
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
| 2 | `DATABASE_CORRUPT` | `migrate` found a BorrowDesk database that fails SQLite's integrity check |
| 2 | `MIGRATION_REQUIRED` | An ordinary command was run against a v0 database; run `migrate` |
| 2 | `ITEM_ALREADY_EXISTS` | `add-item` with an id already registered |
| 2 | `ITEM_NOT_FOUND` | `hold`, `release` or `checkout` of an unknown item |
| 2 | `ITEM_UNAVAILABLE` | `checkout` of an item that has an active loan (including a lost concurrent race) |
| 2 | `ITEM_HELD` | `checkout` of a held item that has no active loan |
| 2 | `LOAN_NOT_FOUND` | `return` of an unknown loan |
| 2 | `LOAN_ALREADY_RETURNED` | `return` of a returned loan |
| 2 | `OUTPUT_EXISTS` | `report` target exists and `--force` was not given |
| 2 | `INVALID_OUTPUT_PATH` | `report` target is a directory, the database file, or its directory is missing |
| 1 | `DATABASE_BUSY` | Another process held the database lock for more than 5 seconds |
| 1 | `STORAGE_ERROR` | Any other SQLite failure (e.g. read-only file, disk full, corruption of an ordinary command) |
| 1 | `INTERNAL_ERROR` | Unexpected program error |

### Concurrency

Every command opens the database, does its work in one transaction and closes it. Writers take the
write lock up front and wait up to 5 seconds (`busy_timeout`) for other processes. When several
processes check out the same item at once, exactly one succeeds; the others then see the item on loan
and fail with `ITEM_UNAVAILABLE`. `hold`, `release` and `checkout` all use `BEGIN IMMEDIATE`, so a hold
and a checkout serialize: a checkout that wins inserts the loan, and a hold that wins makes the checkout
fail with `ITEM_HELD` (or `ITEM_UNAVAILABLE` if the item also has an active loan). The database uses
SQLite's default rollback journal (no `-wal`/`-shm` files persist).

## Dashboard

`report` writes one HTML file: equipment with availability, current borrower and held state, active
loans, and complete loan history, plus summary counts. The equipment table reports **borrowed**, **held**
and **available** as separate facts, so an item can show both borrowed and held at once. The summary
shows available, on-loan (items with an active loan) and held counts; these may overlap, so
`available + on loan + held` need not equal the item count, and the page says so. It is labeled as a
read-only snapshot with its generation time, reflects one consistent read of the database, escapes all
stored text, embeds its CSS, contains no JavaScript, and loads nothing from the network (a
Content-Security-Policy meta tag enforces this).

## Database schema (version 2)

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

CREATE TABLE holds (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES items (id),
  held_at TEXT NOT NULL
) STRICT;
```

A version 2 database is recognized by `PRAGMA application_id = 0x426F7244` ("BorD") and
`PRAGMA user_version = 2`. `held_at` is internal: it is never exposed in `Item` and is never rewritten
by an idempotent `hold`/`release`. Migration from v0 adds exactly the `holds` table and sets
`user_version = 2`; it preserves the `items` and `loans` tables, their constraints, the partial unique
index and every existing row (items start without a hold). The whole migration runs in one
`BEGIN IMMEDIATE` transaction.

## Database schema (version 1)

The frozen v0 schema, still needed to build compatibility fixtures:

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
`PRAGMA user_version = 1`. The current release opens it only through `migrate`; ordinary commands
refuse it with `MIGRATION_REQUIRED`.

## Creating a populated v0 database for compatibility tests

This procedure describes the **v0 release, commit `63da90eb`**. After this change `init` creates version
2, so the current release cannot produce a v0 file. Tests build their v0 fixtures in process from the
version 1 DDL above; a v0 database otherwise comes from that release.

With the v0 release, use only public commands, so the file is exactly what v0 produces. Either run the
demo into a new directory (the database is `<dir>/borrowdesk.db`):

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
