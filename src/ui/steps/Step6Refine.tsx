// Step 6 · Refine — preview the rendered deliverables (tabs) and regenerate. Regenerate is NOT
// wording-only: it re-runs the deterministic engine (sizing + TCO) with the CURRENT config/rates and
// the CURRENT customer discount, reusing the cached triage (no re-classify), then rewrites prose with
// the refine instruction. So changing the discount — or reopening an old case after rates changed —
// refreshes the numbers. The output HTML shows real names locally (prose context never carried slugs).

import { useState } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { runPipeline } from '../../orchestrate';
import { buildRunConfig, DEFAULT_TCO_INPUTS } from '../pipeline';

const TABS = ['Business Case', 'Sizing Brief', 'Technical Review', 'Claims Checklist'];
const CHIPS = ['More concise', 'Executive tone', 'Emphasize DR resilience', 'Add risk framing'];

export function Step6Refine() {
  const { state, patch, getApiKey } = useWizard();
  const { capture, breadcrumb } = useErrors();
  const [active, setActive] = useState(0);
  const [instr, setInstr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const out = state.pipeline;
  if (!out?.docModel) {
    return (
      <section class="cf-card">
        <h2>6 · Refine</h2>
        <p class="cf-hint">Generate the deliverables in Step 5 first.</p>
      </section>
    );
  }
  const docModel = out.docModel;
  const discountPct = state.config?.discountPct ?? 0;

  async function regenerate(): Promise<void> {
    if (!state.config) return;
    setBusy(true);
    setError('');
    try {
      // Recompute with current settings — reuse the cached triage, apply the current discount, then rewrite prose.
      const cfg = buildRunConfig({
        state,
        apiKey: getApiKey(),
        tcoInputs: state.tcoInputs ?? DEFAULT_TCO_INPUTS,
        claims: docModel.claims,
        preparedDate: docModel.preparedDate,
        proseInstruction: instr.trim() || undefined,
      });
      const next = await runPipeline(cfg);
      if (!next.docModel) {
        // A blocked / failed recompute must NOT replace the deliverables the rep already has.
        setError(next.error ?? (next.gate.blocked ? `Blocked: ${next.gate.reasons.join('; ')}` : 'Regeneration produced no document — your current preview is unchanged.'));
        breadcrumb('warn', `refine produced no docModel: ${next.error ?? 'blocked'}`);
        return;
      }
      patch({ pipeline: next });
      setInstr('');
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'provider_error', title: 'Refine failed', context: { step: 6 } });
    } finally {
      setBusy(false);
    }
  }

  const setDiscount = (pct: number): void => {
    if (!state.config) return;
    patch({ config: { ...state.config, discountPct: Math.max(0, Math.min(100, pct || 0)) } });
  };

  return (
    <section class="cf-card">
      <h2>6 · Refine</h2>
      <p class="cf-sub">Preview the deliverables (real names shown locally). Regenerating re-applies the current pricing, sizing config, and discount, then rewrites the narrative.</p>

      <div class="cf-tabs" role="tablist">
        {TABS.map((label, i) => (
          <button key={label} type="button" role="tab" aria-selected={active === i} class={`cf-tab ${active === i ? 'on' : ''}`} onClick={() => setActive(i)}>
            {label}
          </button>
        ))}
      </div>

      {/* Trusted renderer output (prose is escaped at render time) — safe to inject. */}
      <div class="cf-docpreview" data-testid="docpreview" dangerouslySetInnerHTML={{ __html: out.rendered[active]?.html ?? '' }} />

      <div class="cf-refine">
        <label class="cf-field">
          <span class="cf-label">Customer discount (%)</span>
          <input
            type="number"
            aria-label="Customer discount percent"
            value={discountPct}
            min={0}
            max={100}
            step={1}
            onInput={(e) => setDiscount(Number(e.currentTarget.value))}
          />
          <span class="cf-hint">Off the proposed Oracle solution (ADB + migration + DR). Regenerate to apply.</span>
        </label>

        <div class="cf-label">Refine the narrative</div>
        <div class="cf-chips">
          {CHIPS.map((c) => (
            <button key={c} type="button" class="cf-chip" onClick={() => setInstr(c)}>
              {c}
            </button>
          ))}
        </div>
        <textarea aria-label="Refine instruction" class="cf-ta" value={instr} placeholder="e.g. tighten the exec summary, emphasize DR resilience" onInput={(e) => setInstr(e.currentTarget.value)} />
        <button type="button" class="cf-btn" disabled={busy} onClick={() => void regenerate()}>
          {busy ? 'Regenerating…' : 'Regenerate'}
        </button>
        {error ? <p class="cf-error">{error}</p> : null}
      </div>
    </section>
  );
}
