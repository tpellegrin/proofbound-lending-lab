# Proposed requirements — not accepted

Status: **proposal for reflection, not accepted.** Revision 2 (author attempt `spec-author-2`), which
folds in the coordinator's adjudication recorded in `decisions/3.md` (settled choices S1–S7, findings
F1–F7, coordinator gap G1) and closes U1–U9. A fresh independent `spec-reflector` must still challenge
it and the coordinator adjudicates; the author does not approve this artifact.

Owner goal: `specs/BD-MIGRATION-BACKUP-1/goal.md`, sha256
`aa30a9e9365fc8c9c51d08ff2e2655b95441eef5f5950093a9169bd7133f7464`.
Task contract: `phases/design/tasks/requirements/contracts/r0001.md`, revision r0001.
Owner decision: `specs/BD-MIGRATION-BACKUP-1/owner-decision-destination.md` (destination contract **A**),
which settles publication behavior for a destination that was absent. `goal.md` is unchanged.
Coordinator decision: `decisions/3.md`, sha256
`7d9f6a028c11c21e06e9a34b11ba82fa625a34ea2de3a90d5473333056d6ff50`. Its S1–S7 are binding here and
must not be reopened; §10 records how each is encoded and what, if anything, remains open.

This document states numbered obligations for adding an explicit, verified **pre-migration backup** to
BorrowDesk's existing `migrate` command. It is the engineering thinking that precedes implementation; it
contains no code, tests or configuration. Every requirement is traceable to the owner goal; the coverage
map in §11 shows the trace. This is a proposal: a fresh independent `spec-reflector` must challenge it and
the coordinator adjudicates.

Terms used below:

- **source** — the database file named by `--db`, the file that would be migrated.
- **backup** — the independently usable v0 file this operation publishes at the `--backup` destination.
- **v0** — BorrowDesk schema version 1, the seed release (commit `63da90eb`): `application_id = 0x426F7244`
  ("BorD"), `user_version = 1`, the `items`/`loans` tables and `loans_one_active_per_item` index.
- **v2** — the current release's schema version 2 (v0 plus the `holds` table).
- **published** — the backup exists at the requested destination path.
- **temporary artifact** — an intermediate file used while producing the backup, before publication.
- **resolved path** — the `realpath` of the path's parent directory joined with its final component (the
  basename). The final component itself is **not** followed, so a symlink at the destination is not
  resolved to its target by this comparison.
- **SQLite-owned sibling names** of the source — the three names `<source>-journal`, `<source>-wal` and
  `<source>-shm` in the source's directory.

## 1. Scope, non-goals and existing behavior extended

- **R1.1** BorrowDesk gains exactly one new operator capability: the `migrate --backup <new-file>` option
  defined here. Nothing else changes.
- **R1.2** The goal's exclusions are binding and exhaustive: **do not** add an automatic restore command,
  in-place downgrade, scheduled backup service, retention policy, cloud storage, encryption system or a
  general migration framework.
- **R1.3** This task is **dependency-preserving**: implement with the already-vendored `better-sqlite3` and
  the standard library. Do not add packages. If a concrete incompatibility is demonstrated, stop and
  surface it for separate adjudication rather than adding a dependency.
- **R1.4 (behavior extended)** The change extends the existing `migrate` command and the existing
  "explicit migration" guarantee. It does not extend `init`, `report`, holds, loans or the schema. Plain
  `migrate` without `--backup` retains its current behavior exactly and **documentation must state that it
  does not create a backup**.
- **R1.5 (existing guarantees preserved)** The goal's guarantees remain true: explicit migration; atomic
  schema change; record and identifier preservation; idempotent migration on the current schema; existing
  concurrent-migration behavior; holds and loans remaining independent; and the documented loan-only
  meaning of `status`. None of these may be narrowed or reinterpreted.
- **R1.6 (historical records)** Previously produced, digest-pinned/hashed records remain historical: this
  change must not rewrite, re-hash or reinterpret them. The backup is a new artifact, not an edit of
  history.

