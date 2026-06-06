// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Step7Export } from './Step7Export';
import { WizardProvider } from '../WizardContext';
import type { DocModel } from '../../render/types';
import type { PipelineOutput } from '../../orchestrate';

const pipeline = {
  docModel: { companyName: 'Acme' } as unknown as DocModel,
  rendered: [
    { filename: 'business-case.html', html: '<h1>BC</h1>' },
    { filename: 'sizing-brief.html', html: '<h1>SB</h1>' },
  ],
  usage: { inputTokens: 0, outputTokens: 0 },
  budgetLog: [],
  gate: { items: [], blocked: false, reasons: [] },
} as unknown as PipelineOutput;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('Step7Export', () => {
  it('offers per-doc, combined, and JSON downloads, and triggers a blob download on click', () => {
    render(
      <WizardProvider initial={{ pipeline }}>
        <Step7Export />
      </WizardProvider>,
    );
    expect(screen.getByText(/business-case\.html/)).toBeTruthy();
    expect(screen.getByText(/All deliverables/i)).toBeTruthy();
    expect(screen.getByText(/Data \(JSON\)/i)).toBeTruthy();

    fireEvent.click(screen.getByText(/Data \(JSON\)/i));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/json');
  });
});
