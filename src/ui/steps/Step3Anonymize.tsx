// Step 3 · Anonymize — detect sensitive phrases LOCALLY (no LLM), let the rep review/edit the
// fail-closed map, then replace real text with slugs via the launcher BEFORE any AI call. Text and image
// primitives are sent to the LLM during triage (classifyText) / vision (readArtifactImage); tables and
// keyvalues are bound by local heuristics, so anonymizing text + redacting images is what protects privacy.

import { useState, useEffect } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { detectCandidates, detectCandidatesInImage, mergeDetected, type DetectedPhrase, type PhraseType } from '../../anon/detect';
import { suggestSlug, extendMap } from '../../anon/mapping';
import type { EvidenceBundle, Primitive } from '../../ingest/types';
import type { OcrWord } from '../../redaction/match';

interface ImgReview {
  id: number; // primitive index within the bundle — the STABLE identity (two images can share a source)
  source: string; // display label only
  url: string; // object URL of the REDACTED image (preview)
  rectCount: number;
  warning?: string;
}
// Keyed by primitive index, NOT source: two images with the same source (e.g. same-named .msg
// attachments) must never share an OCR-cache entry, or one image's word boxes would redact the other.
type OcrCache = Record<number, { words: OcrWord[]; meanConfidence: number }>;

const TYPES: PhraseType[] = ['org', 'person', 'host', 'term'];

