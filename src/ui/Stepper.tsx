// The left vertical stepper rail. Pure presentational: completed steps show a check, the active
// step is highlighted, and not-yet-reachable steps are disabled.

import { STEPS, type WizardStepId } from './state';

export interface StepperProps {
  active: WizardStepId;
  validity: Record<WizardStepId, boolean>;
  maxReachable: WizardStepId;
  onStepClick: (step: WizardStepId) => void;
}

export function Stepper({ active, validity, maxReachable, onStepClick }: StepperProps) {
  return (
    <nav class="cf-stepper" aria-label="Wizard steps">
      <ol>
        {STEPS.map(({ id, title }) => {
          const isActive = id === active;
          const done = id < active && validity[id];
          const reachable = id <= maxReachable;
          const cls = ['cf-step', isActive && 'on', done && 'done', !reachable && 'locked'].filter(Boolean).join(' ');
          return (
            <li key={id}>
              <button
                type="button"
                class={cls}
                disabled={!reachable}
                aria-current={isActive ? 'step' : undefined}
                onClick={() => onStepClick(id)}
              >
                <span class="cf-step-num">{done ? '✓' : id}</span>
                <span class="cf-step-title">{title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