## 2. CLI surface

- **R2.1** `migrate` accepts the new string option `--backup <path>`. Options may appear anywhere, as
  today; the value must be present and non-empty. The value is a filesystem path and is resolved the same
  way `report --out` resolves its path (relative paths resolve against the working directory).
- **R2.2** `--backup` is valid **only** for `migrate`. On any other command it is rejected with
  `INVALID_ARGUMENTS` (exit 2), consistent with the existing rule that an option not applicable to a
  command is rejected. `migrate --backup` with a missing or empty value is `INVALID_ARGUMENTS` (exit 2).
- **R2.3** The success/error envelope and exit-code policy are unchanged: one JSON document on stdout and
  exit 0 on success; one JSON document on stderr, no stack trace, exit 2 for rejected input/operation and
  exit 1 for unexpected failure.

## 3. Backup semantics and preservation claim

- **R3.1 (what is produced)** On a **v0** source, a successful `migrate --backup B` leaves, at `B`, a
  verified, independently usable **v0** backup of the application state immediately preceding the schema
  transition, **and** commits the migration. `B` is a valid BorrowDesk schema-version-1 file:
  `application_id = 0x426F7244`, `user_version = 1`, the v0 `items`/`loans` tables, their constraints and
  the partial unique index.
- **R3.2 (preservation claim — precise and testable)** Opening `B` as an independent SQLite connection
  yields:
  - `application_id = 0x426F7244` and `user_version = 1`;
  - `PRAGMA integrity_check` reports `ok`;
  - `items(id, name)`, `loans(id, item_id, borrower_id, checked_out_at, returned_at)` and
    `sqlite_sequence(name, seq)` are row-for-row and field-for-field equal to the source's pre-transition
    state captured under the migration lock (R7.1). This includes identifiers, timestamps and the
    **loan-ID allocation state**: `sqlite_sequence` for the `loans` `AUTOINCREMENT` is preserved, so a new
    checkout on `B` allocates the next loan id the source would have allocated.
  The backup **need not be byte-identical** to the source; the goal permits a different physical
  representation. The claim above is the preservation claim, stated in logical terms. (Measured probes
  against the vendored `better-sqlite3` 13.0.3: a synchronous snapshot taken under the migration write
  lock preserved these pragmas, rows and `sqlite_sequence`; `VACUUM INTO` cannot run inside a transaction,
  and the asynchronous online-backup API did not complete under the held write lock. The mechanism itself
  is the implementer's choice, bounded by R7.1 and R3.3 — see §10.)
- **R3.3 (verification before publication — S5)** Before the migration commits, the operation
  independently opens the produced file with a **fresh, read-only SQLite connection** (not
  `BorrowDesk.open`, which refuses v0) and requires:
  - `application_id = 0x426F7244` and `user_version = 1`;
  - `PRAGMA integrity_check` reports `ok`;
  - the v0 schema objects equal to the source's: for `items`, `loans`, `loans_one_active_per_item` and
    `sqlite_sequence`, the `sqlite_schema` columns `type`, `name`, `tbl_name` and `sql` are equal;
  - every `items`, `loans` and `sqlite_sequence` row equals the source's rows, read inside the same write
    transaction that holds the migration lock (R7.1).

  The file is published only after it passes. A mismatch is a verification failure and is handled as a
  backup failure (R5.1); nothing is published.
- **R3.4 (seed-version usability)** The backup is a v0-format database and is intended to be opened and
  used by the seed release's ordinary commands (`init`, `add-item`, `checkout`, `return`, `list-items`,
  `list-loans`, `report`). Because the current release's `BorrowDesk.open` intentionally refuses v0, this
  property is about the v0 release. The seed release is not in the working tree but **is** recoverable from
  this repository's own git history (commit `63da90eb`) with the same dependency pins; project tests must
  nevertheless stay hermetic (no git history, no network). The check strategy is R9.5.
