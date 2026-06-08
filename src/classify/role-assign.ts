// Map per-node dashboard panels onto the role-specific util signals (primary / HA-secondary / DR).
// Monitoring dashboards label panels by NODE, not by role, so we infer the role: explicit role words in
// the label win; otherwise we fall back to load (highest peak = primary) or position. Pure, no LLM.
// Roles are returned PARALLEL TO THE INPUT (by index, never keyed by the label string — two panels can
// share a label). Every fallback assignment is recorded in `heuristicIndices` so the caller can flag it
// (confidence 0.6) and the rep can override it at the §8.5 gate (D1).

import { roleTokenOf, type RoleToken } from './heuristics';

export type { RoleToken };

export interface PanelRoleInput {
  panelLabel: string;
  peakPct?: number; // used to rank unlabeled panels (highest load = primary)
}

export interface RoleAssignment {
  roles: RoleToken[]; // roles[i] is the role assigned to panels[i]
  heuristicIndices: number[]; // indices whose role came from the load/positional fallback (not an explicit token)
}

const ORDER: readonly RoleToken[] = ['primary', 'secondary', 'dr'];

/**
 * Assign a role to each panel (by index). Explicit role tokens in the label are honored (collisions
 * resolved by peak); remaining panels fill the open role slots ranked by peak (or input order when peaks
 * are absent). Panels beyond the three canonical roles spill to 'dr'. Indexing (not label-keying) keeps
 * the assignment unambiguous even when panels share an identical label.
 */
export function assignRoles(panels: PanelRoleInput[]): RoleAssignment {
  const roles: RoleToken[] = new Array(panels.length);
  const heuristicIndices: number[] = [];
  const peakOf = (p: PanelRoleInput): number => (typeof p.peakPct === 'number' ? p.peakPct : -1);

  const explicit: { idx: number; token: RoleToken; peak: number }[] = [];
  const pool: { idx: number; peak: number }[] = []; // panels still needing a role (unlabeled + demoted)

  panels.forEach((p, idx) => {
    const token = roleTokenOf(p.panelLabel);
    if (token) explicit.push({ idx, token, peak: peakOf(p) });
    else pool.push({ idx, peak: peakOf(p) });
  });

  // Honor explicit tokens; on a collision the highest-peak claimant keeps the role, losers fall to the pool.
  const claimed = new Set<RoleToken>();
  for (const token of ORDER) {
    const claimants = explicit.filter((e) => e.token === token).sort((a, b) => b.peak - a.peak);
    if (claimants.length === 0) continue;
    roles[claimants[0]!.idx] = token;
    claimed.add(token);
    for (const loser of claimants.slice(1)) pool.push({ idx: loser.idx, peak: loser.peak });
  }

  // Fill the open slots: rank the pool by peak when any peaks are known, else by input order (positional).
  const anyPeak = pool.some((x) => x.peak >= 0);
  const ordered = anyPeak ? [...pool].sort((a, b) => b.peak - a.peak) : [...pool].sort((a, b) => a.idx - b.idx);
  const openSlots = ORDER.filter((t) => !claimed.has(t));
  ordered.forEach((x, i) => {
    roles[x.idx] = openSlots[i] ?? 'dr'; // extra panels beyond the three roles spill to dr
    heuristicIndices.push(x.idx);
  });

  return { roles, heuristicIndices };
}
