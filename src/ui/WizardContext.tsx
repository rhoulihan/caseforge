// Wizard store: holds WizardState and exposes patch + navigation, gated by the pure stepValidity /
// maxReachableStep logic. Step components read/write via useWizard(). The API key is held in this
// module's session memory (sessionApiKey), never in the persisted/serializable state.

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useState, useCallback, useMemo } from 'preact/hooks';
import { initialWizardState, stepValidity, maxReachableStep, type WizardState, type WizardStepId } from './state';
import { LauncherClient } from '../launcher/client';

export interface WizardStore {
  state: WizardState;
  patch(p: Partial<WizardState>): void;
  goTo(step: WizardStepId): void;
  next(): void;
  back(): void;
  validity: Record<WizardStepId, boolean>;
  /** Session-only API key (never persisted); setting it flips state.hasApiKey. */
  setApiKey(key: string): void;
  getApiKey(): string;
  /** Browser client for the launcher anonymize/deanonymize/health endpoints. */
  launcher: LauncherClient;
}

// Module-scoped session memory — cleared when the page unloads; never serialized into WizardState.
let sessionApiKey = '';

const WizardCtx = createContext<WizardStore | null>(null);

export function WizardProvider({
  children,
  launcher,
  initial,
}: {
  children: ComponentChildren;
  launcher?: LauncherClient;
  initial?: Partial<WizardState>;
}) {
  const [state, setState] = useState<WizardState>(() => ({ ...initialWizardState(), ...initial }));
  const client = useMemo(() => launcher ?? new LauncherClient(), [launcher]);
  const patch = useCallback((p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })), []);
  const goTo = useCallback((step: WizardStepId) => setState((s) => (step <= maxReachableStep(s) ? { ...s, step } : s)), []);
  const next = useCallback(
    () => setState((s) => (stepValidity(s)[s.step] && s.step < 7 ? { ...s, step: (s.step + 1) as WizardStepId } : s)),
    [],
  );
  const back = useCallback(() => setState((s) => (s.step > 1 ? { ...s, step: (s.step - 1) as WizardStepId } : s)), []);
  const setApiKey = useCallback((key: string) => {
    sessionApiKey = key;
    setState((s) => ({ ...s, hasApiKey: key.trim().length > 0 }));
  }, []);
  const getApiKey = useCallback(() => sessionApiKey, []);
  const validity = useMemo(() => stepValidity(state), [state]);

  return <WizardCtx.Provider value={{ state, patch, goTo, next, back, validity, setApiKey, getApiKey, launcher: client }}>{children}</WizardCtx.Provider>;
}

export function useWizard(): WizardStore {
  const ctx = useContext(WizardCtx);
  if (!ctx) throw new Error('useWizard must be used within <WizardProvider>');
  return ctx;
}
