// Map per-node dashboard panels onto the role-specific util signals (primary / HA-secondary / DR).
// Monitoring dashboards label panels by NODE, not by role, so we infer the role: explicit role words in
// the label win; otherwise we fall back to load (highest peak = primary) or position. Pure, no LLM.
// Every fallback assignment is recorded in `heuristicLabels` so the caller can flag it (confidence 0.6)
// and the rep can override it at the §8.5 gate (D1).

import { roleTokenOf, type RoleToken } from './heuristics';

export type { RoleToken };

export interface PanelRoleInput {
  panelLabel: string;
  peakPct?: number; // used to rank unlabeled panels (highest load = primary)
}

export interface RoleAssignment {
  roles: Record<string, RoleToken>; // panelLabel -> assigned role
  heuristicLabels: string[]; // labels whose role came from the load/positional fallback (not an explicit token)
}

const ORDER: readonly RoleToken[] = ['primary', 'secondary', 'dr'];

/**
 * Assign a role to each panel. Explicit role tokens in the label are honored (collisions resolved by
 * peak); remaining panels fill the open role slots ranked by peak (or input order when peaks are absent).
 * Panels beyond the three canonical roles spill to 'dr'.
 */
export function assignRoles(panels: PanelRoleInput[]): RoleAssignment {
  const roles: Record<string, RoleToken> = {};
  const heuristicLabels: string[] = [];
  const peakOf = (p: PanelRoleInput): number => (typeof p.peakPct === 'number' ? p.peakPct : -1);

  const explicit: { label: string; token: RoleToken; peak: number }[] = [];
  const pool: { label: string; peak: number }[] = []; // panels still needing a role (unlabeled + demoted)

  for (const p of panels) {
    const token = roleTokenOf(p.panelLabel);
    if (token) explicit.push({ label: p.panelLabel, token, peak: peakOf(p) });
    else pool.push({ label: p.panelLabel, peak: peakOf(p) });
  }

  // Honor explicit tokens; on a collision the highest-peak claimant keeps the role, losers fall to the pool.
  const claimed = new Set<RoleToken>();
  for (const token of ORDER) {
    const claimants = explicit.filter((e) => e.token === token).sort((a, b) => b.peak - a.peak);
    if (claimants.length === 0) continue;
    roles[claimants[0]!.label] = token;
    claimed.add(token);
    for (const loser of claimants.slice(1)) pool.push({ label: loser.label, peak: loser.peak });
  }

  // Fill the open slots: rank the pool by peak when any peaks are known, else keep input order (positional).
  const anyPeak = pool.some((x) => x.peak >= 0);
  const ordered = anyPeak ? [...pool].sort((a, b) => b.peak - a.peak) : pool;
  const openSlots = ORDER.filter((t) => !claimed.has(t));
  ordered.forEach((x, i) => {
    roles[x.label] = openSlots[i] ?? 'dr'; // extra panels beyond the three roles spill to dr
    heuristicLabels.push(x.label);
  });

  return { roles, heuristicLabels };
}
