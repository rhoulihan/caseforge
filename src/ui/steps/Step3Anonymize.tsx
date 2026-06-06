// Step 3 · Anonymize — detect sensitive phrases LOCALLY (no LLM), let the rep review/edit the
// fail-closed map, then replace real text with slugs via the launcher BEFORE any AI call. Only TEXT
// primitives are sent to the LLM during triage (classifyProse) / vision (readChartImage); tables and
// keyvalues are bound by local heuristics, so anonymizing text primitives is what protects privacy.

import { useState, useEffect } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { detectCandidates, type DetectedPhrase, type PhraseType } from '../../anon/detect';
import { suggestSlug, type MapEntry } from '../../anon/mapping';
import type { EvidenceBundle, Primitive } from '../../ingest/types';

interface ImgReview {
  source: string;
  url: string; // object URL of the REDACTED image (preview)
  rectCount: number;
  warning?: string;
}

const TYPES: PhraseType[] = ['org', 'person', 'host', 'term'];

function mapFor(detected: DetectedPhrase[]): MapEntry[] {
  const n: Record<string, number> = {};
  return detected.map((d) => {
    n[d.type] = (n[d.type] ?? 0) + 1;
    return { phrase: d.phrase, slug: suggestSlug(d.type, n[d.type]!) };
  });
}

