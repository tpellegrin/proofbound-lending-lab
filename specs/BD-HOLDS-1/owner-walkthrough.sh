#!/usr/bin/env bash
# Owner walkthrough for BD-HOLDS-1: maintenance holds and the explicit v0 migration.
#
# Usage, from a BorrowDesk clone that holds both revisions, with Node 24 (.node-version) on PATH:
#   specs/BD-HOLDS-1/owner-walkthrough.sh [candidate-revision]      # default: HEAD
#
# Uses only disposable data. The seed (63da90eb) and the candidate are exported with `git archive`
# into a new temporary directory, installed with `npm ci` and built there. The script never opens
# a database it did not create, and it changes nothing in this checkout. Each step prints what it
# expects and stops at the first surprise. The temporary directory is left for inspection.
set -euo pipefail

SEED_REV=63da90eb1ff07c80f73932bf609f83fb780968d8
CANDIDATE_REV=$(git rev-parse --verify "${1:-HEAD}^{commit}")
REPO=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/borrowdesk-walkthrough.XXXXXX")
DB="$WORK/data/v0-then-v2.db"
mkdir -p "$WORK/data"

step() { printf '\n== %s\n' "$*"; }
expect() { printf '   expect: %s\n' "$*"; }
ok() { printf '   ok\n'; }
fail() { printf '   UNEXPECTED: %s\n   work directory: %s\n' "$*" "$WORK" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

build() { # <revision> <dir>
  mkdir -p "$2"
  git -C "$REPO" archive "$1" | tar -x -C "$2"
  (cd "$2" && npm ci --silent --no-audit --no-fund >/dev/null && npm run --silent build >/dev/null)
}
v0() { node "$WORK/seed/dist/cli.js" --db "$DB" "$@"; }
v2() { node "$WORK/candidate/dist/cli.js" --db "$DB" "$@"; }

# run <expected-exit> <js-predicate over the parsed envelope `r`> <command...>
# Prints the envelope and checks the exit code and the predicate.
run() {
  local want=$1 check=$2; shift 2
  local out code=0
  out=$("$@" 2>&1) || code=$?
  printf '%s\n' "$out" | sed 's/^/   | /'
  [ "$code" = "$want" ] || fail "exit $code, expected $want"
  printf '%s' "$out" | node -e '
    const r = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!new Function("r", `return (${process.argv[1]});`)(r)) {
      console.error(`   predicate failed: ${process.argv[1]}`);
      process.exit(1);
    }
  ' "$check" || fail "output did not match"
  ok
}

printf 'BorrowDesk BD-HOLDS-1 walkthrough\n  seed:      %s\n  candidate: %s\n  work:      %s\n  node:      %s\n' \
  "$SEED_REV" "$CANDIDATE_REV" "$WORK" "$(node --version)"

step "Build the v0 seed and the candidate in the work directory"
build "$SEED_REV" "$WORK/seed"
build "$CANDIDATE_REV" "$WORK/candidate"
ok

step "1. Create a populated v0 database with the seed's own commands"
v0 init >/dev/null
v0 add-item drill-01 "Cordless drill" >/dev/null
v0 add-item saw-01 "Circular saw" >/dev/null
v0 add-item camera-01 "Mirrorless camera" >/dev/null
v0 checkout drill-01 member-001 >/dev/null     # loan 1, left active
v0 checkout camera-01 member-002 >/dev/null    # loan 2
v0 return 2 >/dev/null
cp "$DB" "$WORK/data/v0-untouched.db"
UNTOUCHED=$(sha "$DB")
expect "the seed reports schema version 1; drill-01 on loan (loan 1), saw-01 and camera-01 available"
run 0 'r.data.schemaVersion === 1 && r.data.alreadyInitialized === true' v0 init
run 0 'r.data.items.map(i => i.id + ":" + i.status).join(",") === "camera-01:available,drill-01:on_loan,saw-01:available"' v0 list-items

step "2. The candidate refuses the unmigrated file, even for reading"
expect "list-items and report exit 2 with MIGRATION_REQUIRED; the file is byte-identical; no report is written"
run 2 'r.error.code === "MIGRATION_REQUIRED"' v2 list-items
run 2 'r.error.code === "MIGRATION_REQUIRED"' v2 report --out "$WORK/data/refused.html"
[ "$(sha "$DB")" = "$UNTOUCHED" ] && [ ! -e "$WORK/data/refused.html" ] || fail "the v0 file or the output changed"
expect "init also leaves it alone: schemaVersion 1, migrationRequired true"
run 0 'r.data.schemaVersion === 1 && r.data.migrationRequired === true' v2 init
[ "$(sha "$DB")" = "$UNTOUCHED" ] || fail "init changed the v0 file"
ok

