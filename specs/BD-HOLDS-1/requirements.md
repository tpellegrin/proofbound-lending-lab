# Proposed requirements — not accepted

Status: **proposal for reflection, not accepted.**
Owner goal: `specs/BD-HOLDS-1/goal.md`, sha256
`3dff6bc17f7a3ea201d4847917052dd278451dc75e2992dfa0866d7eb14a81f6`.
Task contract: `phases/design/tasks/requirements/contracts/r0001.md`, revision r0001.
Repair authority: coordinator decision `decisions/3.md`, sha256
`d1b122e6c895fbd3ed370edebbf896c0524f7e819ac1511b2cb30831c3851a80`.

This document states numbered obligations for adding **maintenance holds** to BorrowDesk and an
explicit **v0 → version 2 migration path**. It is the engineering thinking that precedes
implementation; it contains no code, tests or configuration. Every requirement is traceable to the
owner goal; the coverage map in §9 shows the trace.

Revision note: this revision addresses the accepted challenge findings F1–F5 of `spec-reflector-1`
and records the coordinator's adjudication of every choice the previous revision left open. §8 now
states settled decisions and holds no open question. It remains a proposal: a fresh independent
reflection is still required before acceptance, and the author does not approve this artifact.

Terms used below:

- **borrowed** — the item has an active (unreturned) loan.
- **held** — a maintenance hold is effective on the item.
- **available** — the item is neither borrowed nor held.

## 1. Scope and non-goals

- **R1.1** BorrowDesk gains exactly two new operator capabilities — placing (`hold`) and removing
  (`release`) a maintenance hold on an item — plus the explicit `migrate` operation needed to read
  existing v0 databases.
- **R1.2** The following are explicitly **out of scope** and must not be added: maintenance
  scheduling; hold notes or hold history; reservations; due dates; borrower accounts; authentication;
  an editable web application.
- **R1.3** This task is **dependency-preserving**: implement with the already-vendored
  `better-sqlite3` and standard library only. Do not add packages. If a concrete need for a new
  dependency is identified, stop and surface it for separate adjudication rather than adding it.

## 2. Domain requirements

### 2.1 Placing and removing holds

- **R2.1 (place)** `hold <item-id>` places a maintenance hold on an **existing** item. On success the
  item is held, and the command returns `{ "item": Item, "changed": true }` where `Item` is the
  updated item exactly as `add-item` returns it (shape per R3.2). The item's id, name, loans and
  timestamps are otherwise unchanged.
- **R2.2 (place unknown)** `hold` on an unknown item id is rejected with the existing `ITEM_NOT_FOUND`
  code (`field: "itemId"`) and changes no domain state.
- **R2.3 (place idempotent)** `hold` on an item that is already held **succeeds** (not an error),
  returns `changed: false`, writes nothing, and changes no stored value — in particular, if the
  implementation stores a hold timestamp (R5.6), that timestamp is unchanged.
- **R2.4 (remove)** `release <item-id>` removes a maintenance hold from an **existing** item. On
  success the item is no longer held, and the command returns `{ "item": Item, "changed": true }`.
  The item's id, name, loans and timestamps are otherwise unchanged.
- **R2.5 (remove unknown)** `release` on an unknown item id is rejected with `ITEM_NOT_FOUND`
  (`field: "itemId"`) and changes no domain state.
- **R2.6 (remove idempotent)** `release` on an item that is not held **succeeds**, returns
  `changed: false`, writes nothing and changes no stored value.
- **R2.7 (payload and validation)** `hold` and `release` return exactly
  `{ "item": Item, "changed": <bool> }`. They accept the same item-id validation as existing item
  commands (R4.3); an invalid id is rejected with `INVALID_INPUT` before any change.
- **R2.8 (rejection changes nothing)** Any rejected `hold`/`release` request leaves the database
  byte-identical to its prior state (matching the existing "fails and changes nothing" convention).
  The unknown-id and invalid-id checks run before any write.
- **R2.9 (write transaction)** `hold` and `release` run inside `BEGIN IMMEDIATE` write transactions
  like the other writers, so a hold and a concurrent checkout serialize (R2.14).

### 2.2 Holds and loans are independent

- **R2.10 (hold while borrowed)** An item may be held while it is borrowed. Placing a hold must not
  alter, close or otherwise touch the outstanding loan.
- **R2.11 (return while held)** Returning the outstanding loan of a held item remains allowed and
  succeeds exactly as today; it does **not** remove the hold.
