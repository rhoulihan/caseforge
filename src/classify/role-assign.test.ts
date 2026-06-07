import { describe, it, expect } from 'vitest';
import { assignRoles } from './role-assign';

describe('assignRoles', () => {
  it('honors explicit role tokens in panel labels (no heuristic used)', () => {
    const { roles, heuristicLabels } = assignRoles([
      { panelLabel: 'System CPU — primary' },
      { panelLabel: 'System CPU — secondary (analytics)' },
      { panelLabel: 'System CPU — DR region' },
    ]);
    expect(roles['System CPU — primary']).toBe('primary');
    expect(roles['System CPU — secondary (analytics)']).toBe('secondary');
    expect(roles['System CPU — DR region']).toBe('dr');
    expect(heuristicLabels).toEqual([]);
  });

  it('a single unlabeled panel becomes primary (heuristic)', () => {
    const { roles, heuristicLabels } = assignRoles([{ panelLabel: 'node-a' }]);
    expect(roles['node-a']).toBe('primary');
    expect(heuristicLabels).toEqual(['node-a']);
  });

  it('ranks unlabeled panels by peak load: highest -> primary', () => {
    const { roles, heuristicLabels } = assignRoles([
      { panelLabel: 'node-1', peakPct: 0.3 },
      { panelLabel: 'node-2', peakPct: 0.8 },
      { panelLabel: 'node-3', peakPct: 0.1 },
    ]);
    expect(roles['node-2']).toBe('primary');
    expect(roles['node-1']).toBe('secondary');
    expect(roles['node-3']).toBe('dr');
    expect([...heuristicLabels].sort()).toEqual(['node-1', 'node-2', 'node-3']);
  });

  it('falls back to positional order when peaks are absent', () => {
    const { roles } = assignRoles([{ panelLabel: 'first' }, { panelLabel: 'second' }, { panelLabel: 'third' }]);
    expect(roles['first']).toBe('primary');
    expect(roles['second']).toBe('secondary');
    expect(roles['third']).toBe('dr');
  });

  it('resolves a duplicate explicit token by peak; the loser is demoted (heuristic)', () => {
    const { roles, heuristicLabels } = assignRoles([
      { panelLabel: 'primary A', peakPct: 0.5 },
      { panelLabel: 'primary B', peakPct: 0.9 },
    ]);
    expect(roles['primary B']).toBe('primary'); // higher peak keeps it
    expect(roles['primary A']).toBe('secondary'); // demoted into the next open slot
    expect(heuristicLabels).toEqual(['primary A']); // only the demoted one is heuristic
  });

  it('assigns extra panels beyond three to dr', () => {
    const { roles } = assignRoles([
      { panelLabel: 'a' },
      { panelLabel: 'b' },
      { panelLabel: 'c' },
      { panelLabel: 'd' },
    ]);
    expect(roles['d']).toBe('dr');
  });

  it('returns an empty assignment for no panels', () => {
    expect(assignRoles([])).toEqual({ roles: {}, heuristicLabels: [] });
  });
});
