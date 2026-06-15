// Shared preparation of a free-text refine instruction before it reaches the LLM. Used by Step 6
// (Regenerate) and Step 5 (the carried instruction on an add-files generate), so the privacy-critical
// path lives in ONE place: detect-and-block any names not in the approved map (fail-closed — the refine
// box is untrusted free text the literal anonymizer would otherwise pass through), slug-anonymize the
// instruction, and replay prior (already-slugged) refinements for continuity.

import { detectCandidates } from '../anon/detect';
import type { LauncherClient } from '../launcher/client';
import type { WizardState } from './state';

// Shared narrative-tuning quick-chips — consumed by both Step 5 (Generate) and Step 6 (Refine) so the
// first generate AND later refines offer the same one-click tuning. Kept here (not in a step component)
// so the two steps don't depend on each other. Note: avoid Title-Case bigrams (e.g. "DR resilience"),
// which the fail-closed name detector would flag as an unmapped proper noun and block.
export const CHIPS = ['More concise', 'Executive tone', 'Emphasize disaster-recovery resilience', 'Add risk framing'];

export type PreparedInstruction = { blocked: string[] } | { effective?: string; slugged: string };

export async function prepareRefineInstruction(raw: string, state: WizardState, launcher: LauncherClient): Promise<PreparedInstruction> {
  const trimmed = raw.trim();
  if (trimmed) {
    const mapped = new Set(state.map.map((m) => m.phrase.toLowerCase()));
    const unmapped = detectCandidates({ files: [], primitives: [{ kind: 'text', source: 'refine-instruction', text: trimmed }] }, state.config?.companyName ?? '').filter(
      (d) => !mapped.has(d.phrase.toLowerCase()),
    );
    if (unmapped.length > 0) return { blocked: unmapped.map((d) => d.phrase) };
  }
  const slugged = trimmed ? (await launcher.anonymize(state.map, trimmed)).text : '';
  // Replay prior refinements (already slugged) + this one, so wording changes accumulate.
  const effective = [...state.refinementHistory.map((h) => h.slugged), slugged].filter(Boolean).join(' Then: ') || undefined;
  return { effective, slugged };
}
