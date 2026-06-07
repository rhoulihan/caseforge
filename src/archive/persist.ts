// Best-effort persistence of the current case to its archive. Used by Step 5 (save-on-generate) and
// Step 6 (save-on-refine). Returns an error message on failure so the caller can surface it visibly —
// a save failure must never lose the on-screen deliverables, but it must not be silent either.

import type { LauncherClient } from '../launcher/client';
import type { WizardState } from '../ui/state';
import { serializeCase } from './serialize';

export async function persistCase(launcher: LauncherClient, state: WizardState): Promise<string | null> {
  if (!state.caseId) return 'case has no id';
  const now = new Date().toISOString();
  try {
    const zip = await serializeCase(state, { caseId: state.caseId, createdAt: state.caseCreatedAt ?? now, updatedAt: now });
    await launcher.saveArchive(state.caseId, zip);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
