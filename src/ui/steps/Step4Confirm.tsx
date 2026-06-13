// Step 4 · Confirm — the Data Intake & Sufficiency Report + the unified editable metrics table on
// one screen. Runs triage on the ANONYMIZED bundle (the first AI call, on slugged text), then shows
// one editable row per required signal (prefilled with the discovered value) plus an expandable
// Additional Metrics section of recommended signals. Any edit becomes a gate answer (Policy B: a
// rep-entered value demotes the verdict to directional — recomputed LIVE as the rep types) and
// reverting an edit restores the discovered binding. The triage is cached in state and reused by
// runPipeline (Step 5) — no double-classify.

import { useState, useEffect, useMemo } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { Spinner } from '../Spinner';
import { MONGODB_PROFILE } from '../../profile/mongodb';
import { triage } from '../../classify/triage';
import { buildSufficiencyReport } from '../../classify/sufficiency';
import { buildMetricsForm, applyGateAnswers, type GateAnswer, type MetricRow } from '../../orchestrate/gate';
import { createLLM, defaultModelFor } from '../../provider';
import type { SufficiencyReport } from '../../classify/sufficiency-types';
import type { SignalValue } from '../../classify/types';

const TIER_LABEL: Record<string, string> = { blocked: 'BLOCKED', 'directional-estimate': 'DIRECTIONAL ESTIMATE', 'engineering-grade': 'ENGINEERING-GRADE' };

/** The discovered-value display: scalar/enum as text, avgPeak as 'avg/peak%', missing as a dash. */
function showValue(v: SignalValue | null): string {
  if (v === null) return '—';
  if (typeof v === 'object') return `${Math.round(v.avgPct * 100)}/${Math.round(v.peakPct * 100)}%`;
  return String(v);
}

type CompressionState = 'compressed' | 'uncompressed';
/** Inline control rendered only on the storage row: marks whether the storage figure is on-disk
 *  (compressed) or logical (uncompressed). The engine divides an uncompressed figure by the Oracle
 *  compression factor, so this changes the effective storage size / cost (not the tier — a recommended
 *  signal) live. */
interface StorageCompression {
  state: CompressionState;
  onChange: (s: CompressionState) => void;
}

