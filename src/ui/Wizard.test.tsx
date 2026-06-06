// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Wizard } from './Wizard';
import { WizardProvider, useWizard } from './WizardContext';
import { ErrorProvider } from './ErrorContext';

// Harness exposing a control to satisfy Step 1 (config + api key) so we can test forward navigation.
function Harness() {
  const w = useWizard();
  return (
    <div>
      <button
        data-testid="satisfy-setup"
        onClick={() => {
          w.setApiKey('sk-test');
          w.patch({ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000 } });
        }}
      >
        satisfy
      </button>
      <Wizard />
    </div>
  );
}

function renderWizard() {
  return render(
    <ErrorProvider>
      <WizardProvider>
        <Harness />
      </WizardProvider>
    </ErrorProvider>,
  );
}

describe('Wizard shell', () => {
  it('starts on Step 1 with Back disabled and Next disabled (setup incomplete)', () => {
    renderWizard();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('1 · Setup');
    expect((screen.getByText('← Back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Next →') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Next once Step 1 is satisfied and advances to Step 2', () => {
    renderWizard();
    fireEvent.click(screen.getByTestId('satisfy-setup'));
    const next = screen.getByText('Next →') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2 · Drop files');
    expect((screen.getByText('← Back') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not advance past an invalid step (Step 2 has no bundle)', () => {
    renderWizard();
    fireEvent.click(screen.getByTestId('satisfy-setup'));
    fireEvent.click(screen.getByText('Next →')); // -> step 2
    expect((screen.getByText('Next →') as HTMLButtonElement).disabled).toBe(true); // step 2 invalid (no files)
  });
});
