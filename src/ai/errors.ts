export type InsightErrorCode =
  | "config"
  | "empty_scope"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "server"
  | "network"
  | "timeout"
  | "empty"
  | "context"
  | "aborted"
  | "unknown";

export class InsightError extends Error {
  constructor(
    readonly code: InsightErrorCode,
    message?: string,
    readonly status?: number,
    readonly detail?: string
  ) {
    super(message ?? code);
    this.name = "InsightError";
  }
}
