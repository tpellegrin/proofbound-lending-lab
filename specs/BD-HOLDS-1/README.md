# BD-HOLDS-1: maintenance holds and the explicit v0 migration

This directory holds the requirement records of change `BD-HOLDS-1`. It is application history. It is
not a self-contained proof bundle: several references below lead into the private Proofbound run
that produced the change. The files other than this README and `owner-walkthrough.sh` are the
run's records. They are pinned by digest, so they are never edited here.

| | |
|---|---|
| Baseline | the BorrowDesk v0 seed, `63da90eb1ff07c80f73932bf609f83fb780968d8` |
| Delivered as | PR #1, head `e61d65e30aa4cc5773f2efc6b54e08998cc0a306`: one commit on the seed |
| Merged as | `fbe58c23832141985547ec94e5f5ef654d5df933` (squash, 2026-09-24). Its tree, `ae00df44…`, is the PR head's tree |
| Produced by | Proofbound at `8e71ff4`. The dated run record is Proofbound's `docs/architecture/proofbound/evidence/borrowdesk-bd-holds-1-2026-09-24.md` (commit `a5d0ac2`) |

## The records

| File | What it is |
|---|---|
| `goal.md` | The owner's original goal, verbatim, sha256 `3dff6bc1…`. The later owner decision did not change it |
| `requirements.md` | The accepted requirements, sha256 `317efd0c…`. The banner at its top ("Proposed requirements — not accepted") is the author's status at the time of writing. The acceptance is recorded by the files below, not in this text |
| `ledger.json` | The acceptance record: `requirements.md` by digest, and the fresh `spec-reflector` review (`proposal-reflection`) that accepted it |
| `freezes/c71d9b27….json` | The frozen requirement set that implementation was bound to |
| `consistency/c71d9b27….json` | The aggregate consistency review accepted for that frozen set |
| `graph.json` | The change's declared artifact graph: one artifact, no dependencies |

## The owner-approved migration exception

This is a separate, later record. It does not replace the goal.

- **The goal** says that existing CLI behavior remains compatible, except for the checkout
  restriction and documented additive output fields. It also says ordinary commands must not
  silently migrate an old database.
- **The requirements** go further: R4.2(e) and §8, item 3. Every ordinary command, including the
  read-only `list-items`, `list-loans` and `report`, refuses a v0 database with
  `MIGRATION_REQUIRED` (exit 2) until `migrate` runs. The requirements argue that the goal requires
  this. The run's consistency review disagreed (its finding N1): refusing read-only commands is
  outside the goal's compatibility sentence.
- **The owner's decision.** On 2026-09-24, before implementation, the owner explicitly approved this
  exception: migration is required before ordinary commands can operate on a v0 database, read-only
  commands included. The decision's verbatim text and constraints are in the private run. They are
  not reproduced here.

Read `goal.md` together with this decision. The delivered behavior departs from the goal's
compatibility sentence by the owner's choice, not by oversight.

## References that need the private run

These are named by path or digest in the records above, and are not in this repository:

- the task contracts (`phases/…/contracts/r0001.md`) and the coordinator's decisions
  (`decisions/3.md`);
- the review gates named in `ledger.json` and `consistency/` (`phases/…/evidence-gate.json`);
- the owner decision record;
- the public acceptance scripts: version 1 `f9e2ea85…`, and version 2 `45e49acb…`, which adds the
  decision's two expectations;
- the sealed delivery: patch, manifest, handoff and verification result;
- the per-call usage rows behind the reported $0.179719 derived worker cost.

The digests here can be matched against those files. They cannot be checked from this repository
alone. The retained run was not available to the post-delivery review below, so it re-verified
none of them.

**The public acceptance checks were not held out.** The coordinator wrote them to follow
requirements the worker authored. They are evidence that the delivery meets its own requirements,
not an independent test.

## Post-delivery review (2026-09-24)

This was an independent review of the merged change, done after the run. Its additions are review
work, not part of the worker delivery: a revision that contains them is not byte-identical to the
delivery.

- **`owner-walkthrough.sh`** exercises the change on disposable data. It builds a populated v0
  database with the seed's own commands, then walks through the refusal, migration, holds, return
  while held, release and the report, and prints what each step expects. Run it from a BorrowDesk
  clone with Node 24 on `PATH`: `specs/BD-HOLDS-1/owner-walkthrough.sh [revision]`. It never opens
  an existing database.
- **`test/concurrency.test.ts`** adds a multi-process race of `hold` against `checkout`. It accepts
  either order. It fails if a loan is created after a hold took effect, which the item returned by
  the hold witnesses.
