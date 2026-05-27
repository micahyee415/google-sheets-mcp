/**
 * Structured JSON logger for Cloud Run.
 * Writes to stderr — Cloud Logging picks this up and indexes the fields.
 */

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface LogFields {
  userEmail?: string;
  tool?: string;
  durationMs?: number;
  statusCode?: number;
  reason?: string;
  port?: number;
  serviceAccount?: string;
  retryAfter?: number;
  event?:
    | "login"
    | "auth_failure"
    | "usage"
    | "rate_limited"
    | "registration"
    | "group_sync"
    | "group_sync_error"
    | "write"
    | "bulk_write_alert"
    | "bulk_write_alert_failed";
  [key: string]: unknown;
}

function write(severity: Severity, message: string, fields?: LogFields): void {
  console.error(
    JSON.stringify({ severity, message, timestamp: new Date().toISOString(), ...fields })
  );
}

export const logger = {
  info:  (message: string, fields?: LogFields) => write("INFO",    message, fields),
  warn:  (message: string, fields?: LogFields) => write("WARNING", message, fields),
  error: (message: string, fields?: LogFields) => write("ERROR",   message, fields),
};
