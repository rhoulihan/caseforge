import { describe, it, expect } from 'vitest';
import { SUPPORT_EMAIL, outlookWebComposeUrl, mailtoUrl, buildEmailSubject, buildEmailBody } from './email';
import type { ErrorCategory, ErrorEvent, ErrorReport } from './types';

const ev = (category: ErrorCategory, title: string): ErrorEvent => ({
  id: `${category}-1`,
  at: '2026-06-06T12:00:00.000Z',
  category,
  title,
  message: 'detail',
});
const report = (events: ErrorEvent[]): ErrorReport => ({
  meta: { generatedAt: '2026-06-06T12:00:00.000Z', appVersion: '0.2.0' },
  events,
  log: [],
});

describe('errors/email', () => {
  it('addresses the support inbox at Oracle', () => {
    expect(SUPPORT_EMAIL).toBe('rick.houlihan@oracle.com');
  });

  it('builds an Outlook web compose deeplink with encoded params', () => {
    const url = outlookWebComposeUrl({ to: SUPPORT_EMAIL, subject: 'a b', body: 'x&y' });
    expect(url.startsWith('https://outlook.office.com/mail/deeplink/compose?')).toBe(true);
    expect(url).toContain('to=rick.houlihan%40oracle.com');
    expect(url).toContain('subject=a%20b');
    expect(url).toContain('body=x%26y'); // & in the body must be encoded, not a param separator
  });

  it('builds a mailto: link with encoded subject + body', () => {
    const url = mailtoUrl({ to: SUPPORT_EMAIL, subject: 'a b', body: 'x&y' });
    expect(url.startsWith('mailto:rick.houlihan@oracle.com?')).toBe(true);
    expect(url).toContain('subject=a%20b');
    expect(url).toContain('body=x%26y');
  });

  it('summarizes the issue count + date in the subject', () => {
    const s = buildEmailSubject(report([ev('unsupported_format', 'x'), ev('provider_error', 'y')]));
    expect(s).toMatch(/CaseForge error report/i);
    expect(s).toMatch(/2 issue/);
    expect(s).toMatch(/2026-06-06/);
  });

  it('body names the attachment, instructs to attach, includes the support email + a category summary', () => {
    const body = buildEmailBody(report([ev('unsupported_format', 'x')]), 'CaseForge-error-report-20260606-120000.txt');
    expect(body).toContain('CaseForge-error-report-20260606-120000.txt');
    expect(body.toLowerCase()).toContain('attach');
    expect(body).toContain(SUPPORT_EMAIL);
    expect(body.toLowerCase()).toContain('unsupported file format');
  });

  it('keeps the body under the 1500-char cap even with many events (URL-safe)', () => {
    const many = Array.from({ length: 300 }, (_, i) => ev('unsupported_format', `file ${i}`));
    const body = buildEmailBody(report(many), 'r.txt');
    expect(body.length).toBeLessThanOrEqual(1500); // hard cap, including the overflow marker
    expect(body).toContain('r.txt'); // the essential attachment instruction survives truncation
    expect(body).toContain(SUPPORT_EMAIL);
  });
});
