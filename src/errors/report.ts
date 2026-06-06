// Pure report-building: classify ingest failures, normalize any throwable into a redaction-safe
// ErrorEvent, and format the human-readable report text. No Preact, no I/O — fully unit-tested.
// Invariant: the API key never appears in the output, and file CONTENTS are never included.

import type { FileReport } from '../ingest/types';
import { redactKey } from '../provider/errors';
import { CATEGORY_LABELS } from './labels';
import type { Context, ErrorCategory, ErrorEvent, ErrorReport, LogEntry, ReportMeta } from './types';

/** Strip a known API key + any sk-shaped token from text before it is surfaced or saved. */
export function redact(text: string, apiKey?: string): string {
  return redactKey(text, apiKey);
}

/** Why an ingest file failed — explicit category if present, else a note-string heuristic. Null if ok. */
export function categorizeFileReport(fr: FileReport): ErrorCategory | null {
  if (fr.ok) return null;
  if (fr.errorCategory) return fr.errorCategory;
  const note = fr.note ?? '';
  if (/too large/i.test(note)) return 'file_too_large';
  if (/extractor error/i.test(note)) return 'extractor_error';
  return 'unsupported_format';
}

function defaultTitle(category: ErrorCategory): string {
  const l = CATEGORY_LABELS[category];
  return l.charAt(0).toUpperCase() + l.slice(1);
}

// --- safe field extraction from an unknown throwable (decoupled from the error classes) ---
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
function assignDefined(target: Context, src: Context): void {
  for (const k of Object.keys(src)) if (src[k] !== undefined) target[k] = src[k];
}

export interface ToEventOpts {
  category: ErrorCategory;
  at: string;
  seq?: number;
  title?: string;
  context?: Context;
  apiKey?: string;
}

/** Normalize any throwable into a redacted ErrorEvent, lifting useful fields off typed errors. */
export function toErrorEvent(err: unknown, opts: ToEventOpts): ErrorEvent {
  const rec = asRecord(err);
  const name = str(rec.name);
  const rawMessage = err instanceof Error ? err.message : str(rec.message) ?? String(err);
  const context: Context = { ...opts.context };
  if (name === 'ProviderError') {
    assignDefined(context, { kind: str(rec.kind), status: num(rec.status), provider: str(rec.provider), retryable: bool(rec.retryable) });
  } else if (name === 'LauncherError') {
    assignDefined(context, { code: str(rec.code) });
  }
  return {
    id: `${opts.category}-${opts.seq ?? 1}`,
    at: opts.at,
    category: opts.category,
    title: opts.title ?? defaultTitle(opts.category),
    message: redact(rawMessage, opts.apiKey),
    context: Object.keys(context).length ? context : undefined,
  };
}

/** Build an ErrorEvent from a failed ingest FileReport (filename + type carried as context). */
export function fileReportToEvent(fr: FileReport, opts: { at: string; seq?: number; apiKey?: string }): ErrorEvent {
  const category = categorizeFileReport(fr) ?? 'unsupported_format';
  return {
    id: `${category}-${opts.seq ?? 1}`,
    at: opts.at,
    category,
    title: `${defaultTitle(category)}: ${fr.name}`,
    message: redact(fr.note ?? CATEGORY_LABELS[category], opts.apiKey),
    context: { file: fr.name, type: fr.type },
  };
}

export function buildReport(events: ErrorEvent[], log: LogEntry[], meta: ReportMeta): ErrorReport {
  return { meta, events, log };
}

/** Filename for the downloaded report — timestamped from an ISO instant (no timezone drift). */
export function reportFilename(at: string): string {
  const stamp = at.slice(0, 19).replace(/[-:]/g, '').replace('T', '-'); // 2026-06-06T12:34:56 → 20260606-123456
  return `CaseForge-error-report-${stamp}.txt`;
}

function formatContext(ctx?: Context): string {
  if (!ctx) return '';
  return Object.keys(ctx)
    .filter((k) => ctx[k] !== undefined)
    .map((k) => `${k}=${ctx[k]}`)
    .join(', ');
}

function redactFilenamesIn(text: string, report: ErrorReport): string {
  const names = [...new Set(report.events.map((e) => e.context?.file).filter((f): f is string => typeof f === 'string'))];
  let out = text;
  names.forEach((name, i) => {
    out = out.split(name).join(`file-${i + 1}`);
  });
  return out;
}

export interface FormatOpts {
  redactFilenames?: boolean;
  apiKey?: string; // defensively scrubbed from the whole output
}

/** Render the report as plain text suitable for download + email attachment. */
export function formatReportText(report: ErrorReport, opts: FormatOpts = {}): string {
  const lines: string[] = [];
  lines.push('CaseForge error report');
  lines.push(`Generated: ${report.meta.generatedAt}`);
  lines.push(`App:       CaseForge ${report.meta.appVersion}`);
  if (report.meta.userAgent) lines.push(`Browser:   ${report.meta.userAgent}`);
  lines.push('');
  lines.push(`== ISSUES (${report.events.length}) ==`);
  for (const e of report.events) {
    lines.push(`[${e.at}] ${e.category.toUpperCase()} — ${e.title}`);
    if (e.message) lines.push(`  ${e.message}`);
    const ctx = formatContext(e.context);
    if (ctx) lines.push(`  context: ${ctx}`);
  }
  lines.push('');
  lines.push(`== ACTIVITY LOG (${report.log.length}) ==`);
  for (const l of report.log) {
    lines.push(`[${l.at}] ${l.level.toUpperCase()} ${l.message}`);
    const ctx = formatContext(l.context);
    if (ctx) lines.push(`  context: ${ctx}`);
  }
  let text = lines.join('\n') + '\n';
  if (opts.redactFilenames) text = redactFilenamesIn(text, report);
  text = redact(text, opts.apiKey); // strips the session key + any sk-shaped token, always
  return text;
}