- **R2.12 (remove while borrowed)** Removing a hold does not alter or close an outstanding loan.
- **R2.13 (availability)** An item is **available** if and only if it is neither held nor borrowed.
  A held item that is not borrowed is not available; a held item that is borrowed is not available.
- **R2.14 (checkout restriction)** A held item cannot be newly checked out. Checkout of a held item
  that has **no active loan** is rejected with the new `ITEM_HELD` code (exit 2, `field: "itemId"`,
  nothing changed). Checkout of an item that **has an active loan** keeps failing with
  `ITEM_UNAVAILABLE` whether or not the item is also held (loan precedence), preserving the
  documented v0 meaning of `ITEM_UNAVAILABLE` (an active loan). The held check and the loan insert
  happen in the same `BEGIN IMMEDIATE` write transaction, so a concurrent hold and checkout
  serialize; competing checkouts still yield exactly one loan and `ITEM_UNAVAILABLE` for the rest.
  This is the single intentional change to checkout behavior; every other checkout rule (unknown item
  → `ITEM_NOT_FOUND`, concurrency) is unchanged.

## 3. Exposure in listings and dashboard

- **R3.1 (separate exposure)** Item listings and the HTML dashboard expose **borrowed** and **held**
  as separate facts; both may be true for the same item at once.
- **R3.2 (item shape — settled)** Do **not** add a new `status` value. `status` keeps its documented
  v0 meaning and value set: `"on_loan"` if and only if the item has an active loan, otherwise
  `"available"`. It describes **loan state only**, exactly as `docs/behavior-v0.md` defines it
  (`"available"` with `activeLoan: null` "when not on loan"). Add two additive booleans:
  - `held` — a maintenance hold is effective;
  - `available` — the item is neither held nor borrowed (R2.13), i.e. the checkout availability.

  A held item with no loan reads `status: "available"`, `available: false`, `held: true`. An item
  that is both borrowed and held reads `status: "on_loan"`, `activeLoan` set, `held: true`,
  `available: false`. Existing v0 states read `held: false`, `available: true` and their existing
  `status`, so v0 data is unaffected. The behaviour contract (R7.4) must state plainly that `status`
  reports loan state only and that `available` is the checkout availability.
- **R3.3 (dashboard)** The dashboard shows, per item, availability, the current borrower and held as
  separate facts; both can show at once. Its summary reports **available**, **on-loan** (items with
  an active loan) and **held** counts, explicitly allowing overlap: because an item can be both
  borrowed and held, `available + on-loan + held` is not required to equal the item count and the
  summary must not imply that it does. This replaces the current `items.length − available` "on loan"
  computation.
- **R3.4 (ordering unchanged)** Item listings remain ordered by id ascending (byte-wise) and loan
  listings by loan id ascending. Holds do not change ordering or add listing entries.
- **R3.5 (read-only preserved)** Listing, snapshot and report generation remain read-only: they must
  not modify the database file.

## 4. Compatibility

- **R4.1 (preservation)** Placing/removing holds and migrating a v0 database must preserve every
  existing item id, item name, loan id, borrower id, `checkedOutAt`, `returnedAt` and the complete
  loan history. No identifiers are renumbered and no timestamps are rewritten.
- **R4.2 (compatible surface)** Existing CLI behavior remains compatible except for the following
  documented exceptions, and this list is exhaustive:
  (a) the intentional held-item checkout restriction (R2.14);
  (b) documented **additive** output fields: `Item.held`, `Item.available`, the `report`
  `heldItemCount` and `availableItemCount` fields, and the additive `init` `migrationRequired`
  boolean (R5.5);
  (c) the schema version reported by `init`, now the file's actual stored version (2 for a new or
  current database, 1 for a v0 database — R5.2, R5.4);
  (d) the new `hold`, `release` and `migrate` commands and the new error codes `ITEM_HELD`,
  `MIGRATION_REQUIRED` and `DATABASE_CORRUPT` (§8);
  (e) the **migration boundary**: every ordinary command, read-only commands included
  (`list-items`, `list-loans`, `report`), refuses a v0 database with `MIGRATION_REQUIRED` (R6.1)
  instead of succeeding. The goal's "ordinary application commands must not silently migrate"
  requires this; it is stated here as a migration boundary rather than left as an unlisted
  exception.
