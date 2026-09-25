# BorrowDesk: explicit, verified pre-migration backup (BD-MIGRATION-BACKUP-1)

The owner's goal, verbatim, from the owner's instructions of 2026-09-24. Only the section headings
were added.

## Existing guarantees to preserve

Preserve these existing guarantees:

* Explicit migration.
* Atomic schema change.
* Record and identifier preservation.
* Idempotent migration on the current schema.
* Existing concurrent-migration behavior.
* Holds and loans remaining independent.
* The documented loan-only meaning of status.

Old hashed records remain historical. New requirements must identify which existing behavior they extend.

## Owner goal

Add an explicit option:

migrate --backup <new-file>

For a v0 database, successful use of this option must leave a verified, independently usable v0 backup before committing the migration.

Existing migrate without this option retains its current behavior. Document that it does not create a backup.

## Behavioral constraints

* The backup preserves the application state immediately preceding the schema transition, including items, loans, identifiers, timestamps and loan-ID allocation state.
* The backup opens with the seed version of BorrowDesk and supports its ordinary commands.
* It is an independent file, not a hard link to the source.
* An existing destination is never overwritten. A destination that aliases the source must be refused.
* If backup creation or verification fails, this operation must not commit the migration or alter application records.
* Concurrent activity must not silently produce a backup older than the state being migrated. Coordinate the operations or refuse safely within a bounded wait.
* A repeated invocation on a current-schema database remains an idempotent success. It must not overwrite an old backup or pretend it created a pre-migration backup.
* If a valid backup was created but migration subsequently fails, report that state and the backup location accurately.
* Success output identifies what happened and where the backup is.
* Documentation explains recovery using the old application on a copy of the backup, and that later writes to the migrated database are not contained in that backup.

## Exclusions

Do not add an automatic restore command, in-place downgrade, scheduled backup service, retention policy, cloud storage, encryption system or general migration framework.

Keep dependencies unchanged unless a concrete incompatibility is demonstrated.

Do not claim the backup and source database are one atomic filesystem operation. Define interruption behavior and distinguish a completed backup from a partial artifact.

Do not require byte-identical backup files if the chosen SQLite mechanism preserves the required database state through a different physical representation. State and test the preservation claim precisely.
