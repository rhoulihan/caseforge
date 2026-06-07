// The app shell: header / main / footer chrome in the Oracle house style. The app opens on a HOME
// screen listing saved business cases; choosing "New" or opening a case mounts the multi-step wizard
// inside <main> (wrapped in an ErrorBoundary). The error-report / help / about modals render at the
// app root (above everything) so they're available from any screen.

import { useMemo, useState } from 'preact/hooks';
import { WizardProvider } from './WizardContext';
import { ErrorProvider, useErrors } from './ErrorContext';
import { ErrorBoundary } from './ErrorBoundary';
import { Wizard } from './Wizard';
import { HomeScreen } from './HomeScreen';
import { LauncherClient } from '../launcher/client';
import type { WizardState } from './state';
import { ErrorReportDialog } from './modals/ErrorReportDialog';
import { HelpModal } from './modals/HelpModal';
import { AboutModal } from './modals/AboutModal';

function HeaderActions() {
  const { openHelp, openAbout } = useErrors();
  return (
    <div class="cf-header-actions">
      <button type="button" class="cf-iconbtn" onClick={openAbout}>
        About
      </button>
      <button type="button" class="cf-iconbtn" aria-label="Help and FAQ" title="Help and FAQ" onClick={openHelp}>
        ?
      </button>
    </div>
  );
}

type View = { mode: 'home' } | { mode: 'wizard'; initial?: Partial<WizardState>; key: number };

export function App() {
  const client = useMemo(() => new LauncherClient(), []);
  const [view, setView] = useState<View>({ mode: 'home' });
  const [entries, setEntries] = useState(0); // forces a fresh WizardProvider per New/Open

  const startNew = (): void => {
    setEntries((n) => n + 1);
    setView({ mode: 'wizard', key: entries + 1 });
  };
  const openCase = (initial: Partial<WizardState>): void => {
    setEntries((n) => n + 1);
    setView({ mode: 'wizard', initial, key: entries + 1 });
  };
  const goHome = (): void => setView({ mode: 'home' });

  return (
    <ErrorProvider>
      <div class="cf-app">
        <header class="cf-header">
          <div class="cf-header-bar" />
          <div class="cf-header-inner">
            <div class="cf-header-titles">
              <h1>CaseForge</h1>
              <p class="cf-tagline">AI-assisted sizing &amp; business-case generator</p>
            </div>
            <div class="cf-header-actions">
              {view.mode === 'wizard' ? (
                <button type="button" class="cf-iconbtn" onClick={goHome}>
                  ← Cases
                </button>
              ) : null}
              <HeaderActions />
            </div>
          </div>
        </header>
        <main class="cf-main">
          {view.mode === 'home' ? (
            <HomeScreen client={client} onNew={startNew} onOpen={openCase} />
          ) : (
            <WizardProvider key={view.key} launcher={client} initial={view.initial}>
              <ErrorBoundary>
                <Wizard />
              </ErrorBoundary>
            </WizardProvider>
          )}
        </main>
        <footer class="cf-footer">Runs locally · BYO API key · real names are anonymized before any AI call</footer>
        <ErrorReportDialog />
        <HelpModal />
        <AboutModal />
      </div>
    </ErrorProvider>
  );
}
