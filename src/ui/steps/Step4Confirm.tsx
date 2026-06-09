// Step 4 · Confirm — the Data Intake & Sufficiency Report + the confirm-assumptions gate on one
// screen. Runs triage on the ANONYMIZED bundle (the first AI call, on slugged text), shows the
// verdict + per-signal coverage + what's missing, and lets the rep confirm real values or accept
// assumptions. The triage is cached in state and reused by runPipeline (Step 5) — no double-classify.

import { useState, useEffect } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { MONGODB_PROFILE } from '../../profile/mongodb';
import { triage } from '../../classify/triage';
import { buildSufficiencyReport } from '../../classify/sufficiency';
import { buildGateData, applyGateAnswers, type GateAnswer, type GateData, type GateItem } from '../../orchestrate/gate';
import { createLLM, defaultModelFor } from '../../provider';
import type { SufficiencyReport } from '../../classify/sufficiency-types';
import type { SignalValue } from '../../classify/types';

const TIER_LABEL: Record<string, string> = { blocked: 'BLOCKED', 'directional-estimate': 'DIRECTIONAL ESTIMATE', 'engineering-grade': 'ENGINEERING-GRADE' };

function GateRow({ item, onAnswer }: { item: GateItem; onAnswer: (a: GateAnswer | null) => void }) {
  const isUtil = item.signalId.startsWith('util');
  const [val, setVal] = useState('');
  const [avg, setAvg] = useState('');
  const [peak, setPeak] = useState('');

  // On-disk storage is the one signal we treat as a flagged ASSUMPTION when typed at the gate (not a
  // measurement): a value not read from an uploaded artifact must demote the case to a directional
  // estimate, never engineering-grade. File-derived storage is bound upstream and never reaches here.
  const isStorage = item.signalId === 'data.storageSizeGb';
  const emit = (v: SignalValue | null): void =>
    onAnswer(v === null ? null : { signalId: item.signalId, value: v, confirmed: !isStorage });
  const onNum = (raw: string): void => {
    setVal(raw);
    const n = Number(raw);
    emit(raw.trim() === '' || Number.isNaN(n) ? null : n);
  };
  const onUtil = (a: string, p: string): void => {
    setAvg(a);
    setPeak(p);
    const an = Number(a);
    const pn = Number(p);
    emit(a.trim() === '' || p.trim() === '' || Number.isNaN(an) || Number.isNaN(pn) ? null : { avgPct: an / 100, peakPct: pn / 100 });
  };

  return (
    <div class="cf-gate">
      <div class="cf-gate-head">
        <b>{item.label}</b> <span class="cf-badge">{item.currentStatus}</span> <span class="cf-muted">conf {item.effectiveConfidence.toFixed(2)}</span>
      </div>
      <div class="cf-muted">{item.collectRequest}</div>
      <div class="cf-gate-input">
        {isUtil ? (
          <>
            <input type="number" aria-label={`${item.label} avg %`} placeholder="avg %" value={avg} onInput={(e) => onUtil(e.currentTarget.value, peak)} />
            <input type="number" aria-label={`${item.label} peak %`} placeholder="peak %" value={peak} onInput={(e) => onUtil(avg, e.currentTarget.value)} />
          </>
        ) : (
          <input type="number" aria-label={`${item.label} value`} data-testid={`gate-input-${item.signalId}`} placeholder="value" value={val} onInput={(e) => onNum(e.currentTarget.value)} />
        )}
        <span class="cf-hint">{isStorage ? 'Enter your best on-disk size estimate — the case will be rated Directional, not Engineering-Grade, until a measured value from a file replaces it.' : 'Enter the measured value to confirm it.'}</span>
      </div>
    </div>
  );
}

export function Step4Confirm() {
  const { state, patch, getApiKey } = useWizard();
  const { capture } = useErrors();
  const [report, setReport] = useState<SufficiencyReport | null>(null);
  const [gate, setGate] = useState<GateData | null>(null);
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
        const suff = buildSufficiencyReport(tri, bundle.files, MONGODB_PROFILE);
        setReport(suff);
        setGate(buildGateData(suff, MONGODB_PROFILE));
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

  const setAnswer = (id: string, a: GateAnswer | null): void =>
    setAnswers((prev) => {
      const next = { ...prev };
      if (a) next[id] = a;
      else delete next[id];
      return next;
    });

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

  if (loading) return <section class="cf-card"><h2>4 · Confirm</h2><p class="cf-hint">Classifying the anonymized evidence…</p></section>;

  return (
    <section class="cf-card">
      <h2>4 · Confirm</h2>
      {error ? <p class="cf-error">Classification failed: {error}</p> : null}
      {report ? (
        <>
          <div class={`cf-verdict ${report.verdict.tier}`}>
            <span class="cf-vbadge">{TIER_LABEL[report.verdict.tier] ?? report.verdict.tier}</span>
            <span>{report.verdict.headline}</span>
          </div>

          {state.triage?.roleWarning ? <p class="cf-hint">⚠ {state.triage.roleWarning}</p> : null}

          <p class="cf-label" style="margin-top:14px">Evidence coverage · {report.verdict.requiredTotal} required signals</p>
          <table class="cf-maptable">
            <tbody>
              {report.coverage.filter((c) => c.criticality === 'required').map((c) => (
                <tr key={c.signalId}>
                  <td>{c.label}</td>
                  <td><code class="cf-slug">{c.value === null ? '—' : typeof c.value === 'object' ? `${Math.round(c.value.avgPct * 100)}/${Math.round(c.value.peakPct * 100)}%` : String(c.value)}</code></td>
                  <td><span class={`cf-badge ${c.status === 'satisfied' ? 'host' : c.status === 'missing' ? 'org' : ''}`}>{c.method ?? c.status} · {c.effectiveConfidence.toFixed(2)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>

          {gate && gate.items.length > 0 ? (
            <>
              <p class="cf-label" style="margin-top:14px">Confirm to continue / upgrade</p>
              {gate.items.map((it) => (
                <GateRow key={it.signalId} item={it} onAnswer={(a) => setAnswer(it.signalId, a)} />
              ))}
            </>
          ) : (
            <p class="cf-ok">All required signals are covered.</p>
          )}

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
        </>
      ) : null}
    </section>
  );
}
