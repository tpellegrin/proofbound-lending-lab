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
  | "DATABASE_CORRUPT"
  | "MIGRATION_REQUIRED"
  | "ITEM_ALREADY_EXISTS"
  | "ITEM_NOT_FOUND"
  | "ITEM_UNAVAILABLE"
  | "ITEM_HELD"
  | "LOAN_NOT_FOUND"
  | "LOAN_ALREADY_RETURNED"
  | "OUTPUT_EXISTS"
  | "INVALID_OUTPUT_PATH"
  // Unexpected execution or storage failure (CLI exit code 1).
  | "DATABASE_BUSY"
  | "STORAGE_ERROR"
  | "BACKUP_FAILED"
  | "INTERNAL_ERROR";

const FAILURE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "DATABASE_BUSY",
  "STORAGE_ERROR",
  "BACKUP_FAILED",
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

/**
 * Attaches additive failure annotations (such as `backup` and `leftover`) to a
 * thrown error object. Keeping the annotation on the original error preserves
 * its type, so the CLI's existing code/exit classification is unchanged.
 */
export function annotateError<T>(error: T, annotation: Record<string, unknown>): T {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.assign(error, annotation);
  }
  return error;
}
