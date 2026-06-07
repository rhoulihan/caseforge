// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// deserializeCase is exercised by its own round-trip test; here we mock it so the HomeScreen test
// stays about list/open/delete wiring, not the zip format.
const { deserializeCase } = vi.hoisted(() => ({
  deserializeCase: vi.fn(async () => ({ manifest: { caseId: 'acme-1' }, state: { step: 6, config: { companyName: 'Acme' } }, refinementHistory: [] })),
}));
vi.mock('../archive/serialize', () => ({ deserializeCase }));

import { HomeScreen } from './HomeScreen';
import type { LauncherClient, ArchiveSummary } from '../launcher/client';

const ROWS: ArchiveSummary[] = [
  { caseId: 'acme-1', companyName: 'Acme Mutual', provider: 'claude', status: 'generated', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-07T00:00:00Z', currentVersion: '001' },
  { caseId: 'globex-2', companyName: 'Globex', provider: 'openai', status: 'refined', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-20T00:00:00Z', currentVersion: '003' },
];

function mockClient(over: Partial<LauncherClient> = {}): LauncherClient {
  return {
    listArchives: vi.fn(async () => ROWS),
    loadArchive: vi.fn(async () => new Uint8Array([1, 2, 3])),
    deleteArchive: vi.fn(async () => undefined),
    ...over,
  } as unknown as LauncherClient;
}

beforeEach(() => deserializeCase.mockClear());

describe('HomeScreen', () => {
  it('lists saved cases from the launcher', async () => {
    render(<HomeScreen client={mockClient()} onNew={() => {}} onOpen={() => {}} />);
    await screen.findByText('Acme Mutual');
    expect(screen.getByText('Globex')).toBeTruthy();
  });

  it('"New business case" calls onNew', () => {
    const onNew = vi.fn();
    render(<HomeScreen client={mockClient()} onNew={onNew} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /New business case/i }));
    expect(onNew).toHaveBeenCalled();
  });

  it('Open loads + deserializes the case and hands the hydrated state up', async () => {
    const client = mockClient();
    const onOpen = vi.fn();
    render(<HomeScreen client={client} onNew={() => {}} onOpen={onOpen} />);
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getAllByRole('button', { name: /^Open$/i })[0]!);
    await waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(client.loadArchive).toHaveBeenCalledWith('acme-1');
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ step: 6 }); // lands on Refine
  });

  it('Delete removes the case and refreshes the list', async () => {
    const listArchives = vi.fn().mockResolvedValueOnce(ROWS).mockResolvedValueOnce([ROWS[1]]); // acme gone after delete
    const client = mockClient({ listArchives, deleteArchive: vi.fn(async () => undefined) });
    render(<HomeScreen client={client} onNew={() => {}} onOpen={() => {}} />);
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Delete Acme Mutual/i }));
    await waitFor(() => expect(client.deleteArchive).toHaveBeenCalledWith('acme-1'));
    await waitFor(() => expect(screen.queryByText('Acme Mutual')).toBeNull());
    expect(screen.getByText('Globex')).toBeTruthy();
  });

  it('shows an empty state (no crash) when the launcher is unreachable', async () => {
    const client = mockClient({ listArchives: vi.fn(async () => { throw new Error('launcher down'); }) });
    render(<HomeScreen client={client} onNew={() => {}} onOpen={() => {}} />);
    await screen.findByText(/No saved cases yet/i);
    expect(screen.getByText(/launcher down/i)).toBeTruthy();
  });
});
