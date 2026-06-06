// Step 7 · Export — download the rendered deliverables. All data stays local; the output already
// carries real names (no slugs in the deliverables), so there is nothing to deanonymize.

import { useWizard } from '../WizardContext';

function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Step7Export() {
  const { state } = useWizard();
  const out = state.pipeline;
  if (!out?.docModel) {
    return (
      <section class="cf-card">
        <h2>7 · Export</h2>
        <p class="cf-hint">Nothing to export yet — generate the deliverables first.</p>
      </section>
    );
  }
  const rendered = out.rendered;
  const combined =
    '<!doctype html><meta charset="utf-8"><title>CaseForge deliverables</title>\n' + rendered.map((r) => r.html).join('\n<hr style="margin:48px 0"/>\n');

  return (
    <section class="cf-card">
      <h2>7 · Export</h2>
      <p class="cf-sub">All data stays local. Real names are already in place — download &amp; share.</p>
      <div class="cf-export">
        {rendered.map((r) => (
          <button key={r.filename} type="button" class="cf-btn ghost" onClick={() => download(r.filename, r.html, 'text/html')}>
            ⬇ {r.filename}
          </button>
        ))}
        <button type="button" class="cf-btn" onClick={() => download('caseforge-deliverables.html', combined, 'text/html')}>
          ⬇ All deliverables (one HTML)
        </button>
        <button type="button" class="cf-btn ghost" onClick={() => download('caseforge-docmodel.json', JSON.stringify(out.docModel, null, 2), 'application/json')}>
          ⬇ Data (JSON)
        </button>
      </div>
      <p class="cf-ok" style="margin-top:14px">✓ Complete. {rendered.length} deliverable(s) ready.</p>
    </section>
  );
}
