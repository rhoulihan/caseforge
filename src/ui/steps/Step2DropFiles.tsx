// Step 2 · Drop files — drag/drop or pick the customer's artifacts; parse them LOCALLY via
// ingestAsync (no LLM, nothing sent anywhere). Shows a per-file report; advance-validity is "bundle
// has ≥1 evidence item". Dropping new files resets downstream state (anonymized).

import { useState } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';

const MAX_ARCHIVE_SOURCE_BYTES = 50 * 1024 * 1024; // don't embed an original this large in the saved archive

export function Step2DropFiles() {
  const { state, patch } = useWizard();
  const { captureFileReports, breadcrumb, capture } = useErrors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleFiles(list: FileList | null): Promise<void> {
    const arr = list ? Array.from(list) : [];
    if (arr.length === 0) return;
    setBusy(true);
    setError('');
    try {
      // Lazy-load the parsers (exceljs/unpdf/msgreader) only on first drop — keeps them out of the
      // initial bundle (Vite code-splits this dynamic import into its own chunk).
      const [{ ingestAsync }, { BINARY_EXTRACTORS }] = await Promise.all([import('../../ingest/ingest'), import('../../ingest/binary')]);
      const files = await Promise.all(arr.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const fresh = await ingestAsync(files, BINARY_EXTRACTORS);
      // rawFiles keeps the ORIGINAL uploads for the archive's sources/ — bounded so one huge file can't
      // overflow the archive cap (the file is still analyzed; only its embedding in the archive is skipped).
      const newRaw = files.filter((f) => f.bytes.length <= MAX_ARCHIVE_SOURCE_BYTES);
      if (newRaw.length < files.length) breadcrumb('warn', `${files.length - newRaw.length} large file(s) omitted from the saved archive's sources (still analyzed)`);

      if (state.addFilesMode && state.bundle) {
        // ADD-FILES: append to the existing case. Detect over ONLY the new primitives and EXTEND the
        // approved map (existing slugs preserved); re-anonymize over the full bundle (fail-closed — a new
        // phrase may also occur in old content). Keep map/detected/versions/history; invalidate downstream.
        const { detectCandidates, mergeDetected } = await import('../../anon/detect');
        const { extendMap } = await import('../../anon/mapping');
        const merged = mergeDetected(state.detected, detectCandidates(fresh, state.config?.companyName ?? ''));
        const bundle = { files: [...state.bundle.files, ...fresh.files], primitives: [...state.bundle.primitives, ...fresh.primitives] };
        patch({
          bundle,
          rawFiles: [...state.rawFiles, ...newRaw],
          detected: merged,
          map: extendMap(state.map, merged),
          anonBundle: null, // re-anonymize the full combined bundle with the extended map
          imagesReviewed: false,
          imagesVerifiedClean: false,
          triage: null,
          confirmed: false,
          pipeline: null,
        });
        breadcrumb('info', `added ${fresh.files.length} file(s) to the case (${fresh.primitives.length} new item(s))`);
        captureFileReports(fresh.files);
        return;
      }

      // New case (or re-drop): full reset.
      patch({ bundle: fresh, rawFiles: newRaw, detected: [], map: [], anonBundle: null, imagesReviewed: false, imagesVerifiedClean: false, triage: null, confirmed: false, pipeline: null });
      breadcrumb('info', `ingested ${fresh.files.length} file(s), ${fresh.primitives.length} evidence item(s)`);
      // Skipped/unsupported files are recorded and offered as an error report (the good files still flow through).
      captureFileReports(fresh.files);
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'unexpected', title: 'Could not read files', context: { step: 2 } });
    } finally {
      setBusy(false);
    }
  }

  const bundle = state.bundle;
  return (
    <section class="cf-card">
      <h2>2 · Drop files</h2>
      <p class="cf-sub">Drop the customer's artifacts (.xlsx, .docx, .pptx, .pdf, .msg/.eml, .csv, .html, images…). Parsed locally — nothing is sent anywhere yet.</p>

      <div
        class="cf-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void handleFiles(e.dataTransfer?.files ?? null);
        }}
      >
        <p>Drag files here, or</p>
        <input type="file" multiple aria-label="Choose files" onChange={(e) => void handleFiles(e.currentTarget.files)} />
      </div>

      {busy ? <p class="cf-hint">Parsing locally…</p> : null}
      {error ? <p class="cf-error">Could not read files: {error}</p> : null}

      {bundle ? (
        <div class="cf-filereport">
          <p>
            <b>{bundle.files.length}</b> file(s) · <b>{bundle.primitives.length}</b> evidence item(s) extracted
          </p>
          <ul>
            {bundle.files.map((f) => (
              <li key={f.name} class={f.ok ? 'ok' : 'bad'}>
                {f.ok ? '✓' : '⚠'} {f.name} <span class="cf-muted">({f.type}{f.note ? ` — ${f.note}` : ''})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