- **R3.5 (independence)** The backup is a distinct file, **not** a hard link or a symlink to the source.
  Later writes to the source must not change the backup, and later writes to the backup must not change
  the source.
- **R3.6 (same state is backed up and migrated)** The state captured in the backup is the state that is
  migrated. No application write may commit between the backup snapshot and the migration commit (R7).
- **R3.7 (migration transition unchanged)** The schema transition itself is unchanged: it adds the `holds`
  table and sets `user_version = 2` in one `BEGIN IMMEDIATE` transaction, preserving every record. The
  backup does not alter the migration's own semantics.
- **R3.8 (no atomic-filesystem claim)** Do not claim that the backup and the source are one atomic
  filesystem operation, and do not claim resilience to hardware failure or power loss. State and test the
  preservation claim (R3.2) as the observed property; keep documented durability expectations separate.

## 4. Destination, publication and interruption

- **R4.1 (existing destination)** An existing destination is **never overwritten**, whatever its contents
  (including a file that is not a valid backup, an empty file or a directory). A destination that
  **aliases** the source, or that is one of the source's SQLite-owned sibling names, must be refused. This
  is the goal's rule, and it is **not** permission to delete an existing file because it is not a valid
  backup (owner decision A). Existing entries are never deleted, replaced, truncated or followed, whatever
  their contents.
- **R4.2 (destination validation for a v0 source — S3)** For a source that is v0 (and only then; see
  R4.5), the operation validates the destination before creating anything, changing nothing. Every refusal
  below is exit 2 with `field: "backup"`:
  - The destination's parent directory must exist and be a directory; otherwise `INVALID_OUTPUT_PATH`.
  - The destination's **resolved path** (see Terms; resolved against the working directory per R2.1) must
    not equal the source's resolved path, and must not equal the resolved path of any of the source's
    SQLite-owned sibling names `<source>-journal`, `<source>-wal` or `<source>-shm`. These are refused with
    `INVALID_OUTPUT_PATH` **whether or not** the file exists, because an ordinary v0 read of the source can
    delete a completed copy written at `<source>-journal`.
  - The destination is examined with `lstat` (never `stat`, so a symlink is not followed). If a directory
    entry exists there and is a directory, refuse with `INVALID_OUTPUT_PATH`. If a directory entry exists
    and is anything else — a regular file of any content, an empty file, a symlink including a dangling
    one, a hard link to anything, a socket — refuse with `OUTPUT_EXISTS`.
  - Order of evaluation within this requirement is parent directory, then resolved-path alias/sibling
    check, then `lstat`. This ordering is a routine engineering choice made here so the refusal code is
    deterministic and testable; it does not narrow any refusal above.
- **R4.3 (publication — owner decision A and S4)** For a destination that was absent, the file may appear
  at the requested path **only after** the backup has been completed and verified (R3.3). Concretely:
  - The snapshot mechanism is the implementer's choice, subject to R7.1: the write lock is held from
    before the snapshot until the migration commits, and no writer can commit in between.
  - Partial work goes to a **temporary file in the destination's directory**, named
    `<destination basename>.<at least 8 lowercase hex characters>.tmp` with a fresh random value per
    attempt. It is created **exclusively** (`O_EXCL`; never following a symlink), written, `fsync`ed and
    closed.
  - That same temporary file is verified (R3.3). Publication then makes the verified file appear at the
    destination **without overwriting**: a no-clobber hard link (`link()`) followed by removing the
    temporary name. `rename()` and any copy-over are **forbidden** because `rename()` replaces an existing
    name.
  - If the destination appeared concurrently between validation and publication, `link()` fails with
    `EEXIST`; that is a destination refusal with `OUTPUT_EXISTS` (exit 2, `field: "backup"`), the
    concurrent file is untouched, and no backup is reported. Any other `link()` failure is a backup
    failure (R5.1).
  - After publication, the destination directory is `fsync`ed before the migration commits. This is a
    documented expectation of this host's behavior; tests cannot observe it.
  - The published file has one link and its own inode. On any handled failure, the invocation removes the
    temporary files it created. A temporary file it cannot remove is reported (R6.4); an abrupt process
    interruption may leave one.
  - A pre-existing destination remains untouched; a concurrently created destination must not be
    overwritten.