- **R4.3 (validation unchanged)** Hold/release accept the same item-id validation as existing item
  commands (1–64 chars, `a-z 0-9 - _ .`, first char alphanumeric, no normalization). Invalid ids are
  rejected with `INVALID_INPUT` before any change, exactly as today.
- **R4.4 (envelope/exit unchanged)** New commands use the existing JSON success/error envelope, the
  same exit-code policy (0 success, 2 rejected input/operation, 1 unexpected failure) and the same
  "no stack trace on stderr" rule.
- **R4.5 (existing tests updated, not weakened)** Tests that assert exact `Item`/`init`/`report`
  shapes must be updated to the additive shape. No existing behavior test may be deleted, skipped or
  weakened to make the new feature pass.

## 5. Schema and initialization

- **R5.1 (new schema)** The release defines schema **version 2** (stored in SQLite's `user_version`).
  It preserves the v0 tables (`items`, `loans`), their constraints and the partial unique index
  enforcing at most one active loan per item. `application_id` is unchanged (`0x426F7244`, "BorD").
- **R5.2 (init creates new schema)** `init` on a new or empty file creates schema version 2 and
  reports `schemaVersion: 2`, `alreadyInitialized: false`, `migrationRequired: false`.
- **R5.3 (init idempotent on current)** `init` on a database already at version 2 changes nothing and
  reports `schemaVersion: 2`, `alreadyInitialized: true`, `migrationRequired: false`.
- **R5.4 (init on v0)** `init` on an existing v0 database **succeeds and changes nothing**, and
  reports `alreadyInitialized: true`, the file's actual stored `schemaVersion` (1) and
  `migrationRequired: true`. It does not migrate. This keeps v0 `init`'s idempotent success semantics
  (a no-op success on an existing BorrowDesk database that reports its version) while pointing at the
  migration path.
- **R5.5 (init result shape)** The `init` result is
  `{ "database": <absolute path>, "schemaVersion": <actual stored version>, "alreadyInitialized": <bool>, "migrationRequired": <bool> }`.
  `migrationRequired` is the only additive field; it is true exactly when the file is a known
  BorrowDesk database below version 2 (that is, v0).
- **R5.6 (storage representation)** How hold state is stored is an implementation choice (for
  example a nullable column on `items`, or a separate one-row-per-item `holds` table). It must
  satisfy R2.3/R2.6 idempotency, R2.10–R2.12 independence from loans, R4.1 preservation and the
  migration requirements in §6. No hold timestamp is exposed in `Item`; if the implementation stores
  one, an idempotent repeat (R2.3/R2.6) must not change it.

## 6. Migration from v0

- **R6.1 (no silent migration)** No ordinary application command may migrate an old database.
  "Ordinary application command" means every command other than `init` and `migrate`. When any
  ordinary command — **including the read-only `list-items`, `list-loans` and `report`** — is run
  against a v0 database it fails with the new code `MIGRATION_REQUIRED` (exit 2) whose message names
  the `migrate` command, and leaves the file byte-identical. It must not silently upgrade, must not
  modify or replace the file, and must **never** be misreported as `UNSUPPORTED_SCHEMA_VERSION` (the
  version is known and supported through migration).
- **R6.2 (explicit migration path)** The release provides a dedicated `migrate` command that upgrades
  a v0 database to version 2. It is the only operation that migrates; `init` never does (R5.4).
- **R6.3 (migration result shape)** On success `migrate` returns
  `{ "database": <absolute path>, "fromSchemaVersion": <n>, "schemaVersion": 2, "migrated": <bool> }`.
- **R6.4 (migration outcomes)** On a v0 database `migrate` migrates it and returns
  `fromSchemaVersion: 1`, `migrated: true`. On a database already at version 2 it is an idempotent
  success that changes nothing and returns `fromSchemaVersion: 2`, `migrated: false`.
- **R6.5 (migration preserves records)** Migration preserves all existing records per R4.1, and every
  existing item starts **without a hold** (`held: false`, `available` per R2.13).
- **R6.6 (migration atomic)** The whole migration — schema change, data preservation and
  `user_version` update — runs in one `BEGIN IMMEDIATE` transaction: it either commits fully (all
  records preserved, new schema recorded) or leaves the database exactly as it was. A failure partway
  must not leave a partially migrated file. Verification (R7.2) uses an in-process fault-injection
  seam that forces a failure after the first schema change and asserts the database is still v0 with
  identical schema, pragmas (`application_id`, `user_version`) and rows.
- **R6.7 (migration idempotent)** Running `migrate` on a database already at version 2 is an
  idempotent success that changes nothing (R6.4).
- **R6.8 (reject without replacement)** `migrate` refuses each bad input with the stated code and
  leaves the file byte-identical (or creates no file):
  - missing file → `DATABASE_NOT_FOUND` (no file created);
  - empty file → `DATABASE_NOT_INITIALIZED` (unchanged);
  - not SQLite, or a SQLite file not created by BorrowDesk → `NOT_A_BORROWDESK_DATABASE`;
  - a BorrowDesk database at a version this release does not know (including a future version) →
    `UNSUPPORTED_SCHEMA_VERSION`;
  - a SQLite file that is a BorrowDesk database but fails SQLite's integrity check → the new code
    `DATABASE_CORRUPT` (exit 2, byte-identical). `migrate` runs SQLite's integrity check before
    changing anything.
- **R6.9 (ordinary-command corruption classification unchanged)** Ordinary commands keep v0's
  existing classification of SQLite corruption: `SQLITE_NOTADB` →
  `NOT_A_BORROWDESK_DATABASE`; any other corruption → `STORAGE_ERROR` (exit 1). Ordinary commands
  never modify or replace the file. `DATABASE_CORRUPT` is specific to `migrate`.
- **R6.10 (v0 loans returnable)** Outstanding loans created under v0 remain returnable through the
  normal `return` command after migration, preserving their original `checkedOutAt` and loan id.

## 7. Checks

- **R7.1** The canonical check is **`npm run check`** (type-check + clean build + full `node --test`
  suite). It must pass on the completed change. CI runs the same command.
- **R7.2** Tests must be added or extended to cover, at minimum:
  - hold/release success payloads (`{ item, changed }`), unknown-item rejection, and both idempotency
    cases (R2.1–R2.9);
  - hold-while-borrowed, return-while-held, remove-while-borrowed (R2.10–R2.12);
  - the availability invariant and the checkout restriction including loan precedence (`ITEM_HELD`
    for held-and-unborrowed vs `ITEM_UNAVAILABLE` for an active loan) (R2.13–R2.14);
  - the separate borrowed/held/available exposure in listings and dashboard, including an item that
    is both (R3.1–R3.3);
  - `init` creating version 2; `init` on a v0 database (no-op, `migrationRequired: true`, actual
    version 1); `init` on a current database (R5.2–R5.5);
  - migration: no silent migration by ordinary commands including read-only ones; preservation of
    items/loans/borrowers/timestamps/history; existing items start unheld; atomicity proven with the
    fault seam (R6.6); idempotent re-run; rejection of missing/empty/foreign/corrupt/unsupported
    without replacement, including a `DATABASE_CORRUPT` witness; and that a v0 outstanding loan is
    returnable after migration (R5, R6).
- **R7.3 (v0 fixtures)** Migration/compatibility tests build their v0 fixture **in process**, not with
  the current release's public commands: they execute the exact documented v0 DDL from
  `docs/behavior-v0.md` ("Database schema (version 1)") against a temporary file through
  `better-sqlite3`, set `application_id = 0x426F7244` and `user_version = 1`, and insert rows with
  fixed timestamps. (After this change `init` creates version 2, so the current release cannot
  produce a v0 file; the behaviour doc's "Creating a populated v0 database" procedure describes the
  **v0 release, commit `63da90eb`**, and a v0 database otherwise comes from that release.) Tests use
  temporary databases, stay deterministic (inject a clock; never sleep to separate timestamps) and
  clean up only what they create.
- **R7.4 (docs)** The behavior contract document (`docs/behavior-v0.md` and/or its successor) must be
  updated with the new commands, JSON shapes (including `Item.held`/`Item.available` and the fact
  that `status` reports loan state only), error codes (`ITEM_HELD`, `MIGRATION_REQUIRED`,
  `DATABASE_CORRUPT`), schema version 2 and migration semantics. Documentation is a deliverable of
  implementation; this proposal cannot write it.

## 8. Adjudicated decisions (settled)

The coordinator's decision `decisions/3.md` settles every choice the previous revision left open.
Each is recorded here as binding on implementation; nothing in this section remains open.

1. **Hold/remove CLI verbs.** `hold <item-id>` and `release <item-id>` — short imperatives that pair
   like `checkout`/`return`. (R2.1, R2.4)
2. **Checkout of a held item.** A held item with no active loan → new `ITEM_HELD`, exit 2,
   `field: "itemId"`, nothing changed. An item with an active loan keeps `ITEM_UNAVAILABLE` whether
   or not it is held (loan precedence), preserving the documented v0 meaning of `ITEM_UNAVAILABLE`
   (an active loan). The held check and the loan insert share one `BEGIN IMMEDIATE` write
   transaction, so a concurrent hold and checkout serialize and competing checkouts still yield
   exactly one loan and `ITEM_UNAVAILABLE` for the rest. (R2.14)
3. **Ordinary commands on a v0 database.** New code `MIGRATION_REQUIRED`, exit 2, message names the
   `migrate` command, file byte-identical. Never `UNSUPPORTED_SCHEMA_VERSION` for a v0 file.
   Read-only commands are included. (R6.1, R4.2e)
4. **`init` on a v0 database.** Succeeds, changes nothing, reports `alreadyInitialized: true` and the
   file's actual `schemaVersion` (1), plus the additive boolean `migrationRequired: true` (false on a
   current database and after creating a new one). `init` on a new or empty file creates schema
   version 2. This preserves v0 `init` idempotency and does not migrate. (R5.2–R5.5)
