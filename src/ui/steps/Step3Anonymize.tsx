// Step 3 · Anonymize — detect sensitive phrases LOCALLY (no LLM), let the rep review/edit the
// fail-closed map, then replace real text with slugs via the launcher BEFORE any AI call. Only TEXT
// primitives are sent to the LLM during triage (classifyProse) / vision (readChartImage); tables and
// keyvalues are bound by local heuristics, so anonymizing text primitives is what protects privacy.

import { useState, useEffect } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { detectCandidates, type DetectedPhrase, type PhraseType } from '../../anon/detect';
import { suggestSlug, type MapEntry } from '../../anon/mapping';
import type { EvidenceBundle } from '../../ingest/types';

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
      patch({ anonBundle });
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'launcher_error', title: 'Anonymization failed', context: { step: 3 } });
    } finally {
      setBusy(false);
    }
  }

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
        {state.anonBundle ? <span class="cf-ok">✓ {state.map.length} phrase(s) replaced — real text will never reach the AI. Click Next.</span> : null}
      </div>
    </section>
  );
}
