// The landing screen shown when the app opens: a list of saved business cases (from the launcher's
// archive store) plus "New business case". Opening a case loads + deserializes its .zip locally and
// hands the hydrated state up to App, which mounts the wizard at Step 6 (Refine). Cases are local-only.

import { useCallback, useEffect, useState } from 'preact/hooks';
import { LauncherClient, type ArchiveSummary } from '../launcher/client';
import { deserializeCase } from '../archive/serialize';
import type { WizardState } from './state';

interface Props {
  client?: LauncherClient;
  onNew: () => void;
  onOpen: (initial: Partial<WizardState>) => void;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function HomeScreen({ client = new LauncherClient(), onNew, onOpen }: Props) {
  const [rows, setRows] = useState<ArchiveSummary[] | null>(null); // null = still loading
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await client.listArchives());
      setError('');
    } catch (e) {
      setRows([]); // launcher unreachable / no store yet — show the empty state, not a crash
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function open(caseId: string): Promise<void> {
    setBusyId(caseId);
    setError('');
    try {
      const bytes = await client.loadArchive(caseId);
      const { state } = await deserializeCase(bytes);
      onOpen(state); // App mounts the wizard at Step 6
    } catch (e) {
      setError(`Could not open this case: ${(e as Error).message}`);
      setBusyId('');
    }
  }

  async function remove(caseId: string): Promise<void> {
    setBusyId(caseId);
    setError('');
    try {
      await client.deleteArchive(caseId);
      await refresh();
    } catch (e) {
      setError(`Could not delete this case: ${(e as Error).message}`);
    } finally {
      setBusyId('');
    }
  }

  return (
    <section class="cf-card cf-home">
      <h2>Business cases</h2>
      <p class="cf-sub">Open a saved case to refine it, or start a new one. Cases are stored locally on this machine.</p>

      <button type="button" class="cf-btn" onClick={onNew}>
        + New business case
      </button>

      {error ? <p class="cf-error">{error}</p> : null}

      {rows === null ? (
        <p class="cf-hint">Loading saved cases…</p>
      ) : rows.length === 0 ? (
        <p class="cf-hint">No saved cases yet — start a new one above. (A case is saved automatically when you generate its deliverables.)</p>
      ) : (
        <ul class="cf-caselist">
          {rows.map((r) => (
            <li key={r.caseId} class="cf-caserow">
              <div class="cf-caseinfo">
                <span class="cf-casename">{r.companyName || r.caseId}</span>
                <span class="cf-casemeta">
                  {fmtDate(r.updatedAt)} · {r.status}
                </span>
              </div>
              <div class="cf-caseactions">
                <button type="button" class="cf-btn ghost" disabled={busyId !== ''} onClick={() => void open(r.caseId)}>
                  {busyId === r.caseId ? 'Opening…' : 'Open'}
                </button>
                <button type="button" class="cf-x" aria-label={`Delete ${r.companyName || r.caseId}`} disabled={busyId !== ''} onClick={() => void remove(r.caseId)}>
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
