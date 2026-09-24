import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { BorrowDesk, initializeDatabase, SCHEMA_VERSION } from "../src/desk.js";
import { assertRejects, domainState, fileHash, newDesk, steppingClock, tempDir } from "./helpers.js";

describe("equipment registration", () => {
  test("registers an item as available", (t) => {
    const { desk } = newDesk(t);
    const item = desk.registerItem("drill-01", "Cordless drill");
    assert.deepEqual(item, {
      id: "drill-01",
      name: "Cordless drill",
      status: "available",
      activeLoan: null,
      held: false,
      available: true,
    });
    assert.deepEqual(desk.listItems(), [item]);
  });

  test("rejects a duplicate identifier and keeps the original item", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    const before = domainState(desk);
    assertRejects(() => desk.registerItem("drill-01", "Another drill"), "ITEM_ALREADY_EXISTS", "itemId");
    assert.deepEqual(domainState(desk), before);
  });

  test("stores names exactly, including non-ASCII and markup characters", (t) => {
    const { desk } = newDesk(t);
    const name = `Câmera 4K <b>"pro"</b> & 'kit' ✓`;
    desk.registerItem("camera-01", name);
    assert.equal(desk.listItems()[0]?.name, name);
  });
});

describe("checkout and return", () => {
  test("checkout creates an active loan with UTC timestamps", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("projector-01", "Portable projector");
    const loan = desk.checkout("projector-01", "member-001");
    assert.deepEqual(loan, {
      id: loan.id,
      itemId: "projector-01",
      borrowerId: "member-001",
      checkedOutAt: "2026-03-01T09:00:00.000Z",
      returnedAt: null,
      status: "active",
    });
    assert.ok(Number.isSafeInteger(loan.id) && loan.id > 0);
    assert.deepEqual(desk.listItems()[0], {
      id: "projector-01",
      name: "Portable projector",
      status: "on_loan",
      activeLoan: { id: loan.id, borrowerId: "member-001", checkedOutAt: "2026-03-01T09:00:00.000Z" },
      held: false,
      available: false,
    });
  });

  test("return closes the loan and makes the item available", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("projector-01", "Portable projector");
    const loan = desk.checkout("projector-01", "member-001");
    const returned = desk.returnLoan(loan.id);
    assert.deepEqual(returned, {
      ...loan,
      returnedAt: "2026-03-01T09:01:00.000Z",
      status: "returned",
    });
    assert.equal(desk.listItems()[0]?.status, "available");
    assert.deepEqual(desk.listLoans({ activeOnly: true }), []);
    assert.deepEqual(desk.listLoans(), [returned]);
  });

  test("each checkout creates a distinct loan", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.registerItem("camera-01", "Mirrorless camera");
    const first = desk.checkout("drill-01", "member-001");
    const second = desk.checkout("camera-01", "member-001");
    assert.notEqual(first.id, second.id);
  });

  test("checkout of an unknown item fails without changes", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    const before = domainState(desk);
    assertRejects(() => desk.checkout("drill-99", "member-001"), "ITEM_NOT_FOUND", "itemId");
    assert.deepEqual(domainState(desk), before);
  });

  test("checkout of a borrowed item fails without changes", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.checkout("drill-01", "member-001");
    const before = domainState(desk);
    assertRejects(() => desk.checkout("drill-01", "member-002"), "ITEM_UNAVAILABLE", "itemId");
    assertRejects(() => desk.checkout("drill-01", "member-001"), "ITEM_UNAVAILABLE", "itemId");
    assert.deepEqual(domainState(desk), before);
  });

  test("returning an unknown loan fails without changes", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    const loan = desk.checkout("drill-01", "member-001");
    const before = domainState(desk);
    assertRejects(() => desk.returnLoan(loan.id + 1000), "LOAN_NOT_FOUND", "loanId");
    assert.deepEqual(domainState(desk), before);
  });

  test("returning a loan twice fails and keeps the original return time", (t) => {
    const { desk } = newDesk(t, { now: steppingClock() });
    desk.registerItem("drill-01", "Cordless drill");
    const loan = desk.returnLoan(desk.checkout("drill-01", "member-001").id);
    const before = domainState(desk);
    assertRejects(() => desk.returnLoan(loan.id), "LOAN_ALREADY_RETURNED", "loanId");
    assert.deepEqual(domainState(desk), before);
  });

  test("lending an item again creates a new loan and preserves history", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("camera-01", "Mirrorless camera");
    const first = desk.returnLoan(desk.checkout("camera-01", "member-001").id);
    const second = desk.checkout("camera-01", "member-002");
    assert.notEqual(second.id, first.id);
    assert.deepEqual(desk.listLoans(), [first, second]);
    assert.deepEqual(desk.listLoans({ activeOnly: true }), [second]);
    assert.equal(first.returnedAt, "2026-03-01T09:01:00.000Z");
    assert.equal(second.checkedOutAt, "2026-03-01T09:02:00.000Z");
  });
});