export function Step3Anonymize() {
  const { state, patch, launcher } = useWizard();
  const { capture } = useErrors();
  const [health, setHealth] = useState<'checking' | 'up' | 'down'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newPhrase, setNewPhrase] = useState('');
  const [newType, setNewType] = useState<PhraseType>('term');
  const [scanning, setScanning] = useState(false);
  const [imgReview, setImgReview] = useState<ImgReview[]>([]);
  const [redactedPrims, setRedactedPrims] = useState<Primitive[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // Detect candidates once per bundle (re-detect when a new bundle is dropped → detected reset to []).
  useEffect(() => {
    if (state.bundle && state.detected.length === 0 && state.map.length === 0) {
      const detected = detectCandidates(state.bundle, state.config?.companyName ?? '');
      patch({ detected, map: mapFor(detected) });
    }
  }, [state.bundle, state.detected.length, state.map.length, state.config, patch]);

  useEffect(() => {
    let alive = true;
    void launcher.health().then((ok) => alive && setHealth(ok ? 'up' : 'down'));
    return () => {
      alive = false;
    };
  }, [launcher]);

  const remove = (phrase: string): void =>
    patch({ detected: state.detected.filter((d) => d.phrase !== phrase), map: state.map.filter((m) => m.phrase !== phrase), anonBundle: null });

  const add = (): void => {
    const phrase = newPhrase.trim();
    if (!phrase || state.detected.some((d) => d.phrase.toLowerCase() === phrase.toLowerCase())) return;
    const idx = state.detected.filter((d) => d.type === newType).length + 1;
    patch({
      detected: [...state.detected, { phrase, type: newType, occurrences: 1, confidence: 1 }],
      map: [...state.map, { phrase, slug: suggestSlug(newType, idx) }],
      anonBundle: null,
    });
    setNewPhrase('');
  };

  async function anonymizeAll(): Promise<void> {
    if (!state.bundle) return;
    setBusy(true);
    setError('');
    try {
      // Only text primitives reach the LLM; replace their text via the launcher (real text → slugs).
      const primitives = await Promise.all(
        state.bundle.primitives.map(async (p) => (p.kind === 'text' ? { ...p, text: (await launcher.anonymize(state.map, p.text)).text } : p)),
      );
      const anonBundle: EvidenceBundle = { files: state.bundle.files, primitives };
      // Fresh anonBundle carries the RAW images again → require a re-scan if any are present.
      patch({ anonBundle, imagesReviewed: false });
      setRedactedPrims(null);
      setImgReview([]);
      setExcluded(new Set());
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'launcher_error', title: 'Anonymization failed', context: { step: 3 } });
    } finally {
      setBusy(false);
    }
  }

  // OCR each image LOCALLY (no AI), black out matched customer text, and let the rep review before use.
  async function scanImages(): Promise<void> {
    if (!state.anonBundle || !state.config) return;
    setScanning(true);
    setError('');
    try {
      const { redactImageInBrowser } = await import('../../redaction/browser'); // code-split: loads tesseract only now
      const review: ImgReview[] = [];
      const prims = await Promise.all(
        state.anonBundle.primitives.map(async (p) => {
          if (p.kind !== 'image') return p;
          const r = await redactImageInBrowser({ bytes: p.bytes, mime: p.mime }, state.map, state.config!.companyName);
          review.push({ source: p.source, url: URL.createObjectURL(new Blob([new Uint8Array(r.bytes)], { type: p.mime })), rectCount: r.rectCount, warning: r.warning });
          return { ...p, bytes: r.bytes };
        }),
      );
      setRedactedPrims(prims);
      setImgReview(review);
      setExcluded(new Set());
      patch({ anonBundle: { files: state.anonBundle.files, primitives: prims }, imagesReviewed: true });
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'unexpected', title: 'Image scan failed', context: { step: 3 } });
    } finally {
      setScanning(false);
    }
  }

  // Drop / re-include an image from the vision pass (the rep's lever when a preview looks wrong).
  function toggleExclude(source: string): void {
    if (!redactedPrims || !state.anonBundle) return;
    const next = new Set(excluded);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    setExcluded(next);
    patch({ anonBundle: { files: state.anonBundle.files, primitives: redactedPrims.filter((p) => p.kind !== 'image' || !next.has(p.source)) }, imagesReviewed: true });
  }

  const imageCount = state.anonBundle?.primitives.filter((p) => p.kind === 'image').length ?? 0;

  return (
    <section class="cf-card">
      <h2>3 · Anonymize</h2>
      <p class="cf-sub">Phrases detected locally (no AI). Everything below is replaced with slugs before any AI call — remove only false positives.</p>

      {health === 'down' ? (
        <p class="cf-error">Launcher not reachable. Start it with <code>caseforge serve --app-dir dist</code> (dev: it must run on :8080).</p>
      ) : null}

      <table class="cf-maptable">
        <thead>
          <tr>
            <th>Real phrase</th>
            <th>Type</th>
            <th class="num">Occurrences</th>
            <th>Replacement</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {state.detected.map((d, i) => (
            <tr key={d.phrase}>
              <td>{d.phrase}</td>
              <td>
                <span class={`cf-badge ${d.type}`}>{d.type}</span>
              </td>
              <td class="num">{d.occurrences}×</td>
              <td>
                <code class="cf-slug">{state.map[i]?.slug}</code>
              </td>
              <td>
                <button type="button" class="cf-x" aria-label={`Remove ${d.phrase}`} onClick={() => remove(d.phrase)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {state.detected.length === 0 ? <p class="cf-hint">No sensitive phrases detected. Add any the detector missed below.</p> : null}

      <div class="cf-addrow">
        <input type="text" aria-label="Add phrase" placeholder="Add a phrase the detector missed…" value={newPhrase} onInput={(e) => setNewPhrase(e.currentTarget.value)} />
        <select aria-label="Phrase type" value={newType} onChange={(e) => setNewType(e.currentTarget.value as PhraseType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="button" class="cf-btn ghost" onClick={add}>
          Add
        </button>
      </div>

      {error ? <p class="cf-error">{error}</p> : null}
      <div class="cf-anon-actions">
        <button type="button" class="cf-btn" disabled={busy || state.map.length === 0} onClick={() => void anonymizeAll()}>
          {busy ? 'Anonymizing…' : state.anonBundle ? 'Re-anonymize' : 'Anonymize & continue →'}
        </button>
        {state.anonBundle ? <span class="cf-ok">✓ {state.map.length} phrase(s) replaced — real text will never reach the AI.</span> : null}
      </div>

      {imageCount > 0 ? (
        <div class="cf-imgreview">
          <h3>Images ({imageCount})</h3>
          <p class="cf-sub">
            Chart/screenshot images are read by the AI's vision model. Scan them locally (OCR — no AI) to black out any customer-identifying
            text first, then review each before continuing.
          </p>
          {!state.imagesReviewed ? (
            <button type="button" class="cf-btn" disabled={scanning} onClick={() => void scanImages()}>
              {scanning ? 'Scanning images…' : `Scan & redact ${imageCount} image(s)`}
            </button>
          ) : (
            <>
              <div class="cf-imggrid">
                {imgReview.map((r) => (
                  <figure key={r.source} class={`cf-imgcard${excluded.has(r.source) ? ' excluded' : ''}`}>
                    <img src={r.url} alt={`redacted preview of ${r.source}`} />
                    <figcaption>
                      <span class="cf-muted">{r.source}</span>
                      <span>{r.rectCount > 0 ? `✓ ${r.rectCount} region(s) blacked out` : 'no matching text found'}</span>
                      {r.warning ? <span class="cf-error">⚠ {r.warning}</span> : null}
                      <label>
                        <input type="checkbox" checked={!excluded.has(r.source)} onChange={() => toggleExclude(r.source)} /> send this image to the AI
                      </label>
                    </figcaption>
                  </figure>
                ))}
              </div>
              <p class="cf-ok">✓ Images reviewed. Click Next.</p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
