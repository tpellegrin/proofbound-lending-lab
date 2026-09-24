import type { Item, Loan, Snapshot } from "./desk.js";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const STYLE = `
  :root { color-scheme: light; --ink: #1d2433; --muted: #5b6475; --line: #d9dee7; --bg: #f6f7f9;
    --ok: #1f7a3f; --ok-bg: #e3f4e8; --out: #9a5b00; --out-bg: #fdf0d9; --done: #4b5563; --done-bg: #eceef2; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  h2 { margin: 32px 0 8px; font-size: 18px; }
  .snapshot { margin: 12px 0 0; padding: 10px 14px; border: 1px solid var(--line); border-left: 4px solid #3b5bdb;
    background: #fff; border-radius: 6px; color: var(--muted); }
  .snapshot strong { color: var(--ink); }
  .summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0 0; padding: 0; list-style: none; }
  .summary li { flex: 1 1 140px; background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; }
  .summary b { display: block; font-size: 24px; }
  .table-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--line); border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td.name { white-space: normal; }
  tr:last-child td { border-bottom: 0; }
  th { font-size: 13px; color: var(--muted); font-weight: 600; background: #fafbfc; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .status { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .available { color: var(--ok); background: var(--ok-bg); }
  .on_loan, .active { color: var(--out); background: var(--out-bg); }
  .returned { color: var(--done); background: var(--done-bg); }
  .held { color: #7a3e9d; background: #efe4f7; }
  .unavailable { color: var(--muted); background: var(--done-bg); }
  .summary-note { margin: 8px 2px 0; color: var(--muted); font-size: 13px; }
  .empty { color: var(--muted); padding: 12px; margin: 0; }
`;

const STATUS_LABELS: Record<Item["status"] | Loan["status"], string> = {
  available: "Available",
  on_loan: "On loan",
  active: "Active",
  returned: "Returned",
};

/**
 * Renders a self-contained, read-only HTML page from a snapshot. The page
 * needs no JavaScript or network access; every stored value is escaped.
 */
export function renderDashboard(snapshot: Snapshot, source: string): string {
  const { items, loans, generatedAt } = snapshot;
  const names = new Map(items.map((item) => [item.id, item.name]));
  const activeLoans = loans.filter((loan) => loan.status === "active");
  const available = items.filter((item) => item.available).length;
  const borrowed = items.filter((item) => item.activeLoan !== null).length;
  const held = items.filter((item) => item.held).length;

  const itemRows = items.map(
    (item) => `<tr>
        <td><code>${escapeHtml(item.id)}</code></td>
        <td class="name">${escapeHtml(item.name)}</td>
        <td>${item.activeLoan ? badge("Borrowed", "on_loan") : "—"}</td>
        <td>${item.held ? badge("Held", "held") : "—"}</td>
        <td>${item.available ? badge("Available", "available") : badge("Unavailable", "unavailable")}</td>
        <td>${item.activeLoan ? `<code>${escapeHtml(item.activeLoan.borrowerId)}</code>` : "—"}</td>
        <td>${item.activeLoan ? `<code>${item.activeLoan.id}</code>` : "—"}</td>
        <td>${item.activeLoan ? escapeHtml(item.activeLoan.checkedOutAt) : "—"}</td>
      </tr>`,
  );

  const loanRow = (loan: Loan, withReturn: boolean) => `<tr>
        <td><code>${loan.id}</code></td>
        <td><code>${escapeHtml(loan.itemId)}</code></td>
        <td class="name">${escapeHtml(names.get(loan.itemId) ?? "")}</td>
        <td><code>${escapeHtml(loan.borrowerId)}</code></td>
        <td>${escapeHtml(loan.checkedOutAt)}</td>
        ${withReturn ? `<td>${loan.returnedAt ? escapeHtml(loan.returnedAt) : "—"}</td><td>${statusBadge(loan.status)}</td>` : ""}
      </tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>BorrowDesk snapshot ${escapeHtml(generatedAt)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>BorrowDesk equipment dashboard</h1>
  <p class="snapshot"><strong>Read-only snapshot</strong> of <code>${escapeHtml(source)}</code>
    generated at <strong>${escapeHtml(generatedAt)}</strong> (UTC). It does not update;
    regenerate it with the <code>report</code> command.</p>

  <ul class="summary">
    <li><b>${items.length}</b> items registered</li>
    <li><b>${available}</b> available</li>
    <li><b>${borrowed}</b> on loan</li>
    <li><b>${held}</b> held</li>
    <li><b>${loans.length}</b> loans recorded</li>
  </ul>
  <p class="summary-note">Availability, loans and holds are separate facts and may overlap: an item can be
    on loan and held at once, so available + on loan + held need not equal the item count.</p>

  <h2>Equipment</h2>
  ${table(["Item", "Name", "Borrowed", "Held", "Available", "Borrower", "Loan", "Checked out (UTC)"], itemRows, "No equipment registered.")}

  <h2>Active loans</h2>
  ${table(["Loan", "Item", "Name", "Borrower", "Checked out (UTC)"], activeLoans.map((loan) => loanRow(loan, false)), "No active loans.")}

  <h2>Loan history</h2>
  ${table(["Loan", "Item", "Name", "Borrower", "Checked out (UTC)", "Returned (UTC)", "Status"], loans.map((loan) => loanRow(loan, true)), "No loans recorded.")}
</main>
</body>
</html>
`;
}

function statusBadge(status: Item["status"] | Loan["status"]): string {
  return badge(STATUS_LABELS[status], status);
}

function badge(text: string, className: string): string {
  return `<span class="status ${className}">${text}</span>`;
}

function table(headings: string[], rows: string[], emptyText: string): string {
  if (rows.length === 0) return `<div class="table-wrap"><p class="empty">${emptyText}</p></div>`;
  const head = headings.map((heading) => `<th scope="col">${heading}</th>`).join("");
  return `<div class="table-wrap"><table>
      <thead><tr>${head}</tr></thead>
      <tbody>
      ${rows.join("\n      ")}
      </tbody>
    </table></div>`;
}