function MetricRowView({ row, adjusted, onAnswer, storageCompression }: { row: MetricRow; adjusted: boolean; onAnswer: (a: GateAnswer | null) => void; storageCompression?: StorageCompression }) {
  const discovered = row.value; // the triage-time baseline; stable while the rep edits
  const [val, setVal] = useState(discovered !== null && typeof discovered !== 'object' ? String(discovered) : '');
  const [avg, setAvg] = useState(discovered !== null && typeof discovered === 'object' ? String(Math.round(discovered.avgPct * 100)) : '');
  const [peak, setPeak] = useState(discovered !== null && typeof discovered === 'object' ? String(Math.round(discovered.peakPct * 100)) : '');

  const emit = (v: SignalValue | null): void =>
    onAnswer(v === null ? null : { signalId: row.signalId, value: v });
  const onScalar = (raw: string): void => {
    setVal(raw);
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) return emit(null); // empty/invalid -> the discovered binding stands; every required/recommended scalar in this profile is physically positive (counts, vCPUs, GB)
    emit(typeof discovered === 'number' && n === discovered ? null : n); // retyping the discovered value is a revert too
  };
  const onEnum = (raw: string): void => {
    setVal(raw);
    const t = raw.trim();
    if (t === '') return emit(null);
    emit(typeof discovered === 'string' && t === discovered ? null : t);
  };
  const onUtil = (a: string, p: string): void => {
    setAvg(a);
    setPeak(p);
    const an = Number(a);
    const pn = Number(p);
    if (a.trim() === '' || p.trim() === '' || !Number.isFinite(an) || !Number.isFinite(pn) || an < 0 || pn < 0 || an > 100 || pn > 100 || an > pn) return emit(null);
    // compare against the prefill rendering (Math.round) so retyping the shown avg/peak reverts cleanly
    const same = discovered !== null && typeof discovered === 'object' && Math.round(discovered.avgPct * 100) === an && Math.round(discovered.peakPct * 100) === pn;
    emit(same ? null : { avgPct: an / 100, peakPct: pn / 100 });
  };

  return (
    <div class="cf-metricrow">
      <div class="cf-metric-head">
        <b>{row.label}</b>
        <span class={`cf-badge ${row.status === 'satisfied' ? 'host' : row.status === 'missing' ? 'org' : ''}`}>
          {row.status === 'missing' ? 'missing' : `${row.method ?? row.status} · ${row.effectiveConfidence.toFixed(2)}`}
        </span>
        {adjusted ? <span class="cf-adjusted">adjusted</span> : null}
        <code class="cf-slug">{showValue(discovered)}</code>
      </div>
      {row.status === 'missing' ? <div class="cf-muted">{row.collectRequest}</div> : null}
      <div class="cf-metric-inputs">
        {row.valueKind === 'avgPeak' ? (
          <>
            <input type="number" aria-label={`${row.label} avg %`} data-testid={`metric-input-${row.signalId}-avg`} placeholder="avg %" value={avg} onInput={(e) => onUtil(e.currentTarget.value, peak)} />
            <input type="number" aria-label={`${row.label} peak %`} data-testid={`metric-input-${row.signalId}-peak`} placeholder="peak %" value={peak} onInput={(e) => onUtil(avg, e.currentTarget.value)} />
          </>
        ) : row.valueKind === 'enum' ? (
          <input type="text" aria-label={`${row.label} value`} data-testid={`metric-input-${row.signalId}`} placeholder="value" value={val} onInput={(e) => onEnum(e.currentTarget.value)} />
        ) : (
          <input type="number" aria-label={`${row.label} value`} data-testid={`metric-input-${row.signalId}`} placeholder="value" value={val} onInput={(e) => onScalar(e.currentTarget.value)} />
        )}
        {storageCompression ? (
          <label class="cf-compression">
            <select
              aria-label="Storage figure compression state"
              data-testid="storage-compression-toggle"
              value={storageCompression.state}
              onChange={(e) => storageCompression.onChange(e.currentTarget.value as CompressionState)}
            >
              <option value="uncompressed">Uncompressed (logical)</option>
              <option value="compressed">Compressed (on-disk)</option>
            </select>
          </label>
        ) : null}
        {adjusted && row.status !== 'missing' ? <span class="cf-hint">Adjusted — the estimate becomes Directional.</span> : null}
      </div>
      {storageCompression ? (
        <div class="cf-hint">Uncompressed (logical) figures are divided by the assumed Oracle compression factor; mark compressed if this is the on-disk size.</div>
      ) : null}
    </div>
  );
}