- **R4.4 (completed vs partial)** A **completed** backup is the verified file published at the destination
  path per R3.3/R4.3. A **temporary artifact** is not a valid backup and must never be presented as one
  (e.g. in output or documentation). The temporary naming pattern is documented so an operator can
  recognize leftover partial work.
- **R4.5 (order of operations and precedence — S1)** The full order for `migrate --backup B` is:
  1. CLI argument validation (`INVALID_ARGUMENTS`).
  2. The existing `migrate` preconditions and refusals, unchanged and in their current order:
     `DATABASE_NOT_FOUND`, `INVALID_DATABASE_PATH`, `DATABASE_NOT_INITIALIZED`,
     `NOT_A_BORROWDESK_DATABASE`, `UNSUPPORTED_SCHEMA_VERSION`, `DATABASE_CORRUPT`.
  3. Acquire the source's write lock (`BEGIN IMMEDIATE`, existing 5 s busy timeout) and re-read the schema
     version inside it.
  4. If the re-read version is 2: **idempotent success** (R6.3), `migrated: false`, `backup: null`. The
     destination is **ignored entirely** — never examined for refusal, never created, never modified —
     whatever it is (absent, an old backup, a directory, a dangling symlink).
  5. Only if the re-read version is v0: validate the destination (R4.2), then create, verify and publish
     the backup (R4.3, R3.3), then run the unchanged schema change, then commit (R3.7).

  No destination or temporary artifact is created before step 5. Existing refusals always win over
  destination refusals.
- **R4.6 (durability as observed, not magical)** Document what is actually guaranteed: a completed backup
  is openable and matches R3.2. Do not document external-modification, hardware or power-loss immunity;
  state that the backup is not immune to later external modification, hardware failure or power loss, and
  that the directory `fsync` is an expectation, not a tested guarantee.

## 5. Failure handling

- **R5.1 (backup failure aborts cleanly — S6)** If backup creation or verification fails (an I/O error, a
  verification mismatch per R3.3, or any failure of the snapshot or of publication other than the
  no-clobber race in R4.3), this operation must **not** commit the migration and must **not** alter
  application records. It fails with the new code `BACKUP_FAILED` (exit 1), `error.backup` is `null`, and
  the source remains a valid v0 database. Nothing is published at the destination. Temporary artifacts
  owned by the invocation are removed where possible; a temporary file that cannot be removed is reported
  as `error.leftover` (R6.4).
- **R5.2 (backup published, migration fails — S6)** If a valid backup was published but the migration
  subsequently fails (the schema change or commit fails), the backup is **kept**. The invocation keeps the
  underlying error code and its exit class (for example `STORAGE_ERROR`, exit 1), sets `error.backup` to
  the published-backup object (R6.2), and its message says that the backup was kept and the migration was
  not committed. The source is not left partially migrated (R5.3).
- **R5.3 (migration atomicity preserved)** The existing atomicity holds: the schema change and
  `user_version` update either commit fully or roll back, leaving the source exactly as it was. A failure
  after publication must not leave a partially migrated file.
- **R5.4 (retry consequence)** Because an existing destination is never overwritten, after R5.2 a retry of
  `migrate --backup <same path>` refuses with `OUTPUT_EXISTS` until the operator chooses a new path or
  removes the retained backup. This must be documented as expected behavior, not a defect.

## 6. Output

- **R6.1 (plain migrate unchanged)** `migrate` without `--backup` returns exactly today's four fields
  `{ "database", "fromSchemaVersion", "schemaVersion", "migrated" }` with unchanged values, unchanged
  behavior and **no `backup` key**.
- **R6.2 (v0 with backup — S6)** `migrate --backup B` on a v0 source returns today's fields with
  `fromSchemaVersion: 1`, `schemaVersion: 2`, `migrated: true`, plus the additive object:

  ```json
  "backup": { "path": <absolute destination>, "created": true, "verified": true, "schemaVersion": 1 }
  ```

  `path` is the absolute destination path and identifies where the backup is.