describe("input validation", () => {
  const badIds: unknown[] = [
    "", "Drill-01", "-drill", ".drill", "drill 01", " drill-01", "drill-01\n", "drill/01",
    "drillé", "a".repeat(65), 42, null, undefined,
  ];

  test("rejects invalid item ids, borrower ids and names without changes", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.checkout("drill-01", "member-001");
    desk.registerItem("camera-01", "Mirrorless camera");
    const before = domainState(desk);

    for (const bad of badIds) {
      assertRejects(() => desk.registerItem(bad as string, "Name"), "INVALID_INPUT", "itemId");
      assertRejects(() => desk.checkout(bad as string, "member-002"), "INVALID_INPUT", "itemId");
      assertRejects(() => desk.checkout("camera-01", bad as string), "INVALID_INPUT", "borrowerId");
    }
    const badNames: unknown[] = [
      "", " ", " Drill", "Drill ", "Drill\nbit", "Drill\tbit", "Drill\u0000", "x".repeat(201), "\ud800", 7, null,
    ];
    for (const bad of badNames) {
      assertRejects(() => desk.registerItem("saw-01", bad as string), "INVALID_INPUT", "name");
    }
    const badLoanIds: unknown[] = [0, -1, 1.5, Number.NaN, 2 ** 53, "1", null];
    for (const bad of badLoanIds) {
      assertRejects(() => desk.returnLoan(bad as number), "INVALID_INPUT", "loanId");
    }
    assert.deepEqual(domainState(desk), before);
  });

  test("accepts identifiers and names at the documented limits", (t) => {
    const { desk } = newDesk(t);
    const longId = `a${"-".repeat(62)}z`;
    desk.registerItem(longId, "n".repeat(200));
    desk.registerItem("0", "Zero");
    desk.registerItem("kit_2.b", "Kit two B");
    desk.registerItem("emoji-01", "😀".repeat(200));
    desk.checkout("0", "m");
    assert.equal(desk.listItems().length, 4);
  });
});

describe("listing", () => {
  test("items are ordered by id and loans by loan id, regardless of insertion order", (t) => {
    const { desk } = newDesk(t);
    for (const id of ["projector-01", "camera-01", "microphone-01", "drill-10", "drill-02", "drill_a", "drill.b"]) {
      desk.registerItem(id, `Item ${id}`);
    }
    // Byte-wise ASCII order: "-" < "." < digits < "_" < lowercase letters.
    const expected = ["camera-01", "drill-02", "drill-10", "drill.b", "drill_a", "microphone-01", "projector-01"];
    assert.deepEqual(desk.listItems().map((item) => item.id), expected);

    const loanIds = ["projector-01", "camera-01", "drill-10"].map((id) => desk.checkout(id, "member-001").id);
    desk.returnLoan(loanIds[1] as number);
    assert.deepEqual(desk.listLoans().map((loan) => loan.id), [...loanIds].sort((a, b) => a - b));
    assert.deepEqual(desk.listLoans({ activeOnly: true }).map((loan) => loan.itemId), ["projector-01", "drill-10"]);
    assert.deepEqual(desk.listItems(), desk.listItems());
  });

  test("read operations do not modify the database", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.registerItem("camera-01", "Mirrorless camera");
    desk.returnLoan(desk.checkout("drill-01", "member-001").id);
    desk.checkout("camera-01", "member-002");
    const hash = fileHash(file);
    const state = domainState(desk);

    desk.listItems();
    desk.listLoans();
    desk.listLoans({ activeOnly: true });
    desk.snapshot();

    assert.equal(fileHash(file), hash);
    assert.deepEqual(domainState(desk), state);
  });

  test("snapshot reports the stored items and loans with a UTC timestamp", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    desk.checkout("drill-01", "member-001");
    const snapshot = desk.snapshot();
    assert.equal(snapshot.generatedAt, "2026-03-01T09:01:00.000Z");
    assert.deepEqual(snapshot.items, desk.listItems());
    assert.deepEqual(snapshot.loans, desk.listLoans());
  });
});

