import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { expectOk, runCli, tempDir } from "./helpers.js";

/** Visible text of each body row in the table under the given <h2> heading. */
function tableRows(html: string, heading: string): string[] {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = html.indexOf("<h2>", start + 1);
  const section = html.slice(start, end === -1 ? undefined : end);
  const body = section.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

test("dashboard reflects stored state, escapes names, and is self-contained", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "borrowdesk.db");
  const cli = (...args: string[]) => runCli(["--db", db, ...args]);
  const hostile = `<script>alert("x")</script> & <img src=x onerror=alert(1)> 'quoted'`;

  expectOk(cli("init"), "init");
  expectOk(cli("add-item", "projector-01", "Portable projector"), "add-item");
  expectOk(cli("add-item", "drill-01", hostile), "add-item");
  expectOk(cli("add-item", "microphone-01", "USB microphone"), "add-item");
  const first = expectOk(cli("checkout", "projector-01", "member-001"), "checkout").loan;
  expectOk(cli("return", String(first.id)), "return");
  expectOk(cli("checkout", "drill-01", "member-002"), "checkout");
  expectOk(cli("checkout", "projector-01", "member-003"), "checkout");

  const out = path.join(dir, "dashboard.html");
  const report = expectOk(cli("report", "--out", out), "report");
  const html = fs.readFileSync(out, "utf8");

  // Self-contained, script-free snapshot.
  assert.match(html, /Read-only snapshot/);
  assert.ok(html.includes(report.generatedAt));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<link/i);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt; &#39;quoted&#39;"));

  // Every table row matches what the CLI reports from the same database.
  const items = expectOk(cli("list-items"), "list-items").items as any[];
  const loans = expectOk(cli("list-loans"), "list-loans").loans as any[];
  const names = new Map(items.map((item) => [item.id, item.name]));
  const label = { available: "Available", on_loan: "On loan", active: "Active", returned: "Returned" } as Record<string, string>;

  assert.deepEqual(
    tableRows(html, "Equipment").map(decode),
    items.map((item) =>
      [
        item.id,
        item.name,
        item.activeLoan ? "Borrowed" : "—",
        item.held ? "Held" : "—",
        item.available ? "Available" : "Unavailable",
        item.activeLoan ? item.activeLoan.borrowerId : "—",
        item.activeLoan ? String(item.activeLoan.id) : "—",
        item.activeLoan ? item.activeLoan.checkedOutAt : "—",
      ].join(" "),
    ),
  );
  assert.deepEqual(
    tableRows(html, "Active loans").map(decode),
    loans
      .filter((loan) => loan.status === "active")
      .map((loan) => `${loan.id} ${loan.itemId} ${names.get(loan.itemId)} ${loan.borrowerId} ${loan.checkedOutAt}`),
  );
  assert.deepEqual(
    tableRows(html, "Loan history").map(decode),
    loans.map(
      (loan) =>
        `${loan.id} ${loan.itemId} ${names.get(loan.itemId)} ${loan.borrowerId} ${loan.checkedOutAt} ${loan.returnedAt ?? "—"} ${label[loan.status]}`,
    ),
  );
  assert.equal(loans.length, 3);
  assert.equal(report.activeLoanCount, 2);
});

test("dashboard for an empty database says so", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "empty.db");
  expectOk(runCli(["--db", db, "init"]), "init");
  const out = path.join(dir, "empty.html");
  expectOk(runCli(["--db", db, "report", "--out", out]), "report");
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /No equipment registered\./);
  assert.match(html, /No active loans\./);
  assert.match(html, /No loans recorded\./);
});

test("dashboard reports borrowed, held and available separately, allowing overlap", (t) => {
  const dir = tempDir(t);
  const db = path.join(dir, "holds.db");
  const cli = (...args: string[]) => runCli(["--db", db, ...args]);
  expectOk(cli("init"), "init");
  expectOk(cli("add-item", "camera-01", "Mirrorless camera"), "add-item");
  expectOk(cli("add-item", "drill-01", "Cordless drill"), "add-item");
  expectOk(cli("add-item", "saw-01", "Circular saw"), "add-item");
  expectOk(cli("hold", "camera-01"), "hold");
  const loan = expectOk(cli("checkout", "drill-01", "member-001"), "checkout").loan;
  expectOk(cli("hold", "drill-01"), "hold");

  const out = path.join(dir, "holds.html");
  const report = expectOk(cli("report", "--out", out), "report");
  const html = fs.readFileSync(out, "utf8");

  assert.deepEqual(
    { ...report, generatedAt: "" },
    {
      path: out,
      generatedAt: "",
      itemCount: 3,
      loanCount: 1,
      activeLoanCount: 1,
      heldItemCount: 2,
      availableItemCount: 1,
    },
  );

  const rows = tableRows(html, "Equipment").map(decode);
  assert.deepEqual([rows[0], rows[2]], [
    "camera-01 Mirrorless camera — Held Unavailable — — —",
    "saw-01 Circular saw — — Available — — —",
  ]);
  assert.match(
    rows[1] as string,
    new RegExp(
      `^drill-01 Cordless drill Borrowed Held Unavailable member-001 ${loan.id} ` +
        `${loan.checkedOutAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
  );
  assert.match(html, /available \+ on loan \+ held need not equal the item count/);
});
