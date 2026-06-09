// Step 5 · Generate — (optionally) research market costs, then run the pipeline with a live cost
// ticker. The engine computes every authoritative number; the AI only researches list prices, reads
// charts, and writes prose. The Step-4 triage is reused (no re-classify); onCheckpoint drives the ticker.

import { useState } from 'preact/hooks';
import { useWizard } from '../WizardContext';
import { useErrors } from '../ErrorContext';
import { runPipeline } from '../../orchestrate';
import { researchTcoCosts, sourcesToClaims } from '../../research/tco';
import { createLLM, defaultModelFor } from '../../provider';
import { buildRunConfig, tcoProfileFromState, DEFAULT_TCO_INPUTS } from '../pipeline';
import { newCaseId } from '../../archive/serialize';
import { persistCase } from '../../archive/persist';
import { prepareRefineInstruction } from '../refine';
import type { ArchiveVersion } from '../state';
import type { TcoInputs } from '../../engine/types';
import type { ClaimInput } from '../../render/types';
import type { BudgetCheckpoint } from '../../orchestrate/budget';

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
      const r = await researchTcoCosts(llm(), defaultModelFor(state.config.provider), tcoProfileFromState(state));
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
      // On an add-files generate, apply the instruction the rep carried from Step 6 — anonymized + replayed
      // (fail-closed: if it names someone not in the map, block and point them back to Step 3).
      const addingFiles = !!state.addFilesMode;
      let proseInstruction: string | undefined;
      let pendingSlugged = '';
      if (addingFiles) {
        // ALWAYS prepare on add-files (even with no new note) so prior refinements still REPLAY — otherwise
        // the regenerated deliverables would silently lose the accumulated wording.
        const prepared = await prepareRefineInstruction(state.pendingRefinement ?? '', state, launcher);
        if ('blocked' in prepared) {
          setError(`Your earlier note names ${prepared.blocked.join(', ')} — add them in Step 3 (Anonymize), or go back to Step 6 to edit the note, before generating.`);
          return;
        }
        proseInstruction = prepared.effective; // replays prior refinements + the carried note (if any)
        pendingSlugged = prepared.slugged;
      }
      const cfg = buildRunConfig({
        state,
        apiKey: getApiKey(),
        tcoInputs: tco,
        claims,
        preparedDate: todayIso(),
        proseInstruction,
        onCheckpoint: (cp) => setCheckpoints((cs) => [...cs, cp]),
      });
      const out = await runPipeline(cfg);
      if (!out.docModel) {
        // Don't replace an existing good result (re-generate) when this run is blocked / produces nothing.
        setError(out.error ?? (out.gate.blocked ? `Blocked: ${out.gate.reasons.join('; ')}` : 'Generation produced no document.'));
        breadcrumb('warn', `generate produced no docModel: ${out.error ?? 'blocked'}`);
        return;
      }
      // Assign a caseId on first generate; preserve the original creation time across re-saves.
      const now = new Date().toISOString();
      const caseId = state.caseId ?? newCaseId(state.config?.companyName ?? 'case', new Date());
      const createdAt = state.caseCreatedAt ?? now;
      // APPEND a new content-package version — never reset (a re-generate must not delete prior versions
      // or the refinement log, per the archive's "never delete on regen" rule).
      const id = String((state.versions?.length ?? 0) + 1).padStart(3, '0');
      const version: ArchiveVersion = { id, createdAt: now, trigger: addingFiles ? 'add-files' : 'initial', discountPct: state.config?.discountPct ?? 0, docModel: out.docModel, rendered: out.rendered };
      const versions = [...(state.versions ?? []), version];
      // Log the carried instruction (if any) against the version it produced.
      const refinementHistory = addingFiles && state.pendingRefinement?.trim() ? [...state.refinementHistory, { ts: now, instruction: state.pendingRefinement.trim(), slugged: pendingSlugged, versionId: id }] : state.refinementHistory;
      const cleared = { addFilesMode: false, pendingRefinement: undefined };
      const nextState = { ...state, pipeline: out, tcoInputs: tco, caseId, caseCreatedAt: createdAt, versions, refinementHistory, ...cleared };
      patch({ pipeline: out, tcoInputs: tco, caseId, caseCreatedAt: createdAt, versions, refinementHistory, ...cleared });
      // Save (best-effort — a save failure must NOT lose the deliverables, but must be VISIBLE).
      const err = await persistCase(launcher, nextState);
      if (err) {
        setSaveWarning(`Deliverables generated, but this case could not be saved (${err}). You can still export it in Step 7.`);
        breadcrumb('warn', `could not save the case archive: ${err}`);
        capture(new Error(err), { category: 'launcher_error', title: 'Could not save the case archive', context: { step: 5 }, open: false });
      } else {
        setSaveWarning('');
        breadcrumb('info', `case archived as ${caseId}`);
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
