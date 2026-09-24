import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertRejects, domainState, fileHash, newDesk, rawSnapshot, steppingClock } from "./helpers.js";

const HELD_ITEM = {
  id: "drill-01",
  name: "Cordless drill",
  status: "available",
  activeLoan: null,
  held: true,
  available: false,
};

describe("maintenance holds", () => {
  test("hold marks an item held and reports changed", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    const result = desk.hold("drill-01");
    assert.deepEqual(result, { item: HELD_ITEM, changed: true });
    assert.deepEqual(desk.listItems(), [result.item]);
  });

  test("hold is idempotent and preserves the stored hold timestamp", (t) => {
    const { desk, file } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    const first = desk.hold("drill-01");
    assert.equal(first.changed, true);
    assert.equal(rawSnapshot(file).holds?.[0]?.held_at, "2026-03-01T09:00:00.000Z");

    const second = desk.hold("drill-01");
    assert.deepEqual(second, { item: first.item, changed: false });
    assert.equal(rawSnapshot(file).holds?.[0]?.held_at, "2026-03-01T09:00:00.000Z");
  });

  test("release removes the hold and reports changed; repeating changes nothing", (t) => {
    const { desk, file } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    desk.hold("drill-01");
    const released = desk.release("drill-01");
    assert.deepEqual(released, {
      item: { id: "drill-01", name: "Cordless drill", status: "available", activeLoan: null, held: false, available: true },
      changed: true,
    });
    assert.equal(rawSnapshot(file).holds?.length, 0);
    const again = desk.release("drill-01");
    assert.deepEqual(again, { item: released.item, changed: false });
  });

  test("hold and release of an unknown item are rejected without changes", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    const before = domainState(desk);
    const hash = fileHash(file);
    assertRejects(() => desk.hold("drill-99"), "ITEM_NOT_FOUND", "itemId");
    assertRejects(() => desk.release("drill-99"), "ITEM_NOT_FOUND", "itemId");
    assert.deepEqual(domainState(desk), before);
    assert.equal(fileHash(file), hash);
  });

  test("invalid item ids are rejected before any change", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    const hash = fileHash(file);
    for (const bad of ["", "Drill-01", "-drill", "a".repeat(65)]) {
      assertRejects(() => desk.hold(bad), "INVALID_INPUT", "itemId");
      assertRejects(() => desk.release(bad), "INVALID_INPUT", "itemId");
    }
    assert.equal(fileHash(file), hash);
    assert.equal(desk.listItems()[0]?.held, false);
  });

  test("a held item can be borrowed, and returning the loan keeps the hold", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    const loan = desk.checkout("drill-01", "member-001");
    const held = desk.hold("drill-01");
    assert.deepEqual(held.item.activeLoan, loan && {
      id: loan.id,
      borrowerId: "member-001",
      checkedOutAt: "2026-03-01T09:00:00.000Z",
    });
    assert.equal(held.item.held, true);
    assert.equal(held.item.available, false);
    assert.equal(held.item.status, "on_loan");

    const returned = desk.returnLoan(loan.id);
    assert.equal(returned.status, "returned");
    assert.deepEqual(desk.listLoans(), [returned]);
    const item = desk.listItems()[0];
    assert.deepEqual(item, {
      id: "drill-01",
      name: "Cordless drill",
      status: "available",
      activeLoan: null,
      held: true,
      available: false,
    });
  });

  test("releasing a hold leaves an outstanding loan untouched", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    const loan = desk.checkout("drill-01", "member-001");
    desk.hold("drill-01");
    const released = desk.release("drill-01");
    assert.deepEqual(released.item.activeLoan, {
      id: loan.id,
      borrowerId: "member-001",
      checkedOutAt: "2026-03-01T09:00:00.000Z",
    });
    assert.equal(released.item.held, false);
    assert.equal(released.item.status, "on_loan");
    assert.equal(released.item.available, false);
    assert.deepEqual(desk.listLoans({ activeOnly: true }), [loan]);
  });

  test("a held item with no loan cannot be checked out", (t) => {
    const { desk, file } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.hold("drill-01");
    const hash = fileHash(file);
    assertRejects(() => desk.checkout("drill-01", "member-001"), "ITEM_HELD", "itemId");
    assert.equal(fileHash(file), hash);
    assert.deepEqual(desk.listLoans(), []);
  });

  test("an active loan keeps ITEM_UNAVAILABLE precedence even when held", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    const loan = desk.checkout("drill-01", "member-001");
    desk.hold("drill-01");
    assertRejects(() => desk.checkout("drill-01", "member-002"), "ITEM_UNAVAILABLE", "itemId");
    assert.deepEqual(desk.listLoans({ activeOnly: true }), [loan]);
  });

  test("releasing a hold makes the item checkable again", (t) => {
    const { desk } = newDesk(t);
    desk.registerItem("drill-01", "Cordless drill");
    desk.hold("drill-01");
    assertRejects(() => desk.checkout("drill-01", "member-001"), "ITEM_HELD", "itemId");
    desk.release("drill-01");
    const loan = desk.checkout("drill-01", "member-001");
    assert.equal(loan.itemId, "drill-01");
    assert.equal(desk.listItems()[0]?.available, false);
  });

  test("hold and release preserve ids, names and loan history", (t) => {
    const { desk } = newDesk(t, { now: steppingClock("2026-03-01T09:00:00.000Z") });
    desk.registerItem("drill-01", "Cordless drill");
    desk.registerItem("camera-01", "Mirrorless camera");
    const first = desk.returnLoan(desk.checkout("drill-01", "member-001").id);
    const second = desk.checkout("drill-01", "member-002");
    const before = domainState(desk);

    desk.hold("camera-01");
    desk.hold("drill-01");
    desk.release("drill-01");
    desk.release("camera-01");

    const after = domainState(desk);
    assert.deepEqual(after.loans, before.loans);
    assert.deepEqual(after.loans, [first, second]);
    assert.deepEqual(after.items.map((item) => ({ id: item.id, name: item.name })), [
      { id: "camera-01", name: "Mirrorless camera" },
      { id: "drill-01", name: "Cordless drill" },
    ]);
  });
});
