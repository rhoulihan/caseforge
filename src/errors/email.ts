// Pure builders for the "send report" links + the pre-filled email text. Browsers CANNOT attach a
// file to a mailto:/compose URL, so the body instructs the rep to attach the separately-downloaded
// report. Bodies are length-capped so they survive URL-encoding into a compose deeplink.

import type { ErrorCategory, ErrorReport } from './types';
import { CATEGORY_LABELS } from './labels';

export const SUPPORT_EMAIL = 'rick.houlihan@oracle.com';

/** Keep the encoded body well under typical URL limits; the full detail rides in the attachment. */
const MAX_BODY_CHARS = 1500;

export interface ComposeParams {
  to: string;
  subject: string;
  body: string;
}

/** Outlook-on-the-web compose deeplink (Office 365). Pre-fills to/subject/body; cannot attach. */
export function outlookWebComposeUrl({ to, subject, body }: ComposeParams): string {
  const q = `to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `https://outlook.office.com/mail/deeplink/compose?${q}`;
}

/** mailto: link — opens the rep's default mail client (desktop Outlook, etc.). Cannot attach. */
export function mailtoUrl({ to, subject, body }: ComposeParams): string {
  const q = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${to}?${q}`;
}

export function buildEmailSubject(report: ErrorReport): string {
  const n = report.events.length;
  const date = report.meta.generatedAt.slice(0, 10);
  return `CaseForge error report — ${n} issue${n === 1 ? '' : 's'} — ${date}`;
}

/** Count events per category, most-frequent first. */
function categoryCounts(report: ErrorReport): { category: ErrorCategory; count: number }[] {
  const counts = new Map<ErrorCategory, number>();
  for (const e of report.events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

export function buildEmailBody(report: ErrorReport, attachmentFilename: string): string {
  // Footer holds the essential instructions; it is added LAST so it always survives the cap.
  const footer =
    `\nThe full diagnostic report is attached as "${attachmentFilename}".\n` +
    `Please ATTACH that file before sending — your browser can't attach it automatically.\n` +
    `If anything in it looks sensitive, review or remove it first.\n\n` +
    `For additional assistance: ${SUPPORT_EMAIL}\n\n` +
    `— sent from CaseForge ${report.meta.appVersion}`;
  const header = `Hi Rick,\n\nCaseForge hit ${report.events.length} issue(s) while I was preparing a case:\n`;

  const overflow = '  • …more (see the attached report)\n';
  let summary = '';
  for (const { category, count } of categoryCounts(report)) {
    const line = `  • ${count} × ${CATEGORY_LABELS[category]}\n`;
    if ((header + summary + line + footer).length > MAX_BODY_CHARS) {
      // Only add the overflow marker if it too fits; the footer (the essential instructions) always survives.
      if ((header + summary + overflow + footer).length <= MAX_BODY_CHARS) summary += overflow;
      break;
    }
    summary += line;
  }
  return header + summary + footer;
}
