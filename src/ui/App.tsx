// The app shell: header / main / footer chrome in the Oracle house style. The multi-step wizard
// mounts inside <main>; step components (Plans 10h–10k) replace the placeholders as they land.

import { WizardProvider } from './WizardContext';
import { Wizard } from './Wizard';

export function App() {
  return (
    <div class="cf-app">
      <header class="cf-header">
        <div class="cf-header-bar" />
        <div class="cf-header-inner">
          <h1>CaseForge</h1>
          <p class="cf-tagline">AI-assisted sizing &amp; business-case generator</p>
        </div>
      </header>
      <main class="cf-main">
        <WizardProvider>
          <Wizard />
        </WizardProvider>
      </main>
      <footer class="cf-footer">Runs locally · BYO API key · real names are anonymized before any AI call</footer>
    </div>
  );
}
