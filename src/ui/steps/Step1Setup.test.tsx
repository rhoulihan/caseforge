// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Step1Setup } from './Step1Setup';
import { WizardProvider, useWizard } from '../WizardContext';

// Readout exposes step-1 advance-validity + that the key is NOT in serialized state.
function Readout() {
  const { validity, state, getApiKey } = useWizard();
  return (
    <div>
      <span data-testid="valid1">{String(validity[1])}</span>
      <span data-testid="hasKey">{String(state.hasApiKey)}</span>
      <span data-testid="keyInState">{String('apiKey' in (state as unknown as Record<string, unknown>))}</span>
      <span data-testid="sessionKey">{getApiKey()}</span>
    </div>
  );
}

function setup() {
  return render(
    <WizardProvider>
      <Step1Setup />
      <Readout />
    </WizardProvider>,
  );
}

describe('Step1Setup', () => {
  it('is invalid until an API key and company name are entered', () => {
    setup();
    expect(screen.getByTestId('valid1').textContent).toBe('false');
    expect(screen.getByText(/enter an api key/i)).toBeTruthy();

    fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    fireEvent.input(screen.getByLabelText('Company name'), { target: { value: 'Acme Mutual' } });

    expect(screen.getByTestId('valid1').textContent).toBe('true');
    expect(screen.getByText(/ready — click next/i)).toBeTruthy();
  });

  it('keeps the API key in session memory, never in serialized state', () => {
    setup();
    fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'sk-secret' } });
    expect(screen.getByTestId('hasKey').textContent).toBe('true');
    expect(screen.getByTestId('sessionKey').textContent).toBe('sk-secret');
    expect(screen.getByTestId('keyInState').textContent).toBe('false'); // no apiKey field on WizardState
  });

  it('switches provider', () => {
    setup();
    fireEvent.click(screen.getByLabelText('OpenAI'));
    // provider saved into config (radio reflects it)
    expect((screen.getByLabelText('OpenAI') as HTMLInputElement).checked).toBe(true);
  });
});