- **R6.3 (idempotent on current schema — S1/S6)** `migrate --backup B` on a **v2** source is an
  idempotent success: today's fields with `fromSchemaVersion: 2`, `schemaVersion: 2`, `migrated: false`,
  plus `"backup": null`. The database is unchanged, **no backup is created**, and the destination is never
  examined or modified — so an existing old backup at `B` is not overwritten and is not reported as a
  pre-migration backup.
- **R6.4 (failure shapes — S6)** Every failure of a `migrate --backup` invocation **after argument
  parsing** carries an additive `error.backup`: `null` when no backup was published, or the published
  object of R6.2 when a backup was published and kept (R5.2). When the invocation left a temporary file it
  could not remove, the error document also carries `error.leftover`: the absolute path of that file.
  Argument-parsing failures (`INVALID_ARGUMENTS`) are outside this rule and carry no `backup` field. The
  existing error fields (`code`, `message`, optional `field`) and the exit-code policy are unchanged.

## 7. Concurrency

- **R7.1 (coordinate snapshot and commit)** Concurrent activity must not silently produce a backup older
  than the state being migrated. The operation acquires the source's write lock (`BEGIN IMMEDIATE`, using
  the existing `BUSY_TIMEOUT_MS` of 5 s) **before** capturing the backup snapshot and holds it through the
  backup snapshot, the verification (R3.3), the publication (R4.3) and the migration commit, so no other
  writer can commit between the snapshot and the transition. The mechanism is the implementer's choice
  (a synchronous snapshot taken inside the open `BEGIN IMMEDIATE` transaction was measured to work on this
  host; `VACUUM INTO` cannot run inside a transaction, and the asynchronous online-backup API did not
  complete under the held write lock).
- **R7.2 (bounded wait, safe refusal)** All waiting uses the existing 5 s `busy_timeout`. If the lock
  cannot be acquired within that timeout, the operation refuses safely: no migration, no backup published
  (temporary artifacts cleaned), `DATABASE_BUSY` (exit 1) with `error.backup: null`. Do not busy-wait
  unboundedly.
- **R7.3 (concurrent migrations preserved — S2)** Plain concurrent `migrate` keeps its existing behavior
  unchanged (the existing `test/migration.test.ts` concurrent test must pass unchanged). With `--backup`:
  an invocation that obtains the lock after another has migrated is an idempotent success per R4.5(4)
  with `backup: null`, whether it named a distinct destination or the same one. An invocation that cannot
  obtain the lock within the timeout fails `DATABASE_BUSY` (exit 1), creating nothing. Only the invocation
  that actually performs the v0 migration publishes a backup; losing invocations never publish one and
  never overwrite a destination.
- **R7.4 (no lost writer update)** A concurrent writer (checkout, return, hold, release) either commits
  before the snapshot (its effect is in both the backup and the migrated database) or after the migration
  commit (it operates on v2). It cannot commit into the window between snapshot and migration commit.

## 8. Compatibility

- **R8.1 (compatible surface)** Existing CLI behavior is unchanged except for: (a) the new `--backup`
  option on `migrate`; (b) additive output fields on `migrate --backup` (R6.2, R6.3); (c) additive error
  information on failure (`error.backup`, `error.leftover`, R6.4); (d) new destination refusals
  (`OUTPUT_EXISTS`, `INVALID_OUTPUT_PATH` with `field: "backup"`, R4.2) and the new backup-failure code
  `BACKUP_FAILED` (R5.1). `BACKUP_FAILED` is a new, additive extension of the documented error-code list;
  the owner's goal permits new refusal/failure cases for this option. This list is intended to be
  exhaustive and must be reconciled by reflection.
