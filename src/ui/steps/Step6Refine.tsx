// Step 6 · Refine — preview the rendered deliverables (tabs) and regenerate. Regenerate is NOT
// wording-only: it re-runs the deterministic engine (sizing + TCO) with the CURRENT config/rates and
// the CURRENT customer discount, reusing the cached triage (no re-classify), then rewrites prose with
// the refine instruction. So changing the discount — or reopening an old case after rates changed —
// refreshes the numbers. The output HTML shows real names locally (prose context never carried slugs).

import { useState } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { Spinner } from '../Spinner';
import { runPipeline } from '../../orchestrate';
import { buildRunConfig, DEFAULT_TCO_INPUTS } from '../pipeline';
import { persistCase } from '../../archive/persist';
import { prepareRefineInstruction } from '../refine';
import type { ArchiveVersion } from '../state';

const TABS = ['Business Case', 'Sizing Brief', 'Technical Review', 'Claims Checklist'];
const CHIPS = ['More concise', 'Executive tone', 'Emphasize DR resilience', 'Add risk framing'];

export function Step6Refine() {
  const { state, patch, goTo, getApiKey, setApiKey, launcher } = useWizard();
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
  // A case opened from an archive has no API key (session-only) — refine needs one; setApiKey flips this.
  const needsKey = !state.hasApiKey;

  async function regenerate(): Promise<void> {
    if (!state.config) return;
    // A normal in-place refine means any pending add-files detour was abandoned — clear it so a later
    // Step 5 generate isn't mislabeled 'add-files' or re-applies a stale carried note.
    if (state.addFilesMode || state.pendingRefinement) patch({ addFilesMode: false, pendingRefinement: undefined });
    setBusy(true);
    setError('');
    try {
      const raw = instr.trim();
      // Prepare the instruction (fail-closed): block names not in the map, slug-anonymize, replay history.
      const prepared = await prepareRefineInstruction(raw, state, launcher);
      if ('blocked' in prepared) {
        setError(`Your instruction may contain names not in the anonymization list: ${prepared.blocked.join(', ')}. Add them in Step 3 (Anonymize) or rephrase — otherwise they'd be sent to the AI.`);
        return;
      }
      // Recompute with current settings — reuse the cached triage, apply the current discount, then rewrite prose.
      const cfg = buildRunConfig({
        state,
        apiKey: getApiKey(),
        tcoInputs: state.tcoInputs ?? DEFAULT_TCO_INPUTS,
        claims: docModel.claims,
        preparedDate: docModel.preparedDate,
        proseInstruction: prepared.effective,
      });
      const next = await runPipeline(cfg);
      if (!next.docModel) {
        // A blocked / failed recompute must NOT replace the deliverables the rep already has.
        setError(next.error ?? (next.gate.blocked ? `Blocked: ${next.gate.reasons.join('; ')}` : 'Regeneration produced no document — your current preview is unchanged.'));
        breadcrumb('warn', `refine produced no docModel: ${next.error ?? 'blocked'}`);
        return;
      }
      // Append a new content-package version (never overwrite) + log the refinement, then persist.
      const now = new Date().toISOString();
      const id = String(state.versions.length + 1).padStart(3, '0');
      const version: ArchiveVersion = { id, createdAt: now, trigger: 'refine', discountPct: state.config?.discountPct ?? 0, docModel: next.docModel, rendered: next.rendered };
      const versions = [...state.versions, version];
      const refinementHistory = raw ? [...state.refinementHistory, { ts: now, instruction: raw, slugged: prepared.slugged, versionId: id }] : state.refinementHistory;
      patch({ pipeline: next, versions, refinementHistory });
      setInstr('');
      const saveErr = await persistCase(launcher, { ...state, pipeline: next, versions, refinementHistory });
      if (saveErr) {
        setError(`Refined, but this case could not be saved (${saveErr}). You can still export it in Step 7.`);
        breadcrumb('warn', `could not save the refined case: ${saveErr}`);
        capture(new Error(saveErr), { category: 'launcher_error', title: 'Could not save the refined case', context: { step: 6 }, open: false });
      }
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

  // Carry the typed note into the add-files detour, then return to Step 2 to add evidence.
  const addMoreFiles = (): void => {
    patch({ addFilesMode: true, pendingRefinement: instr.trim() || undefined });
    goTo(2);
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
        {needsKey ? (
          <label class="cf-field">
            <span class="cf-label">API key</span>
            <input type="password" aria-label="API key" placeholder="sk-… (needed to refine this case)" onInput={(e) => setApiKey(e.currentTarget.value)} />
            <span class="cf-hint">This case was opened from an archive — enter your key to regenerate. It stays in this session only.</span>
          </label>
        ) : null}
        <div class="cf-anon-actions">
          <button type="button" class="cf-btn" disabled={busy || needsKey} onClick={() => void regenerate()}>
            {busy ? (<><Spinner />Regenerating…</>) : 'Regenerate'}
          </button>
          <button type="button" class="cf-btn ghost" disabled={busy} onClick={addMoreFiles}>
            + Add more files
          </button>
        </div>
        <span class="cf-hint">“Add more files” keeps this case, returns to Drop files to add evidence (only the new files are anonymized), then re-generates — applying the note above.</span>
        {error ? <p class="cf-error">{error}</p> : null}
      </div>
    </section>
  );
}