5. **Migration.** A dedicated `migrate` command returning
   `{ database, fromSchemaVersion, schemaVersion: 2, migrated }` (R6.3–R6.4). Refusals: missing
   `DATABASE_NOT_FOUND`; empty `DATABASE_NOT_INITIALIZED`; not SQLite / not BorrowDesk
   `NOT_A_BORROWDESK_DATABASE`; unknown BorrowDesk version `UNSUPPORTED_SCHEMA_VERSION`; failed
   integrity check `DATABASE_CORRUPT` (exit 2). Every refusal is byte-identical. The whole migration
   is atomic in one `BEGIN IMMEDIATE` (R6.6). The new schema version is pinned as `user_version = 2`;
   `application_id` is unchanged. (R6.1–R6.10)
6. **Item shape.** No new `status` value; `status` keeps its v0 meaning and value set. Add additive
   booleans `held` and `available`; a held, unborrowed item reads `status: "available"`,
   `available: false`, `held: true`. The behaviour contract states that `status` reports loan state
   only and that `available` is the checkout availability. No hold timestamp is exposed; storage is
   the implementer's choice, and an idempotent repeat must not change a stored timestamp. (R3.2,
   R5.6)
7. **Report and dashboard.** `report` data gains the additive `heldItemCount` and
   `availableItemCount`; existing fields are unchanged. The dashboard shows, per item, availability,
   the current borrower and held as separate facts (both can show at once), and its summary shows
   available, on-loan (items with an active loan) and held counts allowing overlap, replacing the
   `items.length − available` "on loan" computation. (R3.3)