describe("persistence and initialization", () => {
  test("data survives closing and reopening the database", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.registerItem("camera-01", "Mirrorless camera");
    desk.returnLoan(desk.checkout("drill-01", "member-001").id);
    desk.checkout("drill-01", "member-002");
    const state = domainState(desk);
    desk.close();

    const reopened = BorrowDesk.open(file);
    t.after(() => reopened.close());
    assert.deepEqual(domainState(reopened), state);
  });

  test("repeating initialization preserves existing data", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.checkout("drill-01", "member-001");
    const state = domainState(desk);

    const result = initializeDatabase(file);
    assert.deepEqual(result, {
      database: path.resolve(file),
      schemaVersion: SCHEMA_VERSION,
      alreadyInitialized: true,
      migrationRequired: false,
    });
    assert.deepEqual(domainState(desk), state);
  });

  test("initialization records the schema version", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "new.db");
    assert.equal(initializeDatabase(file).alreadyInitialized, false);
    const raw = new Database(file, { readonly: true });
    t.after(() => raw.close());
    assert.equal(raw.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  });

  test("opening never creates a missing database", (t) => {
    const file = path.join(tempDir(t), "missing.db");
    assertRejects(() => BorrowDesk.open(file), "DATABASE_NOT_FOUND");
    assert.equal(fs.existsSync(file), false);
  });

  test("opening an empty file reports an uninitialized database", (t) => {
    const file = path.join(tempDir(t), "empty.db");
    fs.writeFileSync(file, "");
    assertRejects(() => BorrowDesk.open(file), "DATABASE_NOT_INITIALIZED");
    assert.equal(initializeDatabase(file).alreadyInitialized, false);
    BorrowDesk.open(file).close();
  });

  test("refuses files that are not BorrowDesk databases and leaves them unchanged", (t) => {
    const dir = tempDir(t);
    const text = path.join(dir, "notes.txt");
    fs.writeFileSync(text, "not a database, just some text that is long enough to have a header".repeat(3));
    const foreign = path.join(dir, "foreign.db");
    const raw = new Database(foreign);
    raw.exec("CREATE TABLE things (x TEXT)");
    raw.close();

    for (const file of [text, foreign]) {
      const hash = fileHash(file);
      assertRejects(() => BorrowDesk.open(file), "NOT_A_BORROWDESK_DATABASE");
      assertRejects(() => initializeDatabase(file), "NOT_A_BORROWDESK_DATABASE");
      assert.equal(fileHash(file), hash);
    }
  });

  test("refuses a BorrowDesk database with an unknown schema version", (t) => {
    const { desk, file } = newDesk(t);
    desk.close();
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    assertRejects(() => BorrowDesk.open(file), "UNSUPPORTED_SCHEMA_VERSION");
    assertRejects(() => initializeDatabase(file), "UNSUPPORTED_SCHEMA_VERSION");
  });

  test("the schema itself rejects a second active loan for an item", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.checkout("drill-01", "member-001");
    const raw = new Database(file);
    t.after(() => raw.close());
    assert.throws(
      () =>
        raw
          .prepare("INSERT INTO loans (item_id, borrower_id, checked_out_at) VALUES (?, ?, ?)")
          .run("drill-01", "member-002", "2026-03-01T10:00:00.000Z"),
      /UNIQUE constraint failed/,
    );
    assert.equal(desk.listLoans({ activeOnly: true }).length, 1);
  });
});