step "3. Migrate it"
expect "migrated from 1 to 2; a repeat succeeds and changes nothing"
run 0 'r.data.fromSchemaVersion === 1 && r.data.schemaVersion === 2 && r.data.migrated === true' v2 migrate
run 0 'r.data.fromSchemaVersion === 2 && r.data.migrated === false' v2 migrate
expect "every loan the seed recorded is still there, unchanged, and no item is held"
run 0 'r.data.loans.length === 2 && r.data.loans[0].status === "active" && r.data.loans[1].status === "returned"' v2 list-loans
run 0 'r.data.items.every(i => i.held === false)' v2 list-items

step "4. Hold an available item; its checkout is rejected"
expect "saw-01 held: status stays \"available\" (loan state only), available false"
run 0 'r.data.changed === true && r.data.item.held === true && r.data.item.status === "available" && r.data.item.available === false' v2 hold saw-01
expect "checkout exits 2 with ITEM_HELD and creates no loan"
run 2 'r.error.code === "ITEM_HELD"' v2 checkout saw-01 member-003
run 0 'r.data.loans.length === 2' v2 list-loans

step "5. Hold a borrowed item, return its (v0) loan, and the hold remains"
expect "drill-01 held while on loan: status on_loan, held true"
run 0 'r.data.item.held === true && r.data.item.status === "on_loan" && r.data.item.activeLoan.id === 1' v2 hold drill-01
expect "loan 1, created by the seed, is returnable"
run 0 'r.data.loan.id === 1 && r.data.loan.status === "returned"' v2 return 1
expect "drill-01 is no longer borrowed but still held, so not available"
run 0 '(d => d.held === true && d.status === "available" && d.activeLoan === null && d.available === false)(r.data.items.find(i => i.id === "drill-01"))' v2 list-items

step "6. Release the holds and inspect availability"
run 0 'r.data.changed === true && r.data.item.available === true' v2 release saw-01
run 0 'r.data.changed === true && r.data.item.available === true' v2 release drill-01
expect "a repeat release succeeds and changes nothing"
run 0 'r.data.changed === false' v2 release drill-01
expect "every item available, none held"
run 0 'r.data.items.every(i => i.available && !i.held)' v2 list-items

step "7. Generate and inspect the HTML report, with one item both borrowed and held"
v2 checkout camera-01 member-004 >/dev/null
v2 hold camera-01 >/dev/null
v2 hold saw-01 >/dev/null
expect "3 items, 1 active loan, 2 held, 1 available (drill-01)"
run 0 'r.data.itemCount === 3 && r.data.activeLoanCount === 1 && r.data.heldItemCount === 2 && r.data.availableItemCount === 1' \
  v2 report --out "$WORK/data/dashboard.html"
grep -q 'available + on loan + held need not equal the item count' "$WORK/data/dashboard.html" || fail "overlap note missing"
node -e '
  const html = require("node:fs").readFileSync(process.argv[1], "utf8");
  const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]))
    .filter((row) => /^(camera|drill|saw)-01 /.test(row));
  for (const row of rows.slice(0, 3)) console.log("   | " + row);
  const ok = /^camera-01 .* Borrowed Held Unavailable member-004/.test(rows[0]) &&
             /^drill-01 .* — — Available/.test(rows[1]) && /^saw-01 .* — Held Unavailable/.test(rows[2]);
  process.exit(ok ? 0 : 1);
' "$WORK/data/dashboard.html" || fail "dashboard rows do not match list-items"
ok

step "Done"
[ "$(sha "$WORK/data/v0-untouched.db")" = "$UNTOUCHED" ] || fail "the untouched v0 copy changed"
printf '   The untouched v0 copy is %s (sha256 %s).\n' "$WORK/data/v0-untouched.db" "$UNTOUCHED"
printf '   Open the dashboard: %s\n   Remove everything when done: rm -rf %s\n' "$WORK/data/dashboard.html" "$WORK"
