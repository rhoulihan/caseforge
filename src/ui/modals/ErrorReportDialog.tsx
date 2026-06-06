// The error-report dialog. Auto-opens when files are skipped or an unexpected error is captured.
// "Send report" downloads the (scrubbed) report file AND opens a pre-filled email to Rick — the rep
// then attaches the downloaded file (browsers can't attach it automatically). The full report text
// is shown for review before anything leaves the machine.

import { useState } from 'preact/hooks';
import { useErrors } from '../ErrorContext';
import { getSessionApiKey } from '../WizardContext';
import { Modal } from './Modal';
import { download } from '../download';
import { formatReportText, reportFilename } from '../../errors/report';
import { SUPPORT_EMAIL, outlookWebComposeUrl, mailtoUrl, buildEmailSubject, buildEmailBody } from '../../errors/email';
import { CATEGORY_LABELS } from '../../errors/labels';

export function ErrorReportDialog() {
  const { dialogOpen, events, closeDialog, buildReport } = useErrors();
  const [sent, setSent] = useState(false);
  if (!dialogOpen) return null;

  const report = buildReport();
  const text = formatReportText(report, { apiKey: getSessionApiKey() });
  const filename = reportFilename(report.meta.generatedAt);
  const subject = buildEmailSubject(report);
  const body = buildEmailBody(report, filename);

  function sendVia(url: string): void {
    download(filename, text, 'text/plain'); // the rep attaches this; compose windows can't auto-attach
    window.open(url, '_blank', 'noopener');
    setSent(true);
  }

  const footer = (
    <>
      <button type="button" class="cf-btn ghost" onClick={closeDialog}>
        Continue without reporting
      </button>
      <button type="button" class="cf-btn" onClick={() => sendVia(outlookWebComposeUrl({ to: SUPPORT_EMAIL, subject, body }))}>
        Send report to Rick
      </button>
    </>
  );

  return (
    <Modal title="Send an error report" onClose={closeDialog} footer={events.length > 0 ? footer : undefined}>
      {events.length === 0 ? (
        <p class="cf-hint">No issues recorded.</p>
      ) : (
        <>
          <p class="cf-sub">
            CaseForge ran into {events.length} issue{events.length === 1 ? '' : 's'}. Please send a report to <b>{SUPPORT_EMAIL}</b> so it can be fixed — the
            report downloads as a file you then attach to the email.
          </p>
          <ul class="cf-errlist">
            {events.map((e) => (
              <li key={e.id}>
                <b>{CATEGORY_LABELS[e.category]}</b> — {e.title}
                {e.message ? <div class="cf-muted">{e.message}</div> : null}
              </li>
            ))}
          </ul>

          <details class="cf-report-details">
            <summary>Review the full report before sending</summary>
            <pre class="cf-report-preview">{text}</pre>
          </details>

          <div class="cf-report-actions">
            <button type="button" class="cf-btn ghost" onClick={() => download(filename, text, 'text/plain')}>
              ⬇ Download report only
            </button>
            <button type="button" class="cf-linkbtn" onClick={() => sendVia(mailtoUrl({ to: SUPPORT_EMAIL, subject, body }))}>
              use my default mail app instead
            </button>
          </div>

          {sent ? (
            <p class="cf-ok" role="status">
              ✓ Report downloaded as <code>{filename}</code> and an email to {SUPPORT_EMAIL} opened. Please <b>attach the downloaded file</b> and send.
            </p>
          ) : null}
          <p class="cf-hint" style="margin-top:10px">
            Need more help? Email {SUPPORT_EMAIL}.
          </p>
        </>
      )}
    </Modal>
  );
}