export function Step4Confirm() {
  const { state, patch, getApiKey } = useWizard();
  const { capture } = useErrors();
  const [report, setReport] = useState<SufficiencyReport | null>(null);
  const [answers, setAnswers] = useState<Record<string, GateAnswer>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<string[]>([]);

  useEffect(() => {
    const bundle = state.anonBundle;
    const cfg = state.config;
    if (!bundle || !cfg) return;
    let alive = true;
    setLoading(true);
    setError('');
    const llm = createLLM(cfg.provider, { apiKey: getApiKey() });
    triage(bundle, MONGODB_PROFILE, llm, defaultModelFor(cfg.provider), state.map)
      .then(({ result: tri, usage }) => {
        if (!alive) return;
        setReport(buildSufficiencyReport(tri, bundle.files, MONGODB_PROFILE));
        patch({ triage: tri, classifyUsage: usage });
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        capture(e, { category: 'provider_error', title: 'Classification failed', context: { step: 4 } });
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [state.anonBundle, state.config, getApiKey, patch, capture]);

  // Rows come from the ORIGINAL triage-time report so the discovered baseline + prefill stay
  // stable while the rep edits; only the verdict recomputes live (below).
  const form = useMemo(() => (report ? buildMetricsForm(report, MONGODB_PROFILE) : null), [report]);

  // LIVE verdict: re-apply the current answers on every edit — any rep-entered value demotes the
  // tier to directional (Policy B); deleting/reverting the edit restores the triage-time verdict.
  const live = useMemo(
    () => (state.triage && state.anonBundle ? applyGateAnswers(state.triage, Object.values(answers), state.anonBundle.files, MONGODB_PROFILE) : null),
    [state.triage, state.anonBundle, answers],
  );

  const setAnswer = (id: string, a: GateAnswer | null): void => {
    if (state.confirmed) patch({ confirmed: false }); // a post-confirm edit invalidates the snapshot — force re-confirm
    setAnswers((prev) => {
      const next = { ...prev };
      if (a) next[id] = a;
      else delete next[id];
      return next;
    });
  };

  function confirm(): void {
    if (!state.triage || !state.anonBundle) return;
    const ans = Object.values(answers);
    const applied = applyGateAnswers(state.triage, ans, state.anonBundle.files, MONGODB_PROFILE);
    if (applied.blocked || !applied.inputs) {
      setBlocked(applied.reasons);
      return;
    }
    setBlocked([]);
    patch({ gateAnswers: ans, confirmed: true });
  }

  if (loading) return <section class="cf-card"><h2>4 · Confirm</h2><p class="cf-hint"><Spinner />Classifying the anonymized evidence…</p></section>;

  if (!report || !form) {
    return (
      <section class="cf-card">
        <h2>4 · Confirm</h2>
        {error ? <p class="cf-error">Classification failed: {error}</p> : null}
      </section>
    );
  }

  const verdict = live?.sufficiency.verdict ?? report.verdict;

  // The storage row's inline compression companion. The default-when-unbound is uncompressed (the
  // engine treats unbound and 'uncompressed' identically). Current state = the rep's answer if set,
  // else the discovered binding from triage coverage, else the profile default 'uncompressed'.
  const COMPRESSION_ID = 'data.storageCompressionState';
  const discoveredCompression = report.coverage.find((c) => c.signalId === COMPRESSION_ID)?.value;
  const baseCompression: CompressionState = discoveredCompression === 'compressed' ? 'compressed' : 'uncompressed';
  const answeredCompression = answers[COMPRESSION_ID]?.value;
  const compressionState: CompressionState =
    answeredCompression === 'compressed' ? 'compressed' : answeredCompression === 'uncompressed' ? 'uncompressed' : baseCompression;
  const onCompressionChange = (s: CompressionState): void =>
    // revert to the discovered/default binding when the rep picks the base state, else bind the override
    setAnswer(COMPRESSION_ID, s === baseCompression ? null : { signalId: COMPRESSION_ID, value: s });

  return (
    <section class="cf-card">
      <h2>4 · Confirm</h2>
      {error ? <p class="cf-error">Classification failed: {error}</p> : null}

      <div class={`cf-verdict ${verdict.tier}`}>
        <span class="cf-vbadge">{TIER_LABEL[verdict.tier] ?? verdict.tier}</span>
        <span>{verdict.headline}</span>
      </div>

      {state.triage?.roleWarning ? <p class="cf-hint">⚠ {state.triage.roleWarning}</p> : null}

      <p class="cf-label" style="margin-top:14px">Metrics · {form.required.length} required signals</p>
      <p class="cf-hint">Values were read from your files. You can adjust any value — a rep-entered value makes the estimate Directional.</p>
      {form.required.map((r) => (
        <MetricRowView
          key={r.signalId}
          row={r}
          adjusted={r.signalId in answers}
          onAnswer={(a) => setAnswer(r.signalId, a)}
          storageCompression={r.signalId === 'data.storageSizeGb' ? { state: compressionState, onChange: onCompressionChange } : undefined}
        />
      ))}

      <details class="cf-additional-metrics">
        <summary>Additional Metrics ({form.additional.length})</summary>
        {form.additional.map((r) => (
          <MetricRowView key={r.signalId} row={r} adjusted={r.signalId in answers} onAnswer={(a) => setAnswer(r.signalId, a)} />
        ))}
      </details>

      {blocked.length > 0 ? (
        <div class="cf-error">
          Still blocked — provide a real value for: {blocked.join(', ')}
        </div>
      ) : null}

      <div class="cf-anon-actions">
        <button type="button" class="cf-btn" onClick={confirm}>
          Confirm &amp; continue →
        </button>
        {state.confirmed ? <span class="cf-ok">✓ confirmed — click Next to generate</span> : null}
      </div>
    </section>
  );
}