export function Step3Anonymize() {
  const { state, patch, launcher } = useWizard();
  const { capture } = useErrors();
  const [health, setHealth] = useState<'checking' | 'up' | 'down'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newPhrase, setNewPhrase] = useState('');
  const [newType, setNewType] = useState<PhraseType>('term');
  const [scanning, setScanning] = useState(false);
  const [scanFailures, setScanFailures] = useState(0); // images whose OCR threw during the scan pass
  const [imgReview, setImgReview] = useState<ImgReview[]>([]);
  const [redactedPrims, setRedactedPrims] = useState<Primitive[] | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set()); // primitive indices excluded from vision
  const [ocrCache, setOcrCache] = useState<OcrCache>({}); // OCR words per image index (detection) → reused at redaction

  // Detect candidates once per bundle (re-detect when a new bundle is dropped → detected reset to []).
  // Guard on !imagesScanned: once the rep has scanned images, a fully-cleared list is a deliberate
  // state — re-running text-only detection here would silently drop the folded-in image-OCR candidates.
  useEffect(() => {
    if (state.bundle && !state.imagesScanned && state.detected.length === 0 && state.map.length === 0) {
      const detected = detectCandidates(state.bundle, state.config?.companyName ?? '');
      patch({ detected, map: extendMap(state.map, detected) });
    }
  }, [state.bundle, state.imagesScanned, state.detected.length, state.map.length, state.config, patch]);

  useEffect(() => {
    let alive = true;
    void launcher.health().then((ok) => alive && setHealth(ok ? 'up' : 'down'));
    return () => {
      alive = false;
    };
  }, [launcher]);

  // Back-nav recovery: if we remounted with the reviewed flag set but no local previews to show,
  // the review panel would be empty + unusable — force a re-scan so the rep can verify redactions.
  useEffect(() => {
    if (state.imagesReviewed && imgReview.length === 0) patch({ imagesReviewed: false, imageReviewKeys: [], imageAcknowledgedIds: [] });
  }, [state.imagesReviewed, imgReview.length, patch]);

  // Free preview object URLs when they're replaced (re-scan) or the step unmounts.
  useEffect(() => () => imgReview.forEach((r) => URL.revokeObjectURL(r.url)), [imgReview]);

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

  const company = state.config?.companyName ?? '';

  // Step A — OCR every image LOCALLY (no AI) and FOLD its text into the candidate list the rep approves,
  // so PII that appears only inside a chart/screenshot becomes a reviewable mapping entry. The OCR words
  // are cached so the redaction pass below doesn't scan twice.
  async function scanImagesForText(): Promise<void> {
    if (!state.bundle) return;
    setScanning(true);
    setError('');
    try {
      const { recognizeWords } = await import('../../redaction/browser'); // code-split: loads tesseract only now
      const cache: OcrCache = {};
      const imageLists: DetectedPhrase[][] = [];
      let failures = 0;
      const prims = state.bundle.primitives;
      for (let i = 0; i < prims.length; i++) {
        const p = prims[i]!;
        if (p.kind !== 'image') continue;
        try {
          const { words, meanConfidence } = await recognizeWords(p.bytes, p.mime);
          cache[i] = { words, meanConfidence }; // keyed by primitive index, never source
          imageLists.push(detectCandidatesInImage(words.map((w) => w.text).join(' '), p.source, company));
        } catch {
          failures++; // one image failing to OCR shouldn't block the rest — it's re-scanned + flagged at redaction
        }
      }
      const merged = mergeDetected(state.detected, ...imageLists);
      setOcrCache(cache);
      setScanFailures(failures);
      // The candidate list changed → any prior anonymize is stale; require re-anonymize.
      patch({ detected: merged, map: extendMap(state.map, merged), anonBundle: null, imagesScanned: true, imagesReviewed: false });
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'unexpected', title: 'Image scan failed', context: { step: 3 } });
    } finally {
      setScanning(false);
    }
  }

  // Step B — replace real text with slugs AND black out matched text in images (reusing the cached OCR),
  // then surface each redacted image for the rep to review.
  async function anonymizeAll(): Promise<void> {
    if (!state.bundle) return;
    setBusy(true);
    setError('');
    const review: ImgReview[] = []; // declared out here so the catch can revoke any URLs already created
    try {
      const hasImages = state.bundle.primitives.some((p) => p.kind === 'image');
      const redact = hasImages ? (await import('../../redaction/browser')).redactImageInBrowser : null;
      const primitives = await Promise.all(
        state.bundle.primitives.map(async (p, i) => {
          if (p.kind === 'text') return { ...p, text: (await launcher.anonymize(state.map, p.text)).text };
          if (p.kind === 'image' && redact) {
            const r = await redact({ bytes: p.bytes, mime: p.mime }, state.map, company, ocrCache[i]); // reuse THIS image's cached words
            review.push({ id: i, source: p.source, url: URL.createObjectURL(new Blob([new Uint8Array(r.bytes)], { type: r.mime })), rectCount: r.rectCount, warning: r.warning });
            return { ...p, bytes: r.bytes, mime: r.mime }; // non-JPEG is re-encoded to PNG by the redactor
          }
          return p;
        }),
      );
      review.sort((a, b) => a.id - b.id); // Promise.all resolves out of order; show previews in bundle order
      const anonBundle: EvidenceBundle = { files: state.bundle.files, primitives };
      setRedactedPrims(primitives);
      setImgReview(review);
      setExcluded(new Set());
      // Each redacted image must be acknowledged before Step 3 advances (D2). Capture the stable review
      // keys and clear prior acknowledgements (this is a fresh redaction the rep must re-review).
      patch({ anonBundle, imagesReviewed: true, imageReviewKeys: review.map((r) => `${r.id}:${r.source}`), imageAcknowledgedIds: [] });
    } catch (e) {
      review.forEach((r) => URL.revokeObjectURL(r.url)); // don't leak previews created before the throw
      setError((e as Error).message);
      capture(e, { category: 'launcher_error', title: 'Anonymization failed', context: { step: 3 } });
    } finally {
      setBusy(false);
    }
  }

  // Drop / re-include an image from the vision pass (the rep's lever when a preview looks wrong).
  // Keyed by primitive index so excluding one image can't collapse another that shares its source.
  function toggleExclude(id: number): void {
    if (!redactedPrims || !state.anonBundle) return;
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
    patch({ anonBundle: { files: state.anonBundle.files, primitives: redactedPrims.filter((p, i) => p.kind !== 'image' || !next.has(i)) }, imagesReviewed: true });
  }

  // D2: the rep attests they reviewed this redaction. Keyed by the stable primitive index + source.
  function toggleAcknowledge(id: number, source: string): void {
    const key = `${id}:${source}`;
    const acked = state.imageAcknowledgedIds.includes(key);
    patch({ imageAcknowledgedIds: acked ? state.imageAcknowledgedIds.filter((k) => k !== key) : [...state.imageAcknowledgedIds, key] });
  }
  const isAcked = (r: ImgReview): boolean => state.imageAcknowledgedIds.includes(`${r.id}:${r.source}`);

  const imageCount = state.bundle?.primitives.filter((p) => p.kind === 'image').length ?? 0;
  const needsScan = imageCount > 0 && !state.imagesScanned; // images must be OCR'd into the list first

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
                {d.source === 'image' ? <span class="cf-badge source"> from {d.imageSource?.split('#').pop()}</span> : null}
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
        <button type="button" class="cf-btn" disabled={busy || state.map.length === 0 || needsScan} onClick={() => void anonymizeAll()}>
          {busy ? 'Anonymizing…' : state.anonBundle ? 'Re-anonymize' : 'Anonymize & continue →'}
        </button>
        {needsScan ? <span class="cf-hint">Scan the {imageCount} image(s) below first ↓</span> : null}
        {state.anonBundle ? <span class="cf-ok">✓ {state.map.length} phrase(s) replaced — real text + matched image text will never reach the AI.</span> : null}
      </div>

      {imageCount > 0 ? (
        <div class="cf-imgreview">
          <h3>Images ({imageCount})</h3>
          <p class="cf-sub">
            Chart/screenshot images are read by the AI's vision model. Scan them locally (OCR — no AI): any text found is folded into the list
            above for your approval, then blacked out of the image before it's used.
          </p>
          {needsScan ? (
            <button type="button" class="cf-btn" disabled={scanning} onClick={() => void scanImagesForText()}>
              {scanning ? 'Scanning images…' : `Scan ${imageCount} image(s) for hidden text`}
            </button>
          ) : imgReview.length === 0 ? (
            scanFailures > 0 ? (
              <p class="cf-error">
                ⚠ {scanFailures} of {imageCount} image(s) could not be read (OCR failed) — they’ll be re-scanned and flagged when you anonymize. The rest were folded into the list above.
              </p>
            ) : (
              <p class="cf-ok">
                ✓ {imageCount} image(s) scanned — any text in them now appears in the list above. Click “{state.anonBundle ? 'Re-anonymize' : 'Anonymize & continue'}” to black it out + review the results.
              </p>
            )
          ) : (
            <>
              <div class="cf-imggrid">
                {imgReview.map((r) => (
                  <figure key={r.id} class={`cf-imgcard${excluded.has(r.id) ? ' excluded' : ''}${isAcked(r) ? '' : ' unacked'}`}>
                    <img src={r.url} alt={`redacted preview of ${r.source}`} />
                    <figcaption>
                      <span class="cf-muted">{r.source}</span>
                      <span>{r.rectCount > 0 ? `✓ ${r.rectCount} region(s) blacked out` : 'no matching text found'}</span>
                      {r.warning ? <span class="cf-error">⚠ {r.warning}</span> : null}
                      <label>
                        <input type="checkbox" checked={!excluded.has(r.id)} onChange={() => toggleExclude(r.id)} /> send this image to the AI
                      </label>
                      <label>
                        <input type="checkbox" aria-label={`acknowledge ${r.source}`} checked={isAcked(r)} onChange={() => toggleAcknowledge(r.id, r.source)} /> I have reviewed this redaction
                      </label>
                    </figcaption>
                  </figure>
                ))}
              </div>
              {(() => {
                const acked = imgReview.filter(isAcked).length;
                return acked < imgReview.length ? (
                  <p class="cf-hint">{acked} of {imgReview.length} image(s) acknowledged — review each redaction and tick “I have reviewed this redaction” before continuing.</p>
                ) : (
                  <p class="cf-ok">✓ All {imgReview.length} image(s) reviewed. Click Next.</p>
                );
              })()}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
