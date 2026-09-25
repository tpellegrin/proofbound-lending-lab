# Owner decision: two accepted limitations of the sibling-name guard

The owner made this decision on 2026-09-24, after requirements revision 2 was challenged (attempt
`spec-reflector-2`). The coordinator recorded it after the requirements were accepted and before the
consistency review. It does not change `requirements.md`. It records two known limitations that the
delivery's documentation and evidence must state, and that acceptance records as observations rather
than pass criteria.

**F-A.** R4.2 compares the destination with the source's SQLite-owned names (`<source>-journal`,
`<source>-wal`, `<source>-shm`) as exact strings. On a case-insensitive file system (macOS by
default), a destination that is a case variant of one of those names is not refused. The backup is
published and verified there, and a later ordinary write to the source can delete it. Witnessed on
this host: source `DB.sqlite`, destination `db.sqlite-journal`.

**F-B.** R4.2 derives those names from the `--db` path as named. When `--db` is a symlink, SQLite
keeps its journal beside the link's real target, so a destination at the target's journal name is
not refused, and can be deleted in the same way.

In both cases the source and its migration are unaffected; only that backup can be lost. Both need
the operator to name a SQLite-internal journal path. The owner's answer, verbatim (the option
selected): "Accept, document limits (Recommended)", described as follows:

> Accept the current requirements. F-A and F-B go into the delivery's docs and the evidence as known
> limitations, and acceptance records them as observations rather than pass criteria. That keeps the
> $0.50 cutoff and the remaining slots for implementation, review and one repair. Both holes need
> the operator to name a SQLite-internal journal path; the source and the migration stay intact,
> only that backup is lost. They can be closed in a small follow-up change.