- **R8.2 (tests updated, not weakened)** Tests asserting exact `migrate` output may be extended for the
  additive fields only. No existing behavior test may be deleted, skipped or weakened to make this feature
  pass; in particular the existing concurrent-migration test and the existing `migrate` output tests must
  pass (extended only additively).
- **R8.3 (validation and schema unchanged)** Item/borrower/loan-id/name validation, the v0/v2 schema and
  pragmas, holds/loans independence, and the loan-only meaning of `status` are all unchanged.
- **R8.4 (documentation)** The behavior contract (`docs/behavior-v0.md`) and `README.md` must document:
  the new option and its success/failure/error shapes (R6); that plain `migrate` does **not** create a
  backup; the destination rules (R4.2); the temporary naming and what an interruption can leave (R4.3,
  R4.4); recovery by opening the backup with the **old (v0) application on a copy of the backup**; and
  that later writes to the migrated database are **not** contained in that backup. It must also state that
  the backup is not immune to later external modification, hardware failure or power loss, and that the
  directory `fsync` is an expectation, not a tested guarantee (R4.6). Documentation is a deliverable of
  implementation; this proposal cannot write it.

## 9. Checks

- **R9.1** The canonical check is **`npm run check`** (type-check + clean build + full `node --test`
  suite). It must pass on the completed change. CI runs the same command.
