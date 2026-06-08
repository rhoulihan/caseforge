import { describe, it, expect } from 'vitest';
import { assignRoles } from './role-assign';

describe('assignRoles', () => {
  it('honors explicit role tokens in panel labels (no heuristic used)', () => {
    const { roles, heuristicIndices } = assignRoles([
      { panelLabel: 'System CPU — primary' },
      { panelLabel: 'System CPU — secondary (analytics)' },
      { panelLabel: 'System CPU — DR region' },
    ]);
    expect(roles).toEqual(['primary', 'secondary', 'dr']);
    expect(heuristicIndices).toEqual([]);
  });

  it('a single unlabeled panel becomes primary (heuristic)', () => {
    const { roles, heuristicIndices } = assignRoles([{ panelLabel: 'node-a' }]);
    expect(roles).toEqual(['primary']);
    expect(heuristicIndices).toEqual([0]);
  });

  it('ranks unlabeled panels by peak load: highest -> primary', () => {
    const { roles, heuristicIndices } = assignRoles([
      { panelLabel: 'node-1', peakPct: 0.3 },
      { panelLabel: 'node-2', peakPct: 0.8 },
      { panelLabel: 'node-3', peakPct: 0.1 },
    ]);
    expect(roles[1]).toBe('primary'); // node-2, highest peak
    expect(roles[0]).toBe('secondary');
    expect(roles[2]).toBe('dr');
    expect([...heuristicIndices].sort()).toEqual([0, 1, 2]);
  });

  it('falls back to positional order when peaks are absent', () => {
    const { roles } = assignRoles([{ panelLabel: 'first' }, { panelLabel: 'second' }, { panelLabel: 'third' }]);
    expect(roles).toEqual(['primary', 'secondary', 'dr']);
  });

  it('resolves a duplicate explicit token by peak; the loser is demoted (heuristic)', () => {
    const { roles, heuristicIndices } = assignRoles([
      { panelLabel: 'primary A', peakPct: 0.5 },
      { panelLabel: 'primary B', peakPct: 0.9 },
    ]);
    expect(roles[1]).toBe('primary'); // B (higher peak) keeps it
    expect(roles[0]).toBe('secondary'); // A demoted into the next open slot
    expect(heuristicIndices).toEqual([0]); // only the demoted one is heuristic
  });

  it('handles two panels with an IDENTICAL label by index — no role-map collapse (regression)', () => {
    // A label-keyed map would overwrite one entry; index-keying keeps both distinct.
    const { roles } = assignRoles([
      { panelLabel: 'System CPU', peakPct: 0.3 },
      { panelLabel: 'System CPU', peakPct: 0.9 },
    ]);
    expect(roles[1]).toBe('primary'); // higher peak
    expect(roles[0]).toBe('secondary');
    expect(roles[0]).not.toBe(roles[1]); // both roles present despite identical labels
  });

  it('assigns extra panels beyond three to dr', () => {
    const { roles } = assignRoles([
      { panelLabel: 'a' },
      { panelLabel: 'b' },
      { panelLabel: 'c' },
      { panelLabel: 'd' },
    ]);
    expect(roles[3]).toBe('dr');
  });

  it('returns an empty assignment for no panels', () => {
    expect(assignRoles([])).toEqual({ roles: [], heuristicIndices: [] });
  });
});