## 9. Goal coverage map

| Goal obligation | Requirement(s) |
| --- | --- |
| Place/remove a hold on an existing item | R2.1, R2.4 |
| A held item cannot be newly checked out | R2.14 |
| An item can be held while it is borrowed | R2.10 |
| Returning its outstanding loan remains allowed and does not remove the hold | R2.11 |
| Removing a hold does not alter or close an outstanding loan | R2.12 |
| Available only when neither hold nor active loan | R2.13 |
| Listings and dashboard expose borrowed and held separately; both can be true | R3.1–R3.3 |
| Unknown item identifiers rejected without changing state | R2.2, R2.5, R2.8 |
| Repeating an effective hold/removal succeeds without further changes | R2.3, R2.6 |
| Existing ids, borrowers, timestamps and loan history preserved | R4.1, R6.5 |
| Existing CLI behavior compatible except checkout restriction + additive fields | R4.2–R4.4 |
| Ordinary commands must not silently migrate | R6.1 |
| Initializing a new database creates the new schema | R5.1, R5.2 |
| Migration preserves records; existing items start without holds | R6.5 |
| Migration is atomic | R6.6 |
| Repeating migration on a current database is an idempotent success | R6.4, R6.7 |
| Missing/foreign/corrupt/unsupported rejected without replacement | R6.8, R6.9 |
| Outstanding v0 loans remain returnable after migration | R6.10 |
| No scheduling/notes/history/reservations/due dates/accounts/auth/editable web | R1.2 |
| Dependency-preserving unless separately adjudicated | R1.3 |
