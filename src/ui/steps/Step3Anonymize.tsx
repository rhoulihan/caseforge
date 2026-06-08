// Step 3 · Anonymize — detect sensitive phrases LOCALLY (no AI) in TEXT, let the rep review/edit the
// fail-closed map, then replace real text with slugs via the launcher BEFORE any AI call. Images are NOT
// scrubbed: CaseForge sends each image to the AI's vision model AS-IS, so the rep is responsible for making
// sure an image carries no sensitive content (or excluding it). Each image that will be sent must be
// reviewed + acknowledged before the step advances. Tables/keyvalues are bound by local heuristics.

import { useState, useEffect } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { detectCandidates, type PhraseType } from '../../anon/detect';
import { suggestSlug, extendMap } from '../../anon/mapping';
import type { EvidenceBundle, Primitive } from '../../ingest/types';

interface ImgReview {
  id: number; // primitive index within the bundle — the STABLE identity (two images can share a source)
  source: string; // display label only
  url: string; // object URL of the image (preview of exactly what is sent — unmodified)
}

const TYPES: PhraseType[] = ['org', 'person', 'host', 'term'];

export function Step3Anonymize() {
  const { state, patch, launcher } = useWizard();
  const { capture } = useErrors();
  const [health, setHealth] = useState<'checking' | 'up' | 'down'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newPhrase, setNewPhrase] = useState('');
  const [newType, setNewType] = useState<PhraseType>('term');
  const [imgReview, setImgReview] = useState<ImgReview[]>([]);
  const [anonPrims, setAnonPrims] = useState<Primitive[] | null>(null); // the anonymized primitives (text slugged, images as-is)
  const [excluded, setExcluded] = useState<Set<number>>(new Set()); // primitive indices excluded from the AI

  // Detect candidates once per bundle (re-detect when a new bundle is dropped → detected reset to []).
  useEffect(() => {
    if (state.bundle && state.detected.length === 0 && state.map.length === 0) {
      const detected = detectCandidates(state.bundle, state.config?.companyName ?? '');
      patch({ detected, map: extendMap(state.map, detected) });
    }
  }, [state.bundle, state.detected.length, state.map.length, state.config, patch]);

  useEffect(() => {
    let alive = true;
    void launcher.health().then((ok) => alive && setHealth(ok ? 'up' : 'down'));
    return () => {
      alive = false;
    };
  }, [launcher]);

  // Back-nav recovery: if we remounted with the reviewed flag set but no local previews to show, the review
  // panel would be empty + unusable — force a re-anonymize so the rep can re-review the images.
  useEffect(() => {
    if (state.imagesReviewed && imgReview.length === 0) patch({ imagesReviewed: false, imageReviewKeys: [], imageAcknowledgedIds: [] });
  }, [state.imagesReviewed, imgReview.length, patch]);

  // Free preview object URLs when they're replaced (re-anonymize) or the step unmounts.
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

  // Replace real text with slugs (launcher); images pass through UNMODIFIED and are surfaced for review —
  // CaseForge does not alter image pixels, so what the rep sees in the preview is exactly what is sent.
  async function anonymizeAll(): Promise<void> {
    if (!state.bundle) return;
    setBusy(true);
    setError('');
    const review: ImgReview[] = []; // declared out here so the catch can revoke any URLs already created
    try {
      const primitives = await Promise.all(
        state.bundle.primitives.map(async (p, i) => {
          if (p.kind === 'text') return { ...p, text: (await launcher.anonymize(state.map, p.text)).text };
          if (p.kind === 'image') {
            review.push({ id: i, source: p.source, url: URL.createObjectURL(new Blob([new Uint8Array(p.bytes)], { type: p.mime })) });
          }
          return p; // images (and tables/keyvalues) unchanged
        }),
      );
      review.sort((a, b) => a.id - b.id); // Promise.all resolves out of order; show previews in bundle order
      const anonBundle: EvidenceBundle = { files: state.bundle.files, primitives };
      setAnonPrims(primitives);
      setImgReview(review);
      setExcluded(new Set());
      // Each image that will be sent must be acknowledged before Step 3 advances. Capture the stable review
      // keys (full-bundle index + source) and clear prior acknowledgements (this is a fresh review pass).
      patch({ anonBundle, imagesReviewed: true, imageReviewKeys: review.map((r) => `${r.id}:${r.source}`), imageAcknowledgedIds: [] });
    } catch (e) {
      review.forEach((r) => URL.revokeObjectURL(r.url)); // don't leak previews created before the throw
      setError((e as Error).message);
      capture(e, { category: 'launcher_error', title: 'Anonymization failed', context: { step: 3 } });
    } finally {
      setBusy(false);
    }
  }

  // Drop / re-include an image from the AI. Excluding an image also drops it from the review gate — an
  // image that isn't sent doesn't need a "safe to send" acknowledgement. Keyed by primitive index.
  function toggleExclude(id: number): void {
    if (!anonPrims || !state.anonBundle) return;
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
    const reviewKeys = imgReview.filter((r) => !next.has(r.id)).map((r) => `${r.id}:${r.source}`);
    patch({
      anonBundle: { files: state.anonBundle.files, primitives: anonPrims.filter((p, i) => p.kind !== 'image' || !next.has(i)) },
      imagesReviewed: true,
      imageReviewKeys: reviewKeys,
    });
  }

  // The rep attests they reviewed this image and it is safe to send. Keyed by the stable index + source.
  function toggleAcknowledge(id: number, source: string): void {
    const key = `${id}:${source}`;
    const acked = state.imageAcknowledgedIds.includes(key);
    patch({ imageAcknowledgedIds: acked ? state.imageAcknowledgedIds.filter((k) => k !== key) : [...state.imageAcknowledgedIds, key] });
  }
  const isAcked = (r: ImgReview): boolean => state.imageAcknowledgedIds.includes(`${r.id}:${r.source}`);

  const imageCount = state.bundle?.primitives.filter((p) => p.kind === 'image').length ?? 0;

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
          <p class="cf-error">
            ⚠ CaseForge does <b>not</b> scrub text inside images. Each image is sent to the AI's vision model <b>exactly as shown</b>. You are
            responsible for making sure an image has no sensitive content you don't want shared — review each preview and untick
            “send this image to the AI” to exclude any image.
          </p>
          {imgReview.length === 0 ? (
            <p class="cf-hint">Click “{state.anonBundle ? 'Re-anonymize' : 'Anonymize & continue'}” to preview the {imageCount} image(s) that will be sent.</p>
          ) : (
            <>
              <div class="cf-imggrid">
                {imgReview.map((r) => (
                  <figure key={r.id} class={`cf-imgcard${excluded.has(r.id) ? ' excluded' : ''}${excluded.has(r.id) || isAcked(r) ? '' : ' unacked'}`}>
                    <img src={r.url} alt={`preview of ${r.source} (sent to the AI as-is)`} />
                    <figcaption>
                      <span class="cf-muted">{r.source}</span>
                      <label>
                        <input type="checkbox" checked={!excluded.has(r.id)} onChange={() => toggleExclude(r.id)} /> send this image to the AI
                      </label>
                      {!excluded.has(r.id) ? (
                        <label>
                          <input type="checkbox" aria-label={`acknowledge ${r.source}`} checked={isAcked(r)} onChange={() => toggleAcknowledge(r.id, r.source)} /> I have reviewed this image — it's safe to send
                        </label>
                      ) : null}
                    </figcaption>
                  </figure>
                ))}
              </div>
              {(() => {
                const sent = imgReview.filter((r) => !excluded.has(r.id));
                const acked = sent.filter(isAcked).length;
                return acked < sent.length ? (
                  <p class="cf-hint">{acked} of {sent.length} image(s) acknowledged — review each one and tick “I have reviewed this image” (or exclude it) before continuing.</p>
                ) : (
                  <p class="cf-ok">✓ All {sent.length} image(s) to be sent have been reviewed. Click Next.</p>
                );
              })()}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
