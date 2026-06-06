// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { Stepper } from './Stepper';
import type { WizardStepId } from './state';

const allValid: Record<WizardStepId, boolean> = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true };

describe('Stepper', () => {
  it('renders all 7 steps; marks the active one and checks completed ones', () => {
    render(<Stepper active={3} validity={allValid} maxReachable={4} onStepClick={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(7);
    expect(screen.getByText('Anonymize').closest('button')!.getAttribute('aria-current')).toBe('step');
    // steps before the active one (valid) show a check
    expect(screen.getByText('Setup').closest('button')!.textContent).toContain('✓');
    expect(screen.getByText('Drop files').closest('button')!.textContent).toContain('✓');
  });

  it('disables not-yet-reachable steps and fires onStepClick for reachable ones', () => {
    const onStepClick = vi.fn();
    render(<Stepper active={2} validity={allValid} maxReachable={3} onStepClick={onStepClick} />);
    expect((screen.getByText('Generate').closest('button') as HTMLButtonElement).disabled).toBe(true); // step 5 > maxReachable 3
    fireEvent.click(screen.getByText('Setup'));
    expect(onStepClick).toHaveBeenCalledWith(1);
  });
});
