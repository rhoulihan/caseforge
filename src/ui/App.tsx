// The app shell: header / main / footer chrome in the Oracle house style. The multi-step wizard
// mounts inside <main>, wrapped in an ErrorBoundary; the error-report / help / about modals render
// at the app root (above everything) so they're available from any step.

import { WizardProvider } from './WizardContext';
import { ErrorProvider, useErrors } from './ErrorContext';
import { ErrorBoundary } from './ErrorBoundary';
import { Wizard } from './Wizard';
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

export function App() {
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
            <HeaderActions />
          </div>
        </header>
        <main class="cf-main">
          <WizardProvider>
            <ErrorBoundary>
              <Wizard />
            </ErrorBoundary>
          </WizardProvider>
        </main>
        <footer class="cf-footer">Runs locally · BYO API key · real names are anonymized before any AI call</footer>
        <ErrorReportDialog />
        <HelpModal />
        <AboutModal />
      </div>
    </ErrorProvider>
  );
}
