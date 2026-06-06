import { describe, it, expect } from 'vitest';
import { categorizeFileReport, redact, toErrorEvent, fileReportToEvent, buildReport, formatReportText, reportFilename } from './report';
import { ProviderError } from '../provider/errors';
import { LauncherError } from '../launcher/client';
import type { FileReport } from '../ingest/types';

const ISO = '2026-06-06T12:34:56.789Z';
const fr = (p: Partial<FileReport>): FileReport => ({ name: 'f', type: 'unknown', ok: false, ...p });

describe('errors/report — categorizeFileReport', () => {
  it('returns null for an ok file', () => {
    expect(categorizeFileReport(fr({ ok: true }))).toBeNull();
  });
  it('honors an explicit errorCategory', () => {
    expect(categorizeFileReport(fr({ errorCategory: 'malformed_file' }))).toBe('malformed_file');
  });
  it('falls back to note heuristics when errorCategory is absent', () => {
    expect(categorizeFileReport(fr({ note: 'file too large to parse safely' }))).toBe('file_too_large');
    expect(categorizeFileReport(fr({ note: 'extractor error: boom' }))).toBe('extractor_error');
    expect(categorizeFileReport(fr({ note: 'unrecognized file type' }))).toBe('unsupported_format');
  });
});

describe('errors/report — redact', () => {
  it('strips a known key and any sk-shaped token', () => {
    expect(redact('auth=TOPSECRET failed', 'TOPSECRET')).not.toContain('TOPSECRET');
    expect(redact('used sk-ant-abc123 here')).toBe('used *** here');
  });
});

describe('errors/report — toErrorEvent', () => {
  it('normalizes a ProviderError (category + status/kind context, redacted message)', () => {
    const pe = new ProviderError({ kind: 'server', provider: 'claude', message: 'overloaded', retryable: true, status: 529 });
    const e = toErrorEvent(pe, { category: 'provider_error', at: ISO });
    expect(e.category).toBe('provider_error');
    expect(e.context?.status).toBe(529);
    expect(e.context?.kind).toBe('server');
    expect(e.context?.retryable).toBe(true);
    expect(e.message).toContain('overloaded');
  });
  it('normalizes a LauncherError (carries its code)', () => {
    const e = toErrorEvent(new LauncherError('conflict', 'slug_conflict'), { category: 'launcher_error', at: ISO });
    expect(e.context?.code).toBe('slug_conflict');
  });
  it('redacts a leaked key in a plain Error message', () => {
    const e = toErrorEvent(new Error('failed with sk-ant-LEAKLEAK'), { category: 'unexpected', at: ISO });
    expect(e.message).not.toContain('LEAKLEAK');
    expect(e.message).toContain('***');
  });
  it('redacts the known session key when supplied', () => {
    const e = toErrorEvent(new Error('key MYSECRET rejected'), { category: 'provider_error', at: ISO, apiKey: 'MYSECRET' });
    expect(e.message).not.toContain('MYSECRET');
  });
  it('handles a non-Error throwable', () => {
    const e = toErrorEvent('just a string', { category: 'unexpected', at: ISO });
    expect(e.message).toContain('just a string');
  });
});

describe('errors/report — fileReportToEvent', () => {
  it('builds an event with file + type context and the right category', () => {
    const e = fileReportToEvent(fr({ name: 'Acme_topo.csv', type: 'csv', errorCategory: 'unsupported_format', note: 'unrecognized' }), { at: ISO });
    expect(e.category).toBe('unsupported_format');
    expect(e.context?.file).toBe('Acme_topo.csv');
    expect(e.context?.type).toBe('csv');
  });
});

describe('errors/report — reportFilename', () => {
  it('derives a timestamped .txt name from an ISO instant (no tz drift)', () => {
    expect(reportFilename(ISO)).toBe('CaseForge-error-report-20260606-123456.txt');
  });
});

describe('errors/report — formatReportText', () => {
  const report = buildReport(
    [fileReportToEvent(fr({ name: 'Acme.docx', type: 'ooxml', errorCategory: 'unsupported_format', note: 'no extractor' }), { at: ISO })],
    [{ at: ISO, level: 'info', message: 'dropped 1 file' }],
    { generatedAt: ISO, appVersion: '0.2.0', userAgent: 'jsdom' },
  );

  it('renders issues + activity log, includes filenames by default', () => {
    const txt = formatReportText(report);
    expect(txt).toContain('CaseForge error report');
    expect(txt).toContain('Acme.docx');
    expect(txt).toContain('UNSUPPORTED_FORMAT');
    expect(txt).toContain('dropped 1 file');
  });

  it('redacts filenames when asked', () => {
    const txt = formatReportText(report, { redactFilenames: true });
    expect(txt).not.toContain('Acme.docx');
    expect(txt).toContain('file-1');
  });

  it('never leaks the session API key', () => {
    const leaky = buildReport(
      [toErrorEvent(new Error('boom'), { category: 'unexpected', at: ISO })],
      [{ at: ISO, level: 'error', message: 'token TOPSECRET here' }],
      { generatedAt: ISO, appVersion: '0.2.0' },
    );
    const safe = formatReportText(leaky, { apiKey: 'TOPSECRET' });
    expect(safe).not.toContain('TOPSECRET');
  });
});
