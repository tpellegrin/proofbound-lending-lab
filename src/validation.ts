import { BorrowDeskError } from "./errors.js";

/**
 * Item and borrower identifiers: 1-64 characters of lowercase ASCII letters,
 * digits, "-", "_" or ".", starting with a letter or digit. Input is never
 * normalized; anything else is rejected.
 */
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const MAX_NAME_LENGTH = 200;

// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function requireIdentifier(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new BorrowDeskError(
      "INVALID_INPUT",
      `${label} must be 1-64 characters of lowercase letters, digits, "-", "_" or ".", ` +
        `starting with a letter or digit; got ${describe(value)}`,
      field,
    );
  }
  return value;
}

export function requireItemId(value: unknown): string {
  return requireIdentifier(value, "itemId", "Item id");
}

export function requireBorrowerId(value: unknown): string {
  return requireIdentifier(value, "borrowerId", "Borrower id");
}

/**
 * Item names are stored exactly as given. They must be 1-200 characters,
 * must not begin or end with whitespace, must not contain control characters,
 * and must be well-formed Unicode.
 */
export function requireItemName(value: unknown): string {
  const fail = (reason: string): never => {
    throw new BorrowDeskError("INVALID_INPUT", `Item name ${reason}`, "name");
  };
  if (typeof value !== "string") return fail("must be a string");
  if (value.length === 0) return fail("must not be empty");
  if (!value.isWellFormed()) return fail("must be well-formed Unicode");
  if ([...value].length > MAX_NAME_LENGTH) return fail(`must be at most ${MAX_NAME_LENGTH} characters`);
  if (value.trim() !== value) return fail("must not begin or end with whitespace");
  if (CONTROL_CHARACTER.test(value)) return fail("must not contain control characters");
  return value;
}

/** Loan ids are positive integers assigned by the database. */
export function requireLoanId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new BorrowDeskError(
    "INVALID_INPUT",
    `Loan id must be a positive integer; got ${describe(value)}`,
    "loanId",
  );
}

/** Parses a loan id from text such as a command-line argument. */
export function parseLoanId(text: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(text)) {
    throw new BorrowDeskError(
      "INVALID_INPUT",
      `Loan id must be a positive integer; got ${describe(text)}`,
      "loanId",
    );
  }
  return requireLoanId(Number(text));
}

function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
  }
  return value === null ? "null" : typeof value;
}
