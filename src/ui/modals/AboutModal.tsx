// About CaseForge — a short account of how the tool evolved + links to the repo and the detailed
// sizing methodology (formulas + the sources they were derived from). Opened from the header.

import { useErrors } from '../ErrorContext';
import { Modal } from './Modal';
import { APP_VERSION } from '../../version';

const REPO_URL = 'https://github.com/rhoulihan/caseforge';
const METHODOLOGY_URL = `${REPO_URL}/blob/main/docs/SIZING-METHODOLOGY.md`;

export function AboutModal() {
  const { aboutOpen, closeAbout } = useErrors();
  if (!aboutOpen) return null;
  return (
    <Modal title="About CaseForge" onClose={closeAbout}>
      <p>
        CaseForge began as a hand-run engagement — sizing a customer’s MongoDB estate for migration to Oracle Autonomous Database, then writing the proposal and
        five-year business case by hand. That expert workflow (make sense of a pile of raw artifacts → surface what’s missing → size it → generate the
        deliverables) was turned into this self-service tool for the field.
      </p>
      <p>
        The sizing and TCO math runs entirely in code, so the numbers are deterministic and reproducible. The AI only researches current list prices, reads chart
        images, and writes the prose — it never invents a number. Customer documents are parsed in your browser and anonymized before any AI call.
      </p>
      <p>
        <b>How the numbers are calculated — and where they came from:</b>{' '}
        <a href={METHODOLOGY_URL} target="_blank" rel="noopener noreferrer">
          Sizing methodology &amp; sources
        </a>
        .
      </p>
      <p class="cf-hint">
        CaseForge {APP_VERSION} ·{' '}
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          source on GitHub
        </a>{' '}
        · MIT licensed.
      </p>
    </Modal>
  );
}
