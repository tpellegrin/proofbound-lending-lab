# Owner decision: the `--backup` destination contract (A)

The owner made this decision on 2026-09-24 in the authorization of this run. The coordinator
recorded it here before any requirements were authored. It settles a choice that `goal.md` leaves
open: `goal.md` asks for interruption behavior to be defined and for a completed backup to be
distinguished from a partial artifact. `goal.md` itself is unchanged. The owner's authorization,
including this text, is also recorded verbatim by `authorize-spending` in the run's receipts.

The owner's words, verbatim:

> Destination decision: A
>
> For a destination that was absent, this operation may publish a file at the requested --backup path only after that backup has been completed and verified.
>
> * Partial work uses a documented temporary name.
> * Handled failures remove temporary artifacts owned by this invocation where possible; cleanup failures are reported.
> * An abrupt process interruption may leave temporary artifacts.
> * A pre-existing destination remains untouched, whatever its contents.
> * A concurrently created destination must not be overwritten.
> * If a valid backup was published but migration then fails, keep the backup and report both outcomes accurately.
>
> This defines publication behavior under the supported filesystem and process-interruption model. It does not assert that later external modification, hardware failure or power loss cannot damage a file. Keep documented durability expectations separate from what tests actually observe.
>
> Record this owner decision before requirements are authored. Do not reinterpret A as permission to delete an existing file because it is not a valid backup.
