import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { expectError, expectOk, fileHash, runCli, tempDir } from "./helpers.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A CLI bound to a fresh database path inside a temporary directory. */
function cliFor(t: TestContext, init = true) {
  const dir = tempDir(t);
  const db = path.join(dir, "borrowdesk.db");
  const cli = (...args: string[]) => runCli(["--db", db, ...args]);
  if (init) expectOk(cli("init"), "init");
  return { dir, db, cli };
}

describe("CLI basics", () => {
  test("--help prints usage text and exits 0", () => {
    for (const args of [["--help"], ["-h"], ["help"], ["--db", "x.db", "checkout", "--help"]]) {
      const result = runCli(args);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Usage:/);
      assert.match(result.stdout, /checkout <item-id> <borrower-id>/);
      assert.equal(result.stderr, "");
    }
  });

  test("rejects malformed invocations with INVALID_ARGUMENTS", (t) => {
    const { db } = cliFor(t);
    expectError(runCli([]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["list-items"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", "", "list-items"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", db, "lend"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", db, "checkout", "drill-01"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", db, "list-items", "extra"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", db, "list-items", "--active"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", db, "list-items", "--verbose"]), 2, "INVALID_ARGUMENTS");
    expectError(runCli(["--db", db, "report"]), 2, "INVALID_ARGUMENTS");
    const error = expectError(runCli(["--db", db, "return"]), 2, "INVALID_ARGUMENTS");
    assert.match(error.message, /return <loan-id>/);
    assert.equal(JSON.parse(runCli(["--db", db, "return"]).stderr).command, "return");
  });

  test("non-init commands never create a database", (t) => {
    const dir = tempDir(t);
    const db = path.join(dir, "missing.db");
    for (const args of [["list-items"], ["add-item", "drill-01", "Drill"], ["list-loans"]]) {
      expectError(runCli(["--db", db, ...args]), 2, "DATABASE_NOT_FOUND");
    }
    expectError(runCli(["--db", db, "report", "--out", path.join(dir, "r.html")]), 2, "DATABASE_NOT_FOUND");
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("reports an uninitialized or foreign database file", (t) => {
    const dir = tempDir(t);
    const empty = path.join(dir, "empty.db");
    fs.writeFileSync(empty, "");
    expectError(runCli(["--db", empty, "list-items"]), 2, "DATABASE_NOT_INITIALIZED");
    const text = path.join(dir, "notes.txt");
    fs.writeFileSync(text, "hello ".repeat(100));
    expectError(runCli(["--db", text, "list-items"]), 2, "NOT_A_BORROWDESK_DATABASE");
    expectError(runCli(["--db", text, "init"]), 2, "NOT_A_BORROWDESK_DATABASE");
    expectError(runCli(["--db", path.join(dir, "no-such-dir", "x.db"), "init"]), 2, "INVALID_DATABASE_PATH");
    expectError(runCli(["--db", dir, "init"]), 2, "INVALID_DATABASE_PATH");
  });
});

describe("CLI lending workflow", () => {
  test("init, register, checkout, return and list with JSON envelopes", (t) => {
    const { db, cli } = cliFor(t, false);

    const init = expectOk(cli("init"), "init");
    assert.deepEqual(init, { database: db, schemaVersion: 2, alreadyInitialized: false, migrationRequired: false });

    const added = expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    assert.deepEqual(added, {
      item: { id: "drill-01", name: "Cordless drill", status: "available", activeLoan: null, held: false, available: true },
    });
    expectOk(cli("add-item", "camera-01", "Mirrorless camera"), "add-item");

    const { loan } = expectOk(cli("checkout", "drill-01", "member-001"), "checkout");
    assert.equal(typeof loan.id, "number");
    assert.equal(loan.itemId, "drill-01");
    assert.equal(loan.borrowerId, "member-001");
    assert.match(loan.checkedOutAt, ISO_UTC);
    assert.equal(loan.returnedAt, null);
    assert.equal(loan.status, "active");

    const { items } = expectOk(cli("list-items"), "list-items");
    assert.deepEqual(
      items.map((item: any) => [item.id, item.status, item.activeLoan?.borrowerId ?? null]),
      [["camera-01", "available", null], ["drill-01", "on_loan", "member-001"]],
    );
    assert.deepEqual(expectOk(cli("list-loans", "--active"), "list-loans"), { loans: [loan] });

    // The loan id printed by checkout is what return accepts.
    const returned = expectOk(cli("return", String(loan.id)), "return").loan;
    assert.equal(returned.id, loan.id);
    assert.equal(returned.status, "returned");
    assert.match(returned.returnedAt, ISO_UTC);
    assert.ok(returned.returnedAt >= returned.checkedOutAt);

    const again = expectOk(cli("checkout", "drill-01", "member-002"), "checkout").loan;
    assert.notEqual(again.id, loan.id);
    const history = expectOk(cli("list-loans"), "list-loans").loans;
    assert.deepEqual(history, [returned, again]);
    assert.deepEqual(expectOk(cli("list-loans", "--active"), "list-loans").loans, [again]);
  });

  test("rejected operations exit 2 with stable codes and leave data unchanged", (t) => {
    const { cli } = cliFor(t);
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    const { loan } = expectOk(cli("checkout", "drill-01", "member-001"), "checkout");
    expectOk(cli("add-item", "camera-01", "Mirrorless camera"), "add-item");
    const closed = expectOk(cli("checkout", "camera-01", "member-002"), "checkout").loan;
    expectOk(cli("return", String(closed.id)), "return");

    const snapshot = () => [cli("list-items").stdout, cli("list-loans").stdout];
    const before = snapshot();

    assert.equal(expectError(cli("add-item", "drill-01", "Other"), 2, "ITEM_ALREADY_EXISTS").field, "itemId");
    expectError(cli("checkout", "saw-01", "member-003"), 2, "ITEM_NOT_FOUND");
    const unavailable = expectError(cli("checkout", "drill-01", "member-003"), 2, "ITEM_UNAVAILABLE");
    assert.match(unavailable.message, new RegExp(`loan ${loan.id}`));
    expectError(cli("return", "999"), 2, "LOAN_NOT_FOUND");
    expectError(cli("return", String(closed.id)), 2, "LOAN_ALREADY_RETURNED");
    for (const args of [
      ["add-item", "Drill-02", "Drill"],
      ["add-item", "drill-02", ""],
      ["add-item", "drill-02", " padded"],
      ["add-item", "drill-02", "line\nbreak"],
      ["checkout", "camera-01", "Member 3"],
      ["return", "0"],
      ["return", "1.0"],
      ["return", "abc"],
      ["return", "99999999999999999999"],
    ]) {
      const error = expectError(cli(...args), 2, "INVALID_INPUT");
      assert.equal(typeof error.field, "string");
    }
    expectError(cli("return", "-1"), 2, "INVALID_ARGUMENTS");

    assert.deepEqual(snapshot(), before);
  });

  test("a name beginning with '-' can be passed after --", (t) => {
    const { cli } = cliFor(t);
    const { item } = expectOk(cli("add-item", "--", "cable-01", "-3m extension cable"), "add-item");
    assert.equal(item.name, "-3m extension cable");
  });

  test("data written by one process is read by later processes; init preserves it", (t) => {
    const { cli, db } = cliFor(t);
    expectOk(cli("add-item", "projector-01", "Portable projector"), "add-item");
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    const first = expectOk(cli("checkout", "projector-01", "member-001"), "checkout").loan;
    expectOk(cli("return", String(first.id)), "return");
    expectOk(cli("checkout", "drill-01", "member-002"), "checkout");
    const items = cli("list-items").stdout;
    const loans = cli("list-loans").stdout;

    assert.equal(expectOk(cli("init"), "init").alreadyInitialized, true);
    assert.equal(expectOk(runCli(["init", "--db", db]), "init").alreadyInitialized, true);
    assert.equal(cli("list-items").stdout, items);
    assert.equal(cli("list-loans").stdout, loans);
  });

  test("read-only commands leave the database file byte-for-byte unchanged", (t) => {
    const { cli, db, dir } = cliFor(t);
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    expectOk(cli("add-item", "camera-01", "Mirrorless camera"), "add-item");
    expectOk(cli("checkout", "drill-01", "member-001"), "checkout");
    const hash = fileHash(db);

    expectOk(cli("list-items"), "list-items");
    expectOk(cli("list-loans"), "list-loans");
    expectOk(cli("list-loans", "--active"), "list-loans");
    expectOk(cli("report", "--out", path.join(dir, "dashboard.html")), "report");
    expectError(cli("checkout", "drill-01", "member-002"), 2, "ITEM_UNAVAILABLE");

    assert.equal(fileHash(db), hash);
  });

  test("storage failures exit 1 with STORAGE_ERROR", { skip: process.getuid?.() === 0 && "root ignores file permissions" }, (t) => {
    const { cli, db } = cliFor(t);
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    fs.chmodSync(db, 0o444);
    const error = expectError(cli("checkout", "drill-01", "member-001"), 1, "STORAGE_ERROR");
    assert.match(error.message, /readonly/i);
    fs.chmodSync(db, 0o644);
    assert.deepEqual(expectOk(cli("list-loans"), "list-loans").loans, []);
  });
});

describe("CLI report command", () => {
  test("writes the dashboard and never silently replaces an existing file", (t) => {
    const { cli, db, dir } = cliFor(t);
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    expectOk(cli("checkout", "drill-01", "member-001"), "checkout");
    const out = path.join(dir, "dashboard.html");

    const report = expectOk(cli("report", "--out", out), "report");
    assert.deepEqual(
      { ...report, generatedAt: "" },
      {
        path: out,
        generatedAt: "",
        itemCount: 1,
        loanCount: 1,
        activeLoanCount: 1,
        heldItemCount: 0,
        availableItemCount: 0,
      },
    );
    assert.match(report.generatedAt, ISO_UTC);
    const firstHtml = fs.readFileSync(out, "utf8");
    assert.match(firstHtml, /Cordless drill/);

    expectError(cli("report", "--out", out), 2, "OUTPUT_EXISTS");
    assert.equal(fs.readFileSync(out, "utf8"), firstHtml);

    expectOk(cli("add-item", "camera-01", "Mirrorless camera"), "add-item");
    expectOk(cli("report", "--out", out, "--force"), "report");
    assert.match(fs.readFileSync(out, "utf8"), /Mirrorless camera/);

    const dbHash = fileHash(db);
    expectError(cli("report", "--out", db, "--force"), 2, "INVALID_OUTPUT_PATH");
    expectError(cli("report", "--out", dir), 2, "INVALID_OUTPUT_PATH");
    expectError(cli("report", "--out", path.join(dir, "missing", "r.html")), 2, "INVALID_OUTPUT_PATH");
    assert.equal(fileHash(db), dbHash);
  });
});

describe("CLI maintenance holds", () => {
  test("hold and release return the item and changed flag; checkout of a held item is ITEM_HELD", (t) => {
    const { cli } = cliFor(t);
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");

    const held = expectOk(cli("hold", "drill-01"), "hold");
    assert.equal(held.changed, true);
    assert.deepEqual(held.item, {
      id: "drill-01",
      name: "Cordless drill",
      status: "available",
      activeLoan: null,
      held: true,
      available: false,
    });

    const again = expectOk(cli("hold", "drill-01"), "hold");
    assert.equal(again.changed, false);
    assert.deepEqual(again.item, held.item);

    expectError(cli("checkout", "drill-01", "member-001"), 2, "ITEM_HELD");
    expectError(cli("hold", "saw-01"), 2, "ITEM_NOT_FOUND");
    expectError(cli("release", "saw-01"), 2, "ITEM_NOT_FOUND");

    const released = expectOk(cli("release", "drill-01"), "release");
    assert.equal(released.changed, true);
    assert.equal(released.item.held, false);
    assert.equal(released.item.available, true);
    assert.equal(expectOk(cli("release", "drill-01"), "release").changed, false);

    const loan = expectOk(cli("checkout", "drill-01", "member-001"), "checkout").loan;
    assert.equal(loan.itemId, "drill-01");
  });

  test("hold validates like other item commands", (t) => {
    const { cli } = cliFor(t);
    expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
    expectError(cli("hold"), 2, "INVALID_ARGUMENTS");
    expectError(cli("hold", "drill-01", "extra"), 2, "INVALID_ARGUMENTS");
    expectError(cli("hold", "--active", "drill-01"), 2, "INVALID_ARGUMENTS");
    expectError(cli("hold", "Drill-01"), 2, "INVALID_INPUT");
    expectOk(cli("release", "--", "drill-01"), "release");
  });
});
