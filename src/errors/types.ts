// Types for centralized error capture + the rep-facing error report. Kept free of Preact so the
// report-building and email-link logic is pure and unit-tested. The app-wide ErrorCategory extends
// the file-relevant subset defined by the ingest layer (single source of truth for the shared cases).

import type { FileErrorCategory } from '../ingest/types';

export type ErrorCategory =
  | FileErrorCategory // unsupported_format | malformed_file | file_too_large | extractor_error
  | 'provider_error' // an LLM provider call failed (ProviderError)
  | 'launcher_error' // a local launcher endpoint failed (LauncherError)
  | 'validation_error' // a typed validation error (TCO research / prose / classify)
  | 'unexpected'; // uncaught exception or anything otherwise unclassified

/** A redaction-safe primitive value for structured error/log context. */
export type ContextValue = string | number | boolean | undefined;
export type Context = Record<string, ContextValue>;

/** One captured problem, shown in the dialog and serialized into the report. */
export interface ErrorEvent {
  id: string; // stable within a session (category + sequence) — used for keys + dedup
  at: string; // ISO timestamp
  category: ErrorCategory;
  title: string; // short, rep-facing
  message: string; // already redacted (no API keys, no file contents)
  context?: Context; // filename / type / size / step / status … (redaction-safe values only)
}

/** A lightweight breadcrumb — step transitions and operation outcomes, for diagnostic context. */
export interface LogEntry {
  at: string; // ISO timestamp
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Context;
}

export interface ReportMeta {
  generatedAt: string; // ISO
  appVersion: string;
  userAgent?: string;
}

/** The full error report — what gets formatted to text, downloaded, and attached to the email. */
export interface ErrorReport {
  meta: ReportMeta;
  events: ErrorEvent[];
  log: LogEntry[];
}
