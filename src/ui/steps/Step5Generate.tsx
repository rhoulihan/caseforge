// Step 5 · Generate — (optionally) research market costs, then run the pipeline with a live cost
// ticker. The engine computes every authoritative number; the AI only researches list prices, reads
// charts, and writes prose. The Step-4 triage is reused (no re-classify); onCheckpoint drives the ticker.

import { useState } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { runPipeline } from '../../orchestrate';
import { researchTcoCosts, sourcesToClaims } from '../../research/tco';
import { createLLM } from '../../provider';
import { buildRunConfig, tcoProfileFromState, DEFAULT_TCO_INPUTS } from '../pipeline';
import { serializeCase, newCaseId } from '../../archive/serialize';
import type { TcoInputs } from '../../engine/types';
import type { ClaimInput } from '../../render/types';
import type { BudgetCheckpoint } from '../../orchestrate/budget';

const MODEL = 'claude-opus-4-8';
const usd = (c: number): string => `$${c.toFixed(2)}`;
const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function Step5Generate() {
  const { state, patch, getApiKey, launcher } = useWizard();
  const { capture, breadcrumb } = useErrors();
  const [tco, setTco] = useState<TcoInputs>(DEFAULT_TCO_INPUTS);
  const [claims, setClaims] = useState<ClaimInput[]>([]);
  const [researched, setResearched] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'research' | 'generate'>('idle');
  const [checkpoints, setCheckpoints] = useState<BudgetCheckpoint[]>([]);
  const [error, setError] = useState('');
  const [saveWarning, setSaveWarning] = useState('');

  const llm = (): ReturnType<typeof createLLM> => createLLM(state.config!.provider, { apiKey: getApiKey() });

  async function research(): Promise<void> {
    if (!state.config) return;
    setBusy('research');
    setError('');
    try {
      const r = await researchTcoCosts(llm(), MODEL, tcoProfileFromState(state));
      setTco(r.inputs);
      setClaims(sourcesToClaims(r));
      setResearched(true);
    } catch (e) {
      setError(`Cost research failed (you can still generate with defaults): ${(e as Error).message}`);
      // Soft failure — surfaced inline; recorded for an optional report, but don't interrupt with the dialog.
      capture(e, { category: 'provider_error', title: 'Cost research failed', context: { step: 5 }, open: false });
    } finally {
      setBusy('idle');
    }
  }

  async function generate(): Promise<void> {
    setBusy('generate');
    setError('');
    setSaveWarning('');
    setCheckpoints([]);
    try {
      const cfg = buildRunConfig({
        state,
        apiKey: getApiKey(),
        tcoInputs: tco,
        claims,
        preparedDate: todayIso(),
        onCheckpoint: (cp) => setCheckpoints((cs) => [...cs, cp]),
      });
      const out = await runPipeline(cfg);
      if (!out.docModel) {
        // Don't replace an existing good result (re-generate) when this run is blocked / produces nothing.
        setError(out.error ?? (out.gate.blocked ? `Blocked: ${out.gate.reasons.join('; ')}` : 'Generation produced no document.'));
        breadcrumb('warn', `generate produced no docModel: ${out.error ?? 'blocked'}`);
        return;
      }
      // Persist the cost inputs (so Refine can recompute) + assign a caseId on first generate; preserve
      // the original creation time across re-saves.
      const now = new Date().toISOString();
      const caseId = state.caseId ?? newCaseId(state.config?.companyName ?? 'case', new Date());
      const createdAt = state.caseCreatedAt ?? now;
      patch({ pipeline: out, tcoInputs: tco, caseId, caseCreatedAt: createdAt });
      // Save the case archive (best-effort — a save failure must NOT lose the just-generated deliverables,
      // but it must be VISIBLE so the rep knows the case wasn't persisted and can export manually).
      try {
        const zipBytes = await serializeCase({ ...state, pipeline: out, tcoInputs: tco, caseId, caseCreatedAt: createdAt }, { caseId, createdAt, updatedAt: now });
        await launcher.saveArchive(caseId, zipBytes);
        setSaveWarning('');
        breadcrumb('info', `case archived as ${caseId}`);
      } catch (e) {
        setSaveWarning(`Deliverables generated, but this case could not be saved (${(e as Error).message}). You can still export it in Step 7.`);
        breadcrumb('warn', `could not save the case archive: ${(e as Error).message}`);
        capture(e, { category: 'launcher_error', title: 'Could not save the case archive', context: { step: 5 }, open: false });
      }
    } catch (e) {
      setError((e as Error).message);
      capture(e, { category: 'provider_error', title: 'Generation failed', context: { step: 5 } });
    } finally {
      setBusy('idle');
    }
  }

  const out = state.pipeline;
  const total = checkpoints.length ? checkpoints[checkpoints.length - 1]!.cumulativeCost : 0;

  return (
    <section class="cf-card">
      <h2>5 · Generate</h2>
      <p class="cf-sub">The engine computes every authoritative number (free, deterministic); the AI only researches list prices, reads charts, and writes prose.</p>

      <div class="cf-anon-actions">
        <button type="button" class="cf-btn ghost" disabled={busy !== 'idle'} onClick={() => void research()}>
          {busy === 'research' ? 'Researching…' : researched ? 'Re-research costs' : 'Research costs (web search)'}
        </button>
        <span class="cf-muted">{researched ? '✓ market-researched costs' : 'using default cost estimates (not researched)'}</span>
      </div>

      <div class="cf-anon-actions">
        <button type="button" class="cf-btn" disabled={busy !== 'idle'} onClick={() => void generate()}>
          {busy === 'generate' ? 'Generating…' : out?.docModel ? 'Re-generate' : 'Generate deliverables →'}
        </button>
      </div>

      {checkpoints.length > 0 ? (
        <div class="cf-ticker">
          <div class="cf-label">Cost ticker</div>
          <ul>
            {checkpoints.map((c, i) => (
              <li key={`${c.stage}-${i}`}>
                {c.skipped ? '·' : '✓'} {c.stage} — {c.skipped ? c.reason ?? 'skipped (free)' : `${c.inputTokens + c.outputTokens} tok · ${usd(c.cost)}`}
              </li>
            ))}
          </ul>
          <div class="cf-ticker-total">
            spent <b>{usd(total)}</b>{state.config ? ` · budget ${state.config.tokenBudget.toLocaleString()} tok` : ''}
          </div>
        </div>
      ) : null}

      {error ? <p class="cf-error">{error}</p> : null}
      {saveWarning ? <p class="cf-error">⚠ {saveWarning}</p> : null}
      {out?.docModel ? (
        <p class="cf-ok">✓ {out.rendered.length} deliverable(s) generated — {out.docModel.sufficiency.verdict.tier}. Click Next to refine.</p>
      ) : null}
    </section>
  );
}