- **R9.2 (tests to add or extend — S7)** At minimum:
  - `migrate --backup` on a v0 source creates a destination file that passes R3.2 (pragmas, integrity,
    items/loans/identifiers/timestamps, `sqlite_sequence`) and is a v0 file;
  - the migration committed and preserves records exactly as today (regression of R3.7, R6.1);
  - independence (R3.5): the backup is not a hard link to the source; writing to either does not change
    the other;
  - each destination refusal of R4.2, deterministically: an existing regular file, an empty file, an
    existing directory, a missing parent, a parent that is not a directory, a destination that is the
    source path, and a destination that is one of the three SQLite-owned sibling names (present and
    absent); plus a **dangling symlink** destination;
  - each precedence case of R4.5: argument validation beats everything; an existing-`migrate` refusal
    (e.g. missing `--db`, or a corrupt source) beats a bad destination; and a v2 source with `--backup`
    ignores the destination;
  - the v2 idempotent case with an existing old backup at the destination (F1's witness) creates no backup,
    leaves the old file untouched and reports `backup: null`;
  - a verification-failure seam and a migration-failure-after-publication seam (R9.3);
  - a no-clobber race where the destination appears between validation and publication (a test seam is
    acceptable): the invocation refuses with `OUTPUT_EXISTS` (exit 2), publishes nothing and leaves the
    concurrently created file untouched;
  - a deterministic concurrent-writer test: another connection holds `BEGIN IMMEDIATE` with an uncommitted
    v0 write, `migrate --backup` starts and waits, the writer commits, and the backup must contain that
    write;
  - the losing-invocation case of R7.3 (`DATABASE_BUSY`, exit 1, nothing created);
  - `--backup` on a non-`migrate` command and `migrate --backup` with a missing/empty value are
    `INVALID_ARGUMENTS` (R2.2).
- **R9.3 (fault seams)** Verification needs deterministic fault seams analogous to the existing
  `MigrateOptions.onFirstSchemaChange`: at least one seam to force backup creation/verification failure and
  one to force migration failure after publication. The seams are test-only and not exposed by the CLI.
- **R9.4 (test hygiene)** Tests use temporary databases, stay deterministic (inject a clock; never sleep to
  separate timestamps), and clean up only what they create. Never commit databases, `dist/`, `dist-test/`
  or generated reports.
- **R9.5 (seed-usability check strategy — F2)** The goal's obligation is behavioral: the backup opens with
  the seed release and supports its ordinary commands. The seed release (commit `63da90eb`) is not in the
  working tree, but it **is** recoverable from this repository's git history with the same dependency pins.
  Because CI checks out with depth 1 and project tests must be hermetic (no git history, no network),
  project tests verify the backup **structurally** (R3.2: v0 pragmas, schema and rows via a fresh SQLite
  connection). The behavioral claim that the seed release operates on the backup is checked outside the
  project test suite by the coordinator's public acceptance script, which builds `63da90e` for real. This
  is a settled check strategy, not an open choice.

## 10. Settled choices and remaining open points

The coordinator's decision `decisions/3.md` settled U1–U9 and findings F1–F7 plus gap G1. This revision
encodes them as follows, and **no unresolved choice remains that requires coordinator adjudication**:

- **S1** (order of operations, precedence, and the v2 idempotent success) → R4.5, R6.3.
- **S2** (bounded wait; concurrent invocation outcomes) → R7.2, R7.3.
- **S3** (destination validation, including the SQLite-owned sibling names) → R4.2; the within-requirement
  evaluation order is a routine engineering choice stated in R4.2.
- **S4** (creation and publication; no-clobber `link()`; directory `fsync`; temp cleanup) → R4.3.
- **S5** (verification before publication) → R3.3.
- **S6** (output shapes and failure codes) → R5.1, R5.2, R6.1–R6.4.
- **S7** (checks) → R9.2, R9.3.
- **F1** (v2 + existing destination) → R4.5(4), R6.3.
- **F2** (seed-usability premise) → R3.4, R9.5.
- **F3** (precedence) → R4.5.
- **F4** (concurrent behavior overstated) → R7.3.
- **F5** (verify the temporary artifact) → R3.3, R4.3.
- **F6** (dangling symlink) → R4.2.
- **F7** (exit code after publication) → R5.2.
- **G1** (SQLite-owned sibling names) → R4.2.

Implementation-time choices explicitly delegated to the implementer by the decision, bounded by the
requirements above: the snapshot mechanism (R3.2/R4.3/R7.1) and the exact random temporary suffix
(R4.3). The coordinator noted the plausible downside that holding the write lock through snapshot,
verification and publication lengthens lock hold time; for BorrowDesk's small files this is milliseconds,
and R7.2 already bounds the waiting.

## 11. Goal coverage map

| Goal obligation (goal.md) | Requirement(s) |
| --- | --- |
| Add `migrate --backup <new-file>` | R1.1, R2.1 |
| v0 success leaves a verified, independently usable v0 backup before committing | R3.1–R3.3, R3.6 |
| Plain `migrate` retains current behavior; document it creates no backup | R1.4, R6.1, R8.4 |
| Backup preserves items, loans, identifiers, timestamps and loan-ID allocation state | R3.2 |
| Backup opens with the seed version and supports its ordinary commands | R3.1, R3.4, R9.5 |
| Independent file, not a hard link | R3.5, R4.3 |
| Existing destination never overwritten; alias of source refused | R4.1, R4.2, R4.3 |
| Backup/verification failure must not commit the migration or alter records | R5.1, R5.3 |
| Concurrent activity must not silently produce a backup older than the migrated state; coordinate or refuse within a bounded wait | R7.1–R7.4, R3.6 |
| Repeated invocation on current schema is idempotent; must not overwrite an old backup or pretend it made one | R6.3, R4.1, R4.5 |
| Valid backup created but migration fails: report state and location accurately | R5.2, R6.4, R5.4 |
| Success output identifies what happened and where the backup is | R6.2 |
| Documentation: recovery via old application on a copy; later writes not contained | R8.4 |
| Exclusions: no restore/downgrade/schedule/retention/cloud/encryption/framework | R1.2 |
| Dependencies unchanged unless incompatibility demonstrated | R1.3 |
| Do not claim backup+source atomicity; define interruption and distinguish completed vs partial | R3.8, R4.3, R4.4, R4.6 |
| Do not require byte-identical files; state and test the preservation claim precisely | R3.2 |
| Preserve explicit migration, atomic schema change, record/identifier preservation, idempotent migration, concurrent-migration behavior, holds/loans independence, loan-only `status` | R1.5, R8.3 |
| Old hashed records remain historical | R1.6 |
| Identify which existing behavior is extended | R1.4, R3.7 |
