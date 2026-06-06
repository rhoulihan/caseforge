// Step 6 · Refine — preview the rendered deliverables (tabs) and refine the PROSE only. The output
// HTML already shows real names (the prose context never carried slugs; the renderer uses the real
// company name locally), so no deanonymize pass is needed. Regenerating re-runs generateProse with
// an instruction on the SAME numeric model (figures locked) and re-renders.

import { useState } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { generateProse } from '../../orchestrate/prose';
import { renderBusinessCase, renderSizingBrief, renderTechnicalReview, renderClaimsChecklist } from '../../render';
import { createLLM } from '../../provider';

const TABS = ['Business Case', 'Sizing Brief', 'Technical Review', 'Claims Checklist'];
const CHIPS = ['More concise', 'Executive tone', 'Emphasize DR resilience', 'Add risk framing'];
const MODEL = 'claude-opus-4-8';

export function Step6Refine() {
  const { state, patch, getApiKey } = useWizard();
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

  async function regenerate(): Promise<void> {
    if (!state.config) return;
    setBusy(true);
    setError('');
    try {
      const llm = createLLM(state.config.provider, { apiKey: getApiKey() });
      const { prose } = await generateProse(docModel, llm, MODEL, instr.trim() || undefined);
      const dm = { ...docModel, prose };
      const rendered = [renderBusinessCase(dm), renderSizingBrief(dm), renderTechnicalReview(dm), renderClaimsChecklist(dm)];
      patch({ pipeline: { ...out!, docModel: dm, rendered } }); // out is non-null here (guarded above; button only renders with a docModel)
      setInstr('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="cf-card">
      <h2>6 · Refine</h2>
      <p class="cf-sub">Preview the deliverables (real names shown locally). Numbers are locked — refining changes wording only.</p>

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
        <div class="cf-label">Refine the narrative (wording only)</div>
        <div class="cf-chips">
          {CHIPS.map((c) => (
            <button key={c} type="button" class="cf-chip" onClick={() => setInstr(c)}>
              {c}
            </button>
          ))}
        </div>
        <textarea aria-label="Refine instruction" class="cf-ta" value={instr} placeholder="e.g. tighten the exec summary, emphasize DR resilience" onInput={(e) => setInstr(e.currentTarget.value)} />
        <button type="button" class="cf-btn" disabled={busy} onClick={() => void regenerate()}>
          {busy ? 'Regenerating…' : 'Regenerate prose'}
        </button>
        {error ? <p class="cf-error">{error}</p> : null}
      </div>
    </section>
  );
}
