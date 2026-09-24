# BorrowDesk: maintenance holds

Add maintenance holds to BorrowDesk with these behavioral constraints:

* An operator can place and remove a maintenance hold on an existing item.
* A held item cannot be newly checked out.
* An item can be held while it is borrowed.
* Returning its outstanding loan remains allowed and does not remove the hold.
* Removing a hold does not alter or close an outstanding loan.
* An item is available only when it has neither a maintenance hold nor an active loan.
* Item listings and the HTML dashboard expose borrowed and held status separately; both can be true.
* Unknown item identifiers are rejected without changing domain state.
* Repeating an already-effective hold or removal succeeds without further changes.
* Existing item and loan identifiers, borrowers, timestamps and loan history are preserved.
* Existing CLI behavior remains compatible except for the intentional checkout restriction and documented additive output fields.

Include an explicit migration path from populated v0 databases:

* Ordinary application commands must not silently migrate an old database.
* Initializing a new database creates the new schema.
* Migration preserves existing records and starts existing items without holds.
* Migration is atomic.
* Repeating migration on a current database is an idempotent success.
* Missing, foreign, corrupt or unsupported databases are rejected without replacement.
* Outstanding loans created under v0 remain returnable after migration.

Do not add maintenance scheduling, notes or history, reservations, due dates, borrower accounts, authentication, or an editable web application.

Keep this first BorrowDesk task dependency-preserving unless a concrete need is identified and separately adjudicated.
