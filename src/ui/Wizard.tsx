// The wizard shell: stepper rail + the active step's content + Back/Next nav. All seven step
// components are wired; navigation + gating are driven by the pure stepValidity logic.

import { useWizard } from './WizardContext';
import { Stepper } from './Stepper';
import { maxReachableStep, type WizardStepId } from './state';
import { Step1Setup } from './steps/Step1Setup';
import { Step2DropFiles } from './steps/Step2DropFiles';
import { Step3Anonymize } from './steps/Step3Anonymize';
import { Step4Confirm } from './steps/Step4Confirm';
import { Step5Generate } from './steps/Step5Generate';
import { Step6Refine } from './steps/Step6Refine';
import { Step7Export } from './steps/Step7Export';

function StepContent({ step }: { step: WizardStepId }) {
  switch (step) {
    case 1:
      return <Step1Setup />;
    case 2:
      return <Step2DropFiles />;
    case 3:
      return <Step3Anonymize />;
    case 4:
      return <Step4Confirm />;
    case 5:
      return <Step5Generate />;
    case 6:
      return <Step6Refine />;
    case 7:
      return <Step7Export />;
    default:
      return null;
  }
}

export function Wizard() {
  const { state, validity, goTo, next, back } = useWizard();
  const reachable = maxReachableStep(state);
  return (
    <div class="cf-wizard">
      <Stepper active={state.step} validity={validity} maxReachable={reachable} onStepClick={goTo} />
      <div class="cf-wizard-main">
        <StepContent step={state.step} />
        <div class="cf-wizard-nav">
          <button type="button" class="cf-btn ghost" disabled={state.step === 1} onClick={back}>
            ← Back
          </button>
          <button type="button" class="cf-btn" disabled={!validity[state.step] || state.step === 7} onClick={next}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
