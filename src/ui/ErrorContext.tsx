// App-wide error capture + lightweight session log, plus modal visibility (error report / help /
// about). Session-only (like the API key) — never persisted. Wraps the whole app so the header
// icons and every step can report via useErrors(). Timestamps are stamped here (the impure edge);
// the report/email building it delegates to is pure. Redaction uses the session key.

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useState, useCallback, useMemo, useRef } from 'preact/hooks';
import type { Context, ErrorCategory, ErrorEvent, ErrorReport, LogEntry } from '../errors/types';
import { buildReport, fileReportToEvent, toErrorEvent } from '../errors/report';
import type { FileReport } from '../ingest/types';
import { getSessionApiKey } from './WizardContext';
import { APP_VERSION } from '../version';

const MAX_EVENTS = 200;
const MAX_LOG = 200;

const nowIso = (): string => new Date().toISOString();
const userAgent = (): string | undefined => (typeof navigator !== 'undefined' ? navigator.userAgent : undefined);

export interface CaptureOpts {
  category: ErrorCategory;
  title?: string;
  context?: Context;
  /** Whether to auto-open the report dialog (default true). */
  open?: boolean;
}

export interface ErrorStore {
  events: ErrorEvent[];
  log: LogEntry[];
  dialogOpen: boolean;
  helpOpen: boolean;
  aboutOpen: boolean;
  /** Record any throwable as an error event (redacted) + a breadcrumb; opens the dialog unless open:false. */
  capture(err: unknown, opts: CaptureOpts): void;
  /** Record every failed ingest FileReport; opens the dialog if any failed (unless open:false). Returns the count. */
  captureFileReports(reports: FileReport[], open?: boolean): number;
  breadcrumb(level: LogEntry['level'], message: string, context?: Context): void;
  openDialog(): void;
  closeDialog(): void;
  openHelp(): void;
  closeHelp(): void;
  openAbout(): void;
  closeAbout(): void;
  clearEvents(): void;
  buildReport(): ErrorReport;
}

const ErrorCtx = createContext<ErrorStore | null>(null);

export function ErrorProvider({ children }: { children: ComponentChildren }) {
  const [events, setEvents] = useState<ErrorEvent[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const seq = useRef(0);

  const breadcrumb = useCallback((level: LogEntry['level'], message: string, context?: Context) => {
    setLog((l) => [...l, { at: nowIso(), level, message, context }].slice(-MAX_LOG));
  }, []);

  const capture = useCallback((err: unknown, opts: CaptureOpts) => {
    seq.current += 1;
    const e = toErrorEvent(err, { category: opts.category, at: nowIso(), seq: seq.current, title: opts.title, context: opts.context, apiKey: getSessionApiKey() });
    setEvents((es) => [...es, e].slice(-MAX_EVENTS));
    setLog((l) => [...l, { at: e.at, level: 'error' as const, message: `${e.category}: ${e.title}` }].slice(-MAX_LOG));
    if (opts.open !== false) setDialogOpen(true);
  }, []);

  const captureFileReports = useCallback((reports: FileReport[], open = true): number => {
    const failed = reports.filter((r) => !r.ok);
    if (failed.length === 0) return 0;
    const key = getSessionApiKey();
    const fresh = failed.map((fr) => {
      seq.current += 1;
      return fileReportToEvent(fr, { at: nowIso(), seq: seq.current, apiKey: key });
    });
    setEvents((es) => [...es, ...fresh].slice(-MAX_EVENTS));
    setLog((l) => [...l, { at: nowIso(), level: 'warn' as const, message: `${failed.length} file(s) could not be read` }].slice(-MAX_LOG));
    if (open) setDialogOpen(true);
    return failed.length;
  }, []);

  const buildReportFn = useCallback(
    () => buildReport(events, log, { generatedAt: nowIso(), appVersion: APP_VERSION, userAgent: userAgent() }),
    [events, log],
  );
  const clearEvents = useCallback(() => setEvents([]), []);

  const store = useMemo<ErrorStore>(
    () => ({
      events,
      log,
      dialogOpen,
      helpOpen,
      aboutOpen,
      capture,
      captureFileReports,
      breadcrumb,
      openDialog: () => setDialogOpen(true),
      closeDialog: () => setDialogOpen(false),
      openHelp: () => setHelpOpen(true),
      closeHelp: () => setHelpOpen(false),
      openAbout: () => setAboutOpen(true),
      closeAbout: () => setAboutOpen(false),
      clearEvents,
      buildReport: buildReportFn,
    }),
    [events, log, dialogOpen, helpOpen, aboutOpen, capture, captureFileReports, breadcrumb, clearEvents, buildReportFn],
  );

  return <ErrorCtx.Provider value={store}>{children}</ErrorCtx.Provider>;
}

export function useErrors(): ErrorStore {
  const ctx = useContext(ErrorCtx);
  if (!ctx) throw new Error('useErrors must be used within <ErrorProvider>');
  return ctx;
}
