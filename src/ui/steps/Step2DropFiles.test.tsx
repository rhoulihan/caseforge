// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';

// Mock the lazy-imported parsers so the component test exercises drop handling + state, not pdfjs.
const { ingestAsync } = vi.hoisted(() => {
  const fakeBundle = {
    files: [
      { name: 'sizing.csv', type: 'csv', ok: true },
      // a genuinely unsupported file (docx/pptx now extract; legacy .doc does not)
      { name: 'legacy.doc', type: 'doc', ok: false, note: 'legacy Word (.doc) is not read — please re-save as .docx or export to PDF', errorCategory: 'unsupported_format' },
    ],
    primitives: [{ kind: 'table', source: 'sizing.csv', headers: ['x'], rows: [['1']] }],
  };
  return { ingestAsync: vi.fn(async () => fakeBundle) };
});
vi.mock('../../ingest/ingest', () => ({ ingestAsync }));
vi.mock('../../ingest/binary', () => ({ BINARY_EXTRACTORS: {} }));

import { Step2DropFiles } from './Step2DropFiles';
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import { ErrorReportDialog } from '../modals/ErrorReportDialog';

function Readout() {
  const { state } = useWizard();
  return <span data-testid="prims">{state.bundle ? state.bundle.primitives.length : -1}</span>;
}

describe('Step2DropFiles', () => {
  it('ingests selected files locally, patches the bundle, and shows the per-file report', async () => {
    render(
      <ErrorProvider>
        <WizardProvider>
          <Step2DropFiles />
          <Readout />
        </WizardProvider>
      </ErrorProvider>,
    );
    const file = new File(['x,y\n1,2'], 'sizing.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });

    await waitFor(() => expect(ingestAsync).toHaveBeenCalledTimes(1));
    await screen.findByText(/evidence item\(s\) extracted/i);
    expect(screen.getByText(/sizing\.csv/)).toBeTruthy();
    expect(screen.getByText(/legacy\.doc/)).toBeTruthy(); // unparsed file is still reported (⚠)
    await waitFor(() => expect(screen.getByTestId('prims').textContent).toBe('1')); // bundle patched into state
  });

  it('auto-opens the error-report dialog when a dropped file is skipped/unsupported', async () => {
    render(
      <ErrorProvider>
        <WizardProvider>
          <Step2DropFiles />
          <ErrorReportDialog />
        </WizardProvider>
      </ErrorProvider>,
    );
    const file = new File(['x,y\n1,2'], 'sizing.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
    // The mocked bundle includes notes.docx (ok:false) → the report dialog should appear automatically.
    await screen.findByRole('dialog');
    expect(screen.getByText(/Send an error report/i)).toBeTruthy();
    expect(screen.getAllByText(/unsupported file format/i).length).toBeGreaterThan(0);
  });
});
