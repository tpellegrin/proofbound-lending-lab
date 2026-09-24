/**
 * Stable error codes. These appear in the CLI's JSON error envelope and are
 * part of the documented compatibility surface (docs/behavior-v0.md).
 */
export type ErrorCode =
  // Rejected input or domain operation (CLI exit code 2).
  | "INVALID_ARGUMENTS"
  | "INVALID_INPUT"
  | "INVALID_DATABASE_PATH"
  | "DATABASE_NOT_FOUND"
  | "DATABASE_NOT_INITIALIZED"
  | "NOT_A_BORROWDESK_DATABASE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "ITEM_ALREADY_EXISTS"
  | "ITEM_NOT_FOUND"
  | "ITEM_UNAVAILABLE"
  | "LOAN_NOT_FOUND"
  | "LOAN_ALREADY_RETURNED"
  | "OUTPUT_EXISTS"
  | "INVALID_OUTPUT_PATH"
  // Unexpected execution or storage failure (CLI exit code 1).
  | "DATABASE_BUSY"
  | "STORAGE_ERROR"
  | "INTERNAL_ERROR";

const FAILURE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "DATABASE_BUSY",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
]);

/** An expected, reportable error with a stable code. */
export class BorrowDeskError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = "BorrowDeskError";
    this.code = code;
    this.field = field;
  }

  /** True when the error rejects the request rather than reporting a system failure. */
  get isRejection(): boolean {
    return !FAILURE_CODES.has(this.code);
  }
}
